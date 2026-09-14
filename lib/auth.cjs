const { createHash, randomBytes, randomUUID } = require("node:crypto");
const error = (status, code, message) =>
  Object.assign(new Error(message), { status, code });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const email = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();
const safeProfile = (profile) =>
  profile
    ? Object.fromEntries(
        [
          "id",
          "uid",
          "email",
          "name",
          "role",
          "storeIds",
          "legacyProfileId",
          "salesmanInfo",
          "active",
          "createdAt",
          "version",
        ]
          .filter((k) => profile[k] !== undefined)
          .map((k) => [k, profile[k]]),
      )
    : null;
function createAuthService({
  repo,
  ownerEmail,
  verifyIdToken,
  verifyAppCheckToken,
  requireAppCheck = true,
  appId,
  clock = () => Date.now(),
}) {
  const isOwner = (token) =>
    token.email_verified === true &&
    email(token.email) === email(ownerEmail) &&
    token.firebase?.sign_in_provider === "google.com";
  async function authenticate(req) {
    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer "))
      throw error(401, "sign_in_required", "Sign in to continue.");
    let token;
    try {
      token = await verifyIdToken(authorization.slice(7), true);
    } catch {
      throw error(
        401,
        "invalid_session",
        "Your session expired. Sign in again.",
      );
    }
    if (!token.uid || token.firebase?.sign_in_provider === "anonymous")
      throw error(
        401,
        "verified_identity_required",
        "Use your individual account to sign in.",
      );
    if (requireAppCheck) {
      try {
        const checked = await verifyAppCheckToken(
          req.headers["x-firebase-appcheck"] || "",
        );
        if (appId && checked?.appId !== appId) throw new Error("Wrong app");
      } catch {
        throw error(
          401,
          "app_check_failed",
          "App verification failed. Refresh the page and try again.",
        );
      }
    }
    return token;
  }
  async function actor(token) {
    const profile = await repo.get("users", token.uid);
    if (!profile || profile.active !== true)
      throw error(
        403,
        "enrollment_required",
        "Your account needs an invitation from the owner.",
      );
    if (!["master", "salesman", "customer"].includes(profile.role))
      throw error(
        403,
        "invalid_role",
        "This account does not have app access.",
      );
    return {
      ...safeProfile(profile),
      uid: token.uid,
      storeIds: profile.storeIds || [],
    };
  }
  async function bootstrap(token) {
    const existing = await repo.get("users", token.uid);
    if (existing?.active === true) return { me: await actor(token) };
    if (!isOwner(token)) return { enrollmentRequired: true };
    const me = await repo.transaction(async (tx) => {
      const owner = await tx.get("settings", "owner");
      if (owner && owner.uid !== token.uid)
        throw error(
          403,
          "owner_already_enrolled",
          "The owner identity has already been enrolled.",
        );
      const profile = {
        id: token.uid,
        uid: token.uid,
        email: email(token.email),
        name: token.name || "Owner",
        role: "master",
        storeIds: [],
        active: true,
        createdAt: clock(),
        version: 1,
      };
      await tx.set("settings", "owner", {
        id: "owner",
        uid: token.uid,
        email: profile.email,
        createdAt: clock(),
      });
      await tx.set("users", token.uid, profile);
      await tx.set("audit", randomUUID(), {
        type: "owner.enrolled",
        actorId: token.uid,
        createdAt: clock(),
      });
      return profile;
    });
    return { me: safeProfile(me) };
  }
  async function invite(actor, payload) {
    if (actor.role !== "master")
      throw error(
        403,
        "forbidden",
        "Only the owner or an administrator can invite users.",
      );
    const inviteEmail = email(payload.email);
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail) ||
      inviteEmail.length > 254
    )
      throw error(400, "invalid_email", "Enter a valid email address.");
    if (!["master", "salesman", "customer"].includes(payload.role))
      throw error(400, "invalid_role", "Choose a valid role.");
    if (payload.storeIds !== undefined && !Array.isArray(payload.storeIds))
      throw error(400, "invalid_stores", "Choose valid stores.");
    const storeIds = [...new Set(payload.storeIds || [])];
    if (
      storeIds.length > 100 ||
      storeIds.some((id) => typeof id !== "string" || id.includes("/"))
    )
      throw error(400, "invalid_stores", "Choose valid stores.");
    if (payload.role === "customer" && !storeIds.length)
      throw error(
        400,
        "store_required",
        "Customers need at least one assigned store.",
      );
    const token = randomBytes(32).toString("base64url");
    const id = hash(token);
    const expiresAt = clock() + 7 * 86400000;
    await repo.transaction(async (tx) => {
      const versionId = hash(inviteEmail);
      const previousVersion = await tx.get("inviteVersions", versionId);
      const generation = (previousVersion?.generation || 0) + 1;
      for (const storeId of storeIds)
        if (!(await tx.get("stores", storeId)))
          throw error(
            400,
            "unknown_store",
            "An assigned store no longer exists.",
          );
      if (
        payload.legacyProfileId &&
        !(await tx.get("legacyProfiles", payload.legacyProfileId))
      )
        throw error(
          400,
          "unknown_profile",
          "Choose an existing legacy profile.",
        );
      await tx.set("inviteVersions", versionId, {
        id: versionId,
        email: inviteEmail,
        generation,
        updatedAt: clock(),
      });
      await tx.set("invites", id, {
        id,
        email: inviteEmail,
        generation,
        role: payload.role,
        storeIds,
        legacyProfileId: payload.legacyProfileId || null,
        createdBy: actor.uid,
        createdAt: clock(),
        expiresAt,
        usedAt: null,
      });
      await tx.set("audit", randomUUID(), {
        type: "user.invited",
        actorId: actor.uid,
        createdAt: clock(),
        email: inviteEmail,
        role: payload.role,
        storeIds,
      });
    });
    return { token, expiresAt, email: inviteEmail };
  }
  async function accept(token, inviteToken) {
    if (typeof inviteToken !== "string" || inviteToken.length !== 43)
      throw error(400, "invalid_invitation", "This invitation is invalid.");
    if (token.email_verified !== true)
      throw error(
        403,
        "email_unverified",
        "Verify your email address before accepting the invitation.",
      );
    const profile = await repo.transaction(async (tx) => {
      const id = hash(inviteToken);
      const invitation = await tx.get("invites", id);
      if (!invitation)
        throw error(
          404,
          "invitation_not_found",
          "This invitation was not found.",
        );
      const currentVersion = await tx.get(
        "inviteVersions",
        hash(invitation.email),
      );
      if (currentVersion?.generation !== invitation.generation)
        throw error(
          410,
          "invitation_replaced",
          "A newer invitation or access change replaced this link. Ask for a current invitation.",
        );
      if (invitation.usedAt !== null)
        throw error(
          409,
          "invitation_used",
          "This invitation has already been used.",
        );
      if (invitation.expiresAt <= clock())
        throw error(
          410,
          "invitation_expired",
          "This invitation expired. Ask for a new invitation.",
        );
      if (email(token.email) !== invitation.email)
        throw error(
          403,
          "wrong_email",
          "Sign in with the email address this invitation was sent to.",
        );
      const owner = await tx.get("settings", "owner");
      if (owner?.uid === token.uid)
        throw error(
          409,
          "owner_role_protected",
          "The owner account cannot be changed through an invitation.",
        );
      const existing = await tx.get("users", token.uid);
      const legacy = invitation.legacyProfileId
        ? await tx.get("legacyProfiles", invitation.legacyProfileId)
        : null;
      if (legacy?.uid && legacy.uid !== token.uid)
        throw error(
          409,
          "profile_already_claimed",
          "This legacy profile is already linked to another account.",
        );
      const record = {
        id: token.uid,
        uid: token.uid,
        name: token.name || invitation.email,
        email: invitation.email,
        role: invitation.role,
        storeIds: invitation.storeIds,
        legacyProfileId: invitation.legacyProfileId,
        ...(legacy?.salesmanInfo ? { salesmanInfo: legacy.salesmanInfo } : {}),
        active: true,
        createdAt: existing?.createdAt || clock(),
        version: (existing?.version || 0) + 1,
      };
      await tx.set("users", token.uid, record);
      if (legacy)
        await tx.set("legacyProfiles", legacy.id, {
          ...legacy,
          uid: token.uid,
          status: "enrolled",
          enrolledAt: clock(),
        });
      await tx.set("invites", id, {
        ...invitation,
        usedAt: clock(),
        usedBy: token.uid,
      });
      await tx.set("audit", randomUUID(), {
        type: "invitation.accepted",
        actorId: token.uid,
        createdAt: clock(),
        role: record.role,
        storeIds: record.storeIds,
      });
      return record;
    });
    return safeProfile(profile);
  }
  async function updateAccess(actor, uid, payload) {
    if (actor.role !== "master")
      throw error(403, "forbidden", "Administrator access is required.");
    if (typeof uid !== "string" || !uid || uid.includes("/"))
      throw error(400, "invalid_user", "Choose a valid user.");
    return repo.transaction(async (tx) => {
      const previous = await tx.get("users", uid);
      if (!previous)
        throw error(404, "user_not_found", "This user was not found.");
      const owner = await tx.get("settings", "owner");
      if (owner?.uid === uid || email(previous.email) === email(ownerEmail))
        throw error(
          403,
          "owner_role_protected",
          "The configured owner account cannot be disabled or reassigned.",
        );
      if (payload.expectedVersion !== (previous.version || 1))
        throw error(
          409,
          "version_conflict",
          "This account changed. Refresh before saving.",
        );
      const role = payload.role ?? previous.role;
      const active = payload.active ?? previous.active;
      if (
        !["master", "salesman", "customer"].includes(role) ||
        typeof active !== "boolean" ||
        !Array.isArray(payload.storeIds ?? previous.storeIds ?? [])
      )
        throw error(
          400,
          "invalid_access",
          "Choose a valid role and store access.",
        );
      const storeIds = [
        ...new Set(payload.storeIds ?? previous.storeIds ?? []),
      ];
      if (
        storeIds.length > 100 ||
        storeIds.some((id) => typeof id !== "string" || !id || id.includes("/"))
      )
        throw error(400, "invalid_stores", "Choose valid stores.");
      if (role === "customer" && active && !storeIds.length)
        throw error(
          400,
          "store_required",
          "Active customers need an assigned store.",
        );
      for (const storeId of storeIds)
        if (!(await tx.get("stores", storeId)))
          throw error(
            400,
            "unknown_store",
            "An assigned store no longer exists.",
          );
      const versionId = hash(email(previous.email));
      const invitationVersion = await tx.get("inviteVersions", versionId);
      const result = {
        ...previous,
        role,
        active,
        storeIds,
        version: (previous.version || 1) + 1,
        updatedAt: clock(),
        updatedBy: actor.uid,
      };
      await tx.set("users", uid, result);
      await tx.set("inviteVersions", versionId, {
        id: versionId,
        email: email(previous.email),
        generation: (invitationVersion?.generation || 0) + 1,
        updatedAt: clock(),
      });
      await tx.set("audit", randomUUID(), {
        type: "user.access_changed",
        actorId: actor.uid,
        userId: uid,
        createdAt: clock(),
        before: {
          role: previous.role,
          active: previous.active,
          storeIds: previous.storeIds || [],
        },
        after: { role, active, storeIds },
      });
      return safeProfile(result);
    });
  }
  return {
    authenticate,
    actor,
    bootstrap,
    invite,
    accept,
    isOwner,
    updateAccess,
  };
}
module.exports = { createAuthService, safeProfile };
