'use strict';

const commands = [
  'credit.request', 'credit.approve', 'credit.cancel', 'credit.reject',
  'return.cancel', 'return.reject', 'return.pickup', 'return.receive',
];

function authorize(actor, type, payload, h) {
  h.validateActor(actor);
  h.object(payload, 'Payload');
  if (!commands.includes(type)) h.fail('INVALID_COMMAND', 'This credit command is not supported.');
  if (type === 'credit.approve') h.requireMaster(actor);
  if (['credit.reject', 'return.reject', 'return.pickup', 'return.receive'].includes(type)) h.requireStaff(actor);
  h.authorizeStore(actor, h.recordId(payload.storeId, 'Store ID'));
}

function sameStore(actor, record, storeId, h) {
  h.authorizeStore(actor, record.storeId);
  if (record.storeId !== storeId) h.fail('FORBIDDEN', 'The record belongs to a different store.', 403);
  return record;
}

function verifiedInvoice(order) {
  return order && order.status === 'delivered' && !!order.invoiceNumber && !order.legacy?.needsPriceReview &&
    ['subtotalCents', 'taxCents', 'totalCents'].every(key => Number.isSafeInteger(order[key]) && order[key] >= 0) &&
    order.subtotalCents + order.taxCents === order.totalCents;
}

const lineKey = (id, variant = '') => JSON.stringify([id, variant]);
const activeClaim = record => !record.deleted && ['pending', 'approved'].includes(record.status) && record.kind !== 'unverified';

function originalsFor(order, h) {
  const lines = h.returnableLines ? h.returnableLines(order) : order.lines;
  if (!Array.isArray(lines) || !lines.length) h.fail('RECONCILIATION_REQUIRED', 'The original invoice needs line reconciliation.', 409);
  const keys = new Set();
  return lines.map(line => {
    const id = h.recordId(line.id, 'Original line ID');
    const variant = h.text(line.variant, 'Original variant', 200);
    const key = lineKey(id, variant);
    if (keys.has(key)) h.fail('RECONCILIATION_REQUIRED', 'The original invoice has ambiguous lines.', 409);
    keys.add(key);
    return {...line, id, variant, subtotalCents: h.money(line.lineTotalCents ?? line.subtotalCents, 'Original line subtotal'), taxCents: h.money(line.taxCents, 'Original line tax')};
  });
}

function originalFor(lines, input, h) {
  const id = h.recordId(input.lineId, 'Original line ID');
  const candidates = lines.filter(line => line.id === id && (input.variant === undefined || line.variant === h.text(input.variant, 'Variant', 200)));
  if (candidates.length !== 1) h.fail('INVALID_INPUT', 'Choose a specific original invoice line and delivered flavor.');
  return candidates[0];
}

async function claimsFor(tx, order, excludeId) {
  return (await tx.list('returns', {where: [['orderId', '==', order.id]]}))
    .filter(record => record.orderId === order.id && record.id !== excludeId && activeClaim(record));
}

function budgetFrom(order, originals, claims, h) {
  const available = new Map(originals.map(line => [lineKey(line.id, line.variant), {...line, remainingSubtotalCents: line.subtotalCents, remainingTaxCents: line.taxCents}]));
  let subtotal = 0, tax = 0;
  for (const record of claims) {
    if (record.storeId !== order.storeId) h.fail('INVOICE_CREDIT_CONFLICT', 'This invoice has inconsistent credit ownership.', 409);
    const recordSubtotal = h.money(record.subtotalCents, 'Claim subtotal');
    const recordTax = h.money(record.taxCents, 'Claim tax');
    if (h.money(record.totalCents, 'Claim total') !== recordSubtotal + recordTax) h.fail('INVOICE_CREDIT_CONFLICT', 'This invoice has inconsistent credit amounts.', 409);
    if (!Array.isArray(record.lines) || !record.lines.length) h.fail('RECONCILIATION_REQUIRED', 'An existing credit needs original line reconciliation.', 409);
    let lineSubtotal = 0, lineTax = 0;
    for (const line of record.lines) {
      const original = originalFor(originals, line, h);
      const remaining = available.get(lineKey(original.id, original.variant));
      const amount = h.money(line.subtotalCents, 'Claim line subtotal');
      const taxAmount = h.money(line.taxCents, 'Claim line tax');
      remaining.remainingSubtotalCents -= amount;
      remaining.remainingTaxCents -= taxAmount;
      if (remaining.remainingSubtotalCents < 0 || remaining.remainingTaxCents < 0) h.fail('CREDIT_LIMIT', 'Requested credits exceed the original line subtotal or tax.', 409);
      lineSubtotal = h.money(lineSubtotal + amount, 'Claim line subtotals');
      lineTax = h.money(lineTax + taxAmount, 'Claim line taxes');
    }
    if (lineSubtotal !== recordSubtotal || lineTax !== recordTax) h.fail('INVOICE_CREDIT_CONFLICT', 'Credit lines must match the credit subtotal and tax.', 409);
    subtotal = h.money(subtotal + recordSubtotal, 'Invoice claims');
    tax = h.money(tax + recordTax, 'Invoice claimed tax');
  }
  if (subtotal > h.money(order.subtotalCents, 'Original subtotal') || tax > h.money(order.taxCents, 'Original tax')) h.fail('CREDIT_LIMIT', 'Requested credits exceed the original invoice subtotal or tax.', 409);
  return available;
}

// Called by the original return.create and return.approve paths as well as adjustments.
// Transactions serialize both kinds of claims against one frozen invoice budget.
async function assertCreditBudget(tx, order, newRecord, excludeId = null, h = require('./domain.cjs').helpers) {
  const existing = await claimsFor(tx, order, excludeId ?? newRecord?.id);
  if (newRecord && activeClaim(newRecord)) existing.push(newRecord);
  budgetFrom(order, originalsFor(order, h), existing, h);
}

function adjustmentLine(original, subtotalCents, taxCents) {
  return {lineId: original.id, productId: original.productId, variant: original.variant, name: original.name || '', sku: original.sku || '',
    unit: original.unit, packSize: original.packSize ?? null, quantity: 0, eachQuantity: 0,
    unitPriceCents: original.unitPriceCents, subtotalCents, taxCents, totalCents: subtotalCents + taxCents};
}

async function adjustmentAmounts(tx, order, input, excludeId, h) {
  const originals = originalsFor(order, h);
  const available = budgetFrom(order, originals, await claimsFor(tx, order, excludeId), h);
  let lines;
  if (input.lines !== undefined) {
    if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 2000) h.fail('INVALID_INPUT', 'Specify original invoice credit lines.');
    const seen = new Set();
    lines = input.lines.map(raw => {
      h.object(raw, 'Credit line');
      const original = originalFor(originals, raw, h), key = lineKey(original.id, original.variant);
      if (seen.has(key)) h.fail('INVALID_INPUT', 'Each original invoice line may appear only once.');
      seen.add(key);
      return adjustmentLine(original, h.money(raw.subtotalCents, 'Credit subtotal'), h.money(raw.taxCents ?? 0, 'Credit tax'));
    });
  } else {
    let subtotalRemaining = h.money(input.subtotalCents, 'Credit subtotal');
    let taxRemaining = h.money(input.taxCents ?? 0, 'Credit tax');
    lines = [];
    for (const remaining of available.values()) {
      const subtotalCents = Math.min(subtotalRemaining, remaining.remainingSubtotalCents);
      const taxCents = Math.min(taxRemaining, remaining.remainingTaxCents);
      if (subtotalCents || taxCents) lines.push(adjustmentLine(remaining, subtotalCents, taxCents));
      subtotalRemaining -= subtotalCents;
      taxRemaining -= taxCents;
    }
    if (subtotalRemaining || taxRemaining) h.fail('CREDIT_LIMIT', 'Requested credits exceed the remaining original subtotal or tax.', 409);
  }
  const subtotalCents = h.money(lines.reduce((sum, line) => sum + line.subtotalCents, 0), 'Credit subtotal');
  const taxCents = h.money(lines.reduce((sum, line) => sum + line.taxCents, 0), 'Credit tax');
  if (input.lines && ((input.subtotalCents !== undefined && h.money(input.subtotalCents) !== subtotalCents) || (input.taxCents !== undefined && h.money(input.taxCents) !== taxCents))) h.fail('INVALID_INPUT', 'Credit totals must match the requested original lines.');
  return {lines, subtotalCents, taxCents, totalCents: h.money(subtotalCents + taxCents, 'Credit amount', {min: 1})};
}

function unverifiedLines(input, h) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 2000) h.fail('INVALID_INPUT', 'Specify credit request items.');
  return input.map((raw, index) => {
    h.object(raw, 'Unverified item');
    const unit = raw.unit ?? 'each';
    if (!['each', 'case'].includes(unit)) h.fail('INVALID_INPUT', 'Unit must be each or case.');
    const packSize = raw.packSize == null ? null : h.integer(raw.packSize, 'Pack size', {min: 1, max: h.QUANTITY_LIMIT});
    const quantity = h.integer(raw.quantity, 'Requested quantity', {min: 1, max: h.QUANTITY_LIMIT});
    return {lineId: raw.lineId ? h.recordId(raw.lineId, 'Line ID') : 'unverified-' + (index + 1),
      productId: raw.productId ? h.recordId(raw.productId, 'Product ID') : null,
      name: h.text(raw.name || raw.productId, 'Product description', 300, true), variant: h.text(raw.variant, 'Variant', 200),
      quantity, unit, packSize, eachQuantity: unit === 'each' ? quantity : packSize === null ? null : h.integer(quantity * packSize, 'Individual quantity', {min: 1, max: 1_000_000_000})};
  });
}

function seedPhysical(record, h) {
  const legacyRestocked = record.status === 'approved' && record.restock === true && !record.physical;
  const previous = record.physical?.lines || [];
  const lines = record.lines.map(line => {
    const quantity = h.integer(line.quantity, 'Return quantity', {min: 1, max: h.QUANTITY_LIMIT});
    const saved = previous.find(item => item.lineId === line.lineId && item.variant === (line.variant || ''));
    const result = {lineId: line.lineId, variant: line.variant || '', quantity,
      pickedQuantity: saved?.pickedQuantity ?? (legacyRestocked ? quantity : 0),
      receivedQuantity: saved?.receivedQuantity ?? (legacyRestocked ? quantity : 0),
      resalableQuantity: saved?.resalableQuantity ?? (legacyRestocked ? quantity : 0),
      nonresalableQuantity: saved?.nonresalableQuantity ?? 0};
    for (const key of ['pickedQuantity', 'receivedQuantity', 'resalableQuantity', 'nonresalableQuantity']) h.integer(result[key], 'Saved physical quantity', {max: quantity});
    if (result.receivedQuantity > result.pickedQuantity || result.resalableQuantity + result.nonresalableQuantity !== result.receivedQuantity) h.fail('INVALID_INPUT', 'Saved physical return counts require reconciliation.');
    return result;
  });
  return {lines, legacyRestocked: record.physical?.legacyRestocked ?? legacyRestocked};
}

function physicalStatus(physical) {
  if (physical.lines.every(line => line.receivedQuantity === line.quantity)) return 'inspected';
  if (physical.lines.some(line => line.receivedQuantity > 0)) return 'received';
  if (physical.lines.some(line => line.pickedQuantity > 0)) return 'picked_up';
  return 'awaiting_pickup';
}

async function moveReturn(tx, actor, command, context, h, previous) {
  const {payload, type} = command;
  if (!['pending', 'approved'].includes(previous.status) || previous.kind === 'adjustment' || previous.kind === 'unverified') h.fail('INVALID_TRANSITION', 'Physical collection requires an active verified goods return.', 409);
  h.versionGuard(previous, payload.expectedVersion);
  const order = sameStore(actor, await h.required(tx, 'orders', previous.orderId, 'Original order'), previous.storeId, h);
  if (!verifiedInvoice(order)) h.fail('RECONCILIATION_REQUIRED', 'Physical returns require a confirmed delivered original invoice.', 409);
  if (!Array.isArray(payload.lines) || !payload.lines.length || payload.lines.length > 2000) h.fail('INVALID_INPUT', 'Choose return quantities for this physical event.');
  const physical = seedPhysical(previous, h), receiving = type === 'return.receive', seen = new Set();
  const note = h.text(payload.note, 'Physical event note', 2000);
  const eventLines = payload.lines.map(raw => {
    h.object(raw, 'Physical return line');
    const lineId = h.recordId(raw.lineId, 'Return line ID');
    const matches = previous.lines.filter(line => line.lineId === lineId && (raw.variant === undefined || (line.variant || '') === h.text(raw.variant, 'Variant', 200)));
    if (matches.length !== 1) h.fail('INVALID_INPUT', 'Choose a specific returned line and flavor.');
    const original = matches[0], key = lineKey(lineId, original.variant || '');
    if (seen.has(key)) h.fail('INVALID_INPUT', 'Each returned line may appear only once per physical event.');
    seen.add(key);
    const state = physical.lines.find(line => lineKey(line.lineId, line.variant) === key);
    const quantity = h.integer(raw.quantity, 'Physical quantity', {min: 1, max: h.QUANTITY_LIMIT});
    const remaining = receiving ? state.pickedQuantity - state.receivedQuantity : state.quantity - state.pickedQuantity;
    if (quantity > remaining) h.fail('RETURN_QUANTITY', receiving ? 'Received quantities cannot exceed goods already collected.' : 'Pickup quantities cannot exceed remaining returned goods.', 409);
    const disposition = receiving ? h.text(raw.disposition, 'Disposition', 30, true) : null;
    if (receiving && !['resalable', 'nonresalable'].includes(disposition)) h.fail('INVALID_INPUT', 'Mark received goods resalable or nonresalable.');
    const multiplier = original.unit === 'case' ? h.integer(original.packSize, 'Original pack size', {min: 1, max: h.QUANTITY_LIMIT}) : 1;
    const eachQuantity = h.integer(quantity * multiplier, 'Physical individual quantity', {min: 1, max: 1_000_000_000});
    if (receiving) {
      state.receivedQuantity += quantity;
      state[disposition === 'resalable' ? 'resalableQuantity' : 'nonresalableQuantity'] += quantity;
    } else state.pickedQuantity += quantity;
    return {lineId, variant: original.variant || '', productId: h.recordId(original.productId, 'Product ID'), quantity, eachQuantity, disposition};
  });
  const warnings = [...(previous.restockWarnings || [])];
  const eventId = 'return-event-' + h.hash(actor.uid + '\n' + command.id);
  for (const line of eventLines) {
    const movementId = eventId + '-' + h.hash(lineKey(line.lineId, line.variant)).slice(0, 24);
    if (receiving) {
      let appliedToInventory = false;
      if (line.disposition === 'resalable') {
        const key = h.inventoryId(line.productId, line.variant), stock = await tx.get('inventory', key);
        if (!stock || stock.onHand == null) warnings.push({productId: line.productId, variant: line.variant, code: 'RESTOCK_UNKNOWN_BASELINE', quantity: line.eachQuantity, eventId});
        else {
          const values = h.inventoryValues(stock);
          await tx.set('inventory', key, h.versioned(stock, {...values, onHand: h.integer(values.onHand + line.eachQuantity, 'Stock on hand', {max: 1_000_000_000})}, context.now, actor));
          appliedToInventory = true;
        }
      }
      await tx.set('warehouseMovements', movementId, {id: movementId, storeId: previous.storeId, productId: line.productId, variant: line.variant,
        kind: 'return-receipt', quantityEach: line.disposition === 'resalable' ? line.eachQuantity : 0, receivedQuantityEach: line.eachQuantity,
        disposition: line.disposition, appliedToInventory, sourceType: 'return-receive', sourceId: previous.id, returnId: previous.id, orderId: previous.orderId,
        eventId, effectiveAt: context.now, recordedAt: context.now, createdBy: actor.uid, reason: note || previous.reason, version: 1});
    } else {
      await tx.set('storeInventoryMovements', movementId, {id: movementId, storeId: previous.storeId, productId: line.productId, variant: line.variant,
        kind: 'return-out', quantityEach: -line.eachQuantity, unit: 'each', quantity: line.eachQuantity, packSize: null,
        sourceType: 'return-pickup', sourceId: previous.id, returnId: previous.id, orderId: previous.orderId, eventId,
        effectiveAt: context.now, recordedAt: context.now, createdBy: actor.uid, reason: note || previous.reason, version: 1});
    }
  }
  const result = h.versioned(previous, {physical, physicalStatus: physicalStatus(physical), restockWarnings: warnings}, context.now, actor);
  await tx.set('returns', previous.id, result);
  await tx.set('returnEvents', eventId, {id: eventId, returnId: previous.id, storeId: previous.storeId, orderId: previous.orderId,
    type, lines: eventLines, note, createdAt: context.now, createdBy: actor.uid, version: 1});
  return result;
}

async function execute(tx, actor, command, context, h) {
  const payload = h.object(command.payload ?? {}, 'Payload');
  authorize(actor, command.type, payload, h);
  const storeId = payload.storeId;
  if (command.type === 'credit.request') {
    await h.required(tx, 'stores', storeId, 'Store');
    const reason = h.text(payload.reason, 'Credit reason', 2000, true);
    const order = payload.orderId ? sameStore(actor, await h.required(tx, 'orders', payload.orderId, 'Order'), storeId, h) : null;
    const placement = payload.placementId ? sameStore(actor, await h.required(tx, 'orderPlacements', payload.placementId, 'Placement'), storeId, h) : null;
    const verified = verifiedInvoice(order);
    const amounts = verified ? await adjustmentAmounts(tx, order, payload, null, h) : {lines: unverifiedLines(payload.lines, h), subtotalCents: 0, taxCents: 0, totalCents: 0};
    const requestedSubtotalCents = payload.subtotalCents == null ? null : h.money(payload.subtotalCents, 'Requested subtotal');
    const requestedTaxCents = payload.taxCents == null ? null : h.money(payload.taxCents, 'Requested tax');
    if (!verified && !amounts.lines.length && requestedSubtotalCents === null && requestedTaxCents === null) h.fail('INVALID_INPUT', 'Describe requested items or enter a documented requested amount.');
    const id = context.id();
    const result = h.versioned(null, {id, storeId, orderId: order?.id || null, placementId: placement?.id || null,
      invoiceNumber: verified ? order.invoiceNumber : null, storeSnapshot: verified ? order.storeSnapshot || null : null,
      kind: verified ? 'adjustment' : 'unverified', originalReference: h.text(payload.originalReference || order?.invoiceNumber || placement?.reference, 'Original order reference', 500),
      reason, ...amounts, requestedSubtotalCents, requestedTaxCents, status: 'pending', needsReconciliation: !verified,
      pickupRequested: false}, context.now, actor);
    if (verified) await assertCreditBudget(tx, order, result, null, h);
    await tx.set('returns', id, result);
    await h.notify(tx, {storeId, type: 'credit.pending', message: verified ? 'A credit adjustment awaits owner approval.' : 'An unverified credit request needs reconciliation.', recordId: id}, context);
    return result;
  }

  const id = payload.creditId ?? payload.returnId;
  const previous = sameStore(actor, await h.required(tx, 'returns', id, 'Return or credit'), storeId, h);
  if (['return.pickup', 'return.receive'].includes(command.type)) return moveReturn(tx, actor, {...command, payload}, context, h, previous);

  if (command.type.endsWith('.cancel') || command.type.endsWith('.reject')) {
    const status = command.type.endsWith('.cancel') ? 'cancelled' : 'rejected';
    if (actor.role === 'customer' && previous.createdBy !== actor.uid) h.fail('FORBIDDEN', 'Only the requester or staff can cancel this request.', 403);
    if (previous.status === status) return previous;
    if (previous.status !== 'pending') h.fail('INVALID_TRANSITION', 'Only pending requests can be cancelled or rejected.', 409);
    h.versionGuard(previous, payload.expectedVersion);
    if (previous.physical?.lines?.some(line => line.pickedQuantity > 0)) h.fail('INVALID_TRANSITION', 'Collected goods require staff reconciliation before cancelling the request.', 409);
    const result = h.versioned(previous, {status, resolutionReason: h.text(payload.reason, 'Resolution reason', 2000, true), resolvedAt: context.now, resolvedBy: actor.uid}, context.now, actor);
    await tx.set('returns', previous.id, result);
    return result;
  }

  if (!['adjustment', 'unverified'].includes(previous.kind)) h.fail('INVALID_TRANSITION', 'Use return approval for a physical goods return.', 409);
  if (previous.status === 'approved') {
    if ((payload.orderId !== undefined && payload.orderId !== previous.orderId) ||
        (payload.subtotalCents !== undefined && payload.subtotalCents !== previous.subtotalCents) ||
        (payload.taxCents !== undefined && payload.taxCents !== previous.taxCents) ||
        (payload.lines !== undefined && h.stableJson(payload.lines.map(line => ({lineId: line.lineId, variant: line.variant || '', subtotalCents: line.subtotalCents, taxCents: line.taxCents ?? 0}))) !== h.stableJson(previous.lines.map(line => ({lineId: line.lineId, variant: line.variant || '', subtotalCents: line.subtotalCents, taxCents: line.taxCents}))))) {
      h.fail('COMMAND_CONFLICT', 'This adjustment was already approved with different financial details.', 409);
    }
    return previous;
  }
  if (previous.status !== 'pending') h.fail('INVALID_TRANSITION', 'Only a pending adjustment can be approved.', 409);
  h.versionGuard(previous, payload.expectedVersion);
  const store = await h.required(tx, 'stores', storeId, 'Store');
  h.financialAccess(store);
  const orderId = payload.orderId || previous.orderId;
  if (!orderId) h.fail('RECONCILIATION_REQUIRED', 'Reconcile this request to a confirmed original invoice first.', 409);
  const order = sameStore(actor, await h.required(tx, 'orders', orderId, 'Order'), storeId, h);
  if (!verifiedInvoice(order)) h.fail('RECONCILIATION_REQUIRED', 'Credit approval requires a delivered original invoice with confirmed prices.', 409);
  if (previous.kind === 'adjustment' && order.id !== previous.orderId) h.fail('COMMAND_CONFLICT', 'An existing adjustment cannot move to another invoice.', 409);
  const changingAmounts = payload.lines !== undefined || payload.subtotalCents !== undefined || payload.taxCents !== undefined;
  if (previous.kind === 'unverified' && !changingAmounts) h.fail('RECONCILIATION_REQUIRED', 'Document the verified subtotal and tax for this request.', 409);
  const amounts = changingAmounts ? await adjustmentAmounts(tx, order, payload, previous.id, h) : {lines: previous.lines, subtotalCents: previous.subtotalCents, taxCents: previous.taxCents, totalCents: previous.totalCents};
  const result = h.versioned(previous, {...amounts, kind: 'adjustment', orderId: order.id, invoiceNumber: order.invoiceNumber, storeSnapshot: order.storeSnapshot || null,
    status: 'approved', needsReconciliation: false, approvedAt: context.now, approvedBy: actor.uid,
    ...(previous.kind === 'unverified' ? {reconciledFromKind: 'unverified',
      unverifiedRequest: {lines: previous.lines, originalReference: previous.originalReference, orderId: previous.orderId, placementId: previous.placementId,
        requestedSubtotalCents: previous.requestedSubtotalCents, requestedTaxCents: previous.requestedTaxCents, reason: previous.reason, createdAt: previous.createdAt, createdBy: previous.createdBy},
      reconciliationReason: h.text(payload.reconciliationReason || previous.reason, 'Reconciliation reason', 2000, true)} : {}),
    creditMemoNumber: `CM-${order.invoiceNumber}-${previous.id}`}, context.now, actor);
  await assertCreditBudget(tx, order, result, previous.id, h);
  await h.postLedger(tx, {id: 'return-' + previous.id, storeId, type: 'credit', deltaCents: -h.money(result.totalCents, 'Credit amount', {min: 1}), referenceId: previous.id, note: `Adjustment for ${order.invoiceNumber}`}, context);
  await tx.set('returns', previous.id, result);
  await h.refreshInvoiceAmounts(tx, order, context);
  await h.notify(tx, {storeId, type: 'credit.approved', message: 'Your approved adjustment was credited to your account.', recordId: previous.id}, context);
  return result;
}

module.exports = {commands, authorize, execute, assertCreditBudget, seedPhysical};
