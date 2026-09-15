# Confirmed-order email implementation plan

> Execution is delegated to the backend agent in the existing isolated worktree. The user authorized implementation and release, confirmed the recipient, and assigned sender account setup to the root agent.

**Goal:** Send one PDF invoice to alwholesaleorders@gmail.com immediately after submission or at a cloud-persisted future time.

**Architecture:** Dedicated orderMailJobs records belong to canonical submitted orders; queueing a newly submitted invoice shares its command transaction. A secret-authenticated scheduled worker claims due jobs transactionally, revalidates current access, generates the existing invoice PDF and records SMTP acceptance. Uncertain outcomes stop for explicit administrator review instead of automatic retries. Credentials remain server-side.

**Tech stack:** Express, existing repository transaction abstraction, Firestore, nodemailer TLS transport, existing PDFKit invoice renderer, node:test.

## Backend contract

- GET /api/order-email/config returns configured, recipient, automatic and settings version.
- GET /api/orders/:id/email returns the accessible order's job and config.
- POST /api/orders/:id/email accepts requestId, action (send/schedule/cancel/retry), expectedVersion and optional scheduledAt or acknowledgeDuplicateRisk. The fixed recipient and sender cannot be overridden.
- POST /api/admin/order-email/settings allows a master to update automatic with expectedVersion.
- POST /internal/order-email/run requires ORDER_MAIL_WORKER_TOKEN; it never accepts user-specified targets or sender details.
- A customer may manage only an order they created and their own queued job. Authorized staff may manage accessible store jobs. Dispatch rechecks the original requesting user's current access and the canonical order.
- One job per order prevents duplicate requests from creating multiple emails. Mutation receipts make lost-response retries idempotent. Sent jobs cannot be silently resent. A master can explicitly retry uncertain outcomes only with duplicate-risk acknowledgment.

## Execution and verification

1. Write failing tests in tests/order-mail.test.cjs covering idempotency, authorization, scheduling, settings, lease concurrency, PDF attachment, safe rejection and uncertain outcomes. Verify failure before creating lib/order-mail.cjs.
2. Implement focused queue/control/dispatch functions, sharing the existing tested SMTP classification helpers. Include a short second access check after PDF preparation and before claiming the actual SMTP send.
3. Add failing HTTP integration tests in tests/order-mail-api.test.cjs, then mount focused lib/order-mail-routes.cjs from server.js. Queue automatic jobs inside the successful command transaction, before the receipt response, without sending email in that request.
4. Add due-job Firestore indexes, include jobs in private backups and run focused plus full tests, syntax/build and diff checks. Synthetic SMTP only. Root configures sender secrets and the authenticated cloud schedule separately.

## Practical delivery semantics

“Sent” means the provider accepted the message, not that the destination inbox has been independently inspected. A terminated SMTP attempt, timeout or lost acknowledgement becomes uncertain. No automatic retry crosses that uncertainty boundary. Losing sender configuration leaves already queued jobs visible and unchanged. New sends and schedules are rejected while the sender is disconnected. Previously submitted orders are not backfilled automatically. Automatic email defaults off and cannot be enabled before sender configuration; unconfigured submissions create no automatic jobs. Once enabled, automatic jobs wait five minutes, allowing Send now, reschedule or cancel before dispatch.

Worker batches select at most 20 due or expired jobs with three concurrent leases. No new work starts after 135 seconds of elapsed processing; in-flight PDF preparation (45 seconds) and SMTP (30 seconds default) finish before returning. Normal fast batches can process 20 invoices per invocation, while unstarted jobs remain cloud-persisted for the next scheduled invocation. Cloud database RPC overhead is additional. Explicit new send/schedule/retry requests are rejected while sender configuration is absent; cancellation remains available.

Scheduled timestamps are earliest send times. Scheduler cadence, a backlog, provider throttling, and cloud startup can delay actual submission to the provider. With a one-minute scheduler and normal fast delivery, a 100-invoice burst needs at least five worker invocations at the 20-job batch limit; slow or rejected provider responses lower throughput. Provider acceptance never claims verified inbox delivery.
