const MAX_CENTS = 1_000_000_000_000;

export function creditCents(value, label = 'Amount') {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label}: enter a decimal amount with at most two decimal places.`);
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) throw new Error(`${label}: amount is too large.`);
  return cents;
}

const requestedAmount = record => record.kind === 'unverified'
  ? (record.requestedSubtotalCents == null && record.requestedTaxCents == null ? null : (record.requestedSubtotalCents || 0) + (record.requestedTaxCents || 0))
  : record.totalCents;

export function creditSummary(records, storeId) {
  const result = {requestedCents: 0, approvedCents: 0, unverifiedCount: 0};
  for (const record of records.filter(row => row.storeId === storeId && !row.deleted)) {
    if (record.status === 'pending') {
      result.requestedCents += requestedAmount(record) || 0;
      if (record.kind === 'unverified') result.unverifiedCount++;
    } else if (record.status === 'approved') result.approvedCents += record.totalCents || 0;
  }
  return result;
}

export function physicalReturnLines(record) {
  if (['adjustment', 'unverified'].includes(record.kind)) return [];
  const legacyRestocked = record.status === 'approved' && record.restock === true && !record.physical;
  return (record.lines || []).filter(line => line.quantity > 0).map(line => {
    const state = record.physical?.lines?.find(row => row.lineId === line.lineId && (row.variant || '') === (line.variant || ''));
    const pickedQuantity = state?.pickedQuantity ?? (legacyRestocked ? line.quantity : 0);
    const receivedQuantity = state?.receivedQuantity ?? (legacyRestocked ? line.quantity : 0);
    return {...line, pickedQuantity, receivedQuantity,
      remainingPickup: Math.max(0, line.quantity - pickedQuantity),
      remainingReceipt: Math.max(0, pickedQuantity - receivedQuantity)};
  });
}

export function createOrderCredits(ctx) {
  const {el, input, select, button, field, modal, notice, table, td, cash, toast, command, api} = ctx;
  const storeRecords = storeId => (ctx.getReturns() || []).filter(record => record.storeId === storeId && !record.deleted);
  const reference = record => record.invoiceNumber || record.originalReference || 'Unverified original sale';
  const kindLabel = record => record.kind === 'adjustment' ? 'Credit adjustment' : record.kind === 'unverified' ? 'Unverified credit request' : 'Goods return';
  const centsInput = (value = '') => input('text', value, {inputmode: 'decimal', placeholder: '0.00', maxlength: 16});

  function capture(withDraft = false) {
    const scope = ctx.scope?.(), storeId = ctx.getStore()?.id, draftId = ctx.getDraft()?.id, actorId = ctx.getActor()?.uid;
    if (!storeId) throw new Error('Select a store first.');
    return {storeId, check() {
      if ((ctx.isCurrent && !ctx.isCurrent(scope)) || ctx.getStore()?.id !== storeId || ctx.getActor()?.uid !== actorId || (withDraft && ctx.getDraft()?.id !== draftId)) throw new Error('The account, store or draft changed. Reopen Credits & returns.');
    }};
  }

  function attach(record, captured) {
    captured.check();
    if (record.storeId !== captured.storeId) throw new Error('This request belongs to another store.');
    ctx.editDraft(draft => {draft.creditRequestIds = [...new Set([...(draft.creditRequestIds || []), record.id])];});
  }

  function renderBuilderSection() {
    const store = ctx.getStore(), root = el('details', {class: 'panel credits-returns'});
    root.append(el('summary', {}, 'Credits & returns'));
    if (!store) {root.append(notice('Select a store to view its requests.')); return root;}
    const captured = capture(true), records = storeRecords(store.id), summary = creditSummary(records, store.id);
    root.append(el('div', {class: 'form-grid mt'},
      el('div', {}, el('strong', {}, 'Requested credit'), el('p', {}, cash(summary.requestedCents))),
      el('div', {}, el('strong', {}, 'Approved account credit issued'), el('p', {}, cash(summary.approvedCents)))));
    root.append(el('p', {class: 'small'}, 'The new order total stays separate. Pending requests do not reduce the balance. Approved credits are already on the account and are not deducted again.'));
    if (summary.unverifiedCount) root.append(notice(`${summary.unverifiedCount} request${summary.unverifiedCount === 1 ? '' : 's'} need original-sale reconciliation before approval.`));
    root.append(button('Request return/credit', () => showRequest(), 'primary'));
    const attached = new Set(ctx.getDraft()?.creditRequestIds || []);
    const visible = records.filter(record => ['pending', 'approved'].includes(record.status) || attached.has(record.id));
    if (!visible.length) root.append(el('p', {class: 'small mt'}, 'No return or credit requests for this store.'));
    else root.append(el('div', {class: 'mt'}, ...visible.map(record => {
      const checkbox = input('checkbox', '', {checked: attached.has(record.id), 'aria-label': `Include ${reference(record)} credit request with this order`});
      checkbox.addEventListener('change', () => {
        captured.check();
        ctx.editDraft(draft => {
          const ids = new Set(draft.creditRequestIds || []);
          if (checkbox.checked) ids.add(record.id); else ids.delete(record.id);
          draft.creditRequestIds = [...ids];
        });
      });
      const amount = record.status === 'approved' ? record.totalCents : requestedAmount(record);
      return el('div', {class: 'split panel'},
        el('label', {class: 'check-field'}, checkbox, el('span', {}, `${kindLabel(record)} · ${reference(record)}`, el('p', {class: 'small'}, `${record.status} · ${amount == null ? 'Amount unverified' : cash(amount)} · ${record.reason || ''}`))),
        button('Details', () => showCreditDetails(record)));
    })));
    return root;
  }

  function invoiceSelector(m, captured, selectedId = '') {
    const control = select([['', 'Choose a delivered invoice']], selectedId, {'aria-label': 'Original delivered invoice'});
    const status = el('p', {class: 'small', role: 'status'}, 'Loading delivered invoices…');
    let cursor = null, loading = false;
    const known = new Map();
    const more = button('Load more invoices', () => load(), ''); more.hidden = true;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        captured.check();
        const query = new URLSearchParams({storeId: captured.storeId, status: 'delivered'});
        if (cursor) query.set('cursor', cursor);
        const response = await api(`/api/orders?${query}`);
        captured.check();
        if (!m.dialog.open) return;
        for (const order of response.orders || response.items || []) {
          if (order.storeId === captured.storeId && order.status === 'delivered') known.set(order.id, order);
        }
        const chosen = control.value || selectedId;
        control.replaceChildren(el('option', {value: ''}, 'Choose a delivered invoice'), ...[...known.values()].map(order => el('option', {value: order.id}, `${order.invoiceNumber || order.id}${order.createdAt && ctx.date ? ' · ' + ctx.date(order.createdAt) : ''}`)));
        control.value = known.has(chosen) ? chosen : '';
        cursor = response.nextCursor || response.pagination?.nextCursor || null;
        more.hidden = !cursor;
        status.textContent = known.size ? 'Select the original sale for this request.' : 'No delivered invoices found. Use an unverified request for a paper or Mail-only sale.';
      } catch (error) {
        if (m.dialog.open) {status.textContent = error.message || 'Invoices could not be loaded.';more.hidden = false;more.textContent = 'Retry loading invoices';}
      } finally {loading = false;}
    }
    return {control, node: el('div', {}, field('Original delivered invoice', control), status, more), load,
      async order() {
        captured.check();
        if (!control.value || !known.has(control.value)) throw new Error('Choose an original delivered invoice.');
        const response = await api(`/api/orders/${encodeURIComponent(control.value)}`);
        captured.check();
        const order = response.order;
        if (!order || order.storeId !== captured.storeId || order.status !== 'delivered') throw new Error('The original invoice is no longer available for this request.');
        return order;
      }};
  }

  async function showRequest() {
    const captured = capture(true), store = ctx.getStore();
    const m = modal('Request return or credit', `${store.name} · Pending requests do not change your balance.`, true);
    const type = select([['return', 'Return goods from a delivered invoice'], ['adjustment', 'Request a price or shortage correction'], ['unverified', 'Unverified paper or Mail-only sale']], 'return');
    const invoices = invoiceSelector(m, captured);
    const referenceInput = input('text', '', {maxlength: 500, placeholder: 'Paper invoice number, Mail order reference or date'});
    const description = input('text', '', {maxlength: 300, placeholder: 'Product and flavor or the original sale'});
    const quantity = input('number', '1', {min: 1, max: 1000000, step: 1});
    const unit = select([['each', 'Item'], ['case', 'Case']], 'each');
    const subtotal = centsInput(), tax = centsInput('0.00');
    const reason = el('textarea', {maxlength: 2000, required: true, placeholder: 'Explain the return, shortage or correction.'});
    const unknown = el('div', {class: 'form-grid'}, field('Original sale reference', referenceInput), field('Product or sale description', description), field('Quantity', quantity), field('Unit', unit));
    const amounts = el('div', {class: 'form-grid'}, field('Requested subtotal ($)', subtotal), field('Requested tax ($)', tax));
    const explanation = el('p', {class: 'small'});
    const submit = button('Continue to return items', async () => {
      captured.check();
      if (type.value === 'return') {
        const order = await invoices.order();
        if (!m.dialog.open) return;
        m.close();
        return ctx.showReturn(order, record => attach(record, captured));
      }
      const detail = reason.value?.trim();
      if (!detail) throw new Error('Enter a reason for the credit request.');
      const payload = {storeId: captured.storeId, reason: detail};
      if (type.value === 'adjustment') {
        payload.orderId = (await invoices.order()).id;
        payload.subtotalCents = creditCents(subtotal.value, 'Requested subtotal');
        payload.taxCents = creditCents(tax.value, 'Requested tax');
      } else {
        if (!description.value.trim() || !referenceInput.value.trim()) throw new Error('Enter the original sale reference and product or sale description.');
        if (!/^\d+$/.test(quantity.value) || Number(quantity.value) < 1 || Number(quantity.value) > 1000000) throw new Error('Enter a whole quantity from 1 to 1,000,000.');
        payload.originalReference = referenceInput.value.trim();
        payload.lines = [{name: description.value.trim(), quantity: Number(quantity.value), unit: unit.value}];
        if (subtotal.value.trim()) {
          payload.subtotalCents = creditCents(subtotal.value, 'Requested subtotal');
          payload.taxCents = creditCents(tax.value || '0', 'Requested tax');
        }
      }
      captured.check();
      const result = await command('credit.request', payload);
      captured.check(); attach(result, captured); m.close(); toast('Credit request saved and attached to this draft.');
    }, 'primary');
    function update() {
      invoices.node.hidden = type.value === 'unverified'; unknown.hidden = type.value !== 'unverified'; amounts.hidden = type.value === 'return'; reason.hidden = type.value === 'return';
      submit.textContent = type.value === 'return' ? 'Continue to return items' : 'Request credit';
      explanation.textContent = type.value === 'unverified' ? 'Requested amounts are optional and remain unverified. The owner must match a supported original invoice before posting credit.' : type.value === 'adjustment' ? 'Enter documented subtotal and tax amounts. The original invoice and other pending requests set the maximum available credit.' : 'Choose the original invoice, then select returned flavors, quantities and pickup instructions.';
    }
    type.addEventListener('change', update);
    m.content.append(field('Request type', type), invoices.node, unknown, amounts, field('Reason', reason), explanation);
    m.footer.append(button('Cancel', m.close), submit); update();
    await invoices.load();
  }

  async function showReconciliation(record) {
    const captured = capture();
    const m = modal('Reconcile and approve credit', 'Choose the confirmed original sale and document the amount before posting account credit.', true);
    const invoices = invoiceSelector(m, captured, record.orderId);
    const subtotal = centsInput(record.requestedSubtotalCents == null ? '' : (record.requestedSubtotalCents / 100).toFixed(2));
    const tax = centsInput(((record.requestedTaxCents || 0) / 100).toFixed(2));
    const reason = el('textarea', {maxlength: 2000, required: true}); reason.value = record.reason || '';
    m.content.append(notice(`${reference(record)} · ${record.reason}`), invoices.node, el('div', {class: 'form-grid'}, field('Verified credit subtotal ($)', subtotal), field('Verified credit tax ($)', tax)), field('Reconciliation reason', reason));
    m.footer.append(button('Cancel', m.close), button('Approve reconciled credit', async () => {
      captured.check();
      if (!reason.value.trim()) throw new Error('Document the reason for reconciliation.');
      const order = await invoices.order();
      if (!m.dialog.open) return;
      const result = await command('credit.approve', {storeId: captured.storeId, creditId: record.id, expectedVersion: record.version, orderId: order.id,
        subtotalCents: creditCents(subtotal.value, 'Credit subtotal'), taxCents: creditCents(tax.value, 'Credit tax'), reconciliationReason: reason.value.trim()});
      captured.check(); m.close(); showCreditDetails(result); toast('Verified adjustment approved and credited.');
    }, 'primary'));
    await invoices.load();
  }

  function showResolution(record, reject) {
    const captured = capture(), m = modal(reject ? 'Reject request' : 'Cancel request', reference(record));
    const reason = el('textarea', {maxlength: 2000, required: true, placeholder: 'Explain why this request is being closed.'});
    m.content.append(field('Reason', reason));
    m.footer.append(button('Back', m.close), button(reject ? 'Reject request' : 'Cancel request', async () => {
      captured.check();
      if (!reason.value.trim()) throw new Error('Enter a reason.');
      const prefix = ['adjustment', 'unverified'].includes(record.kind) ? 'credit' : 'return';
      await command(`${prefix}.${reject ? 'reject' : 'cancel'}`, {storeId: captured.storeId, [prefix === 'credit' ? 'creditId' : 'returnId']: record.id, expectedVersion: record.version, reason: reason.value.trim()});
      captured.check(); m.close(); toast('Request closed. Its pending credit allowance is available again.');
    }, 'primary'));
  }

  function showPhysical(record, receiving) {
    const captured = capture(), m = modal(receiving ? 'Receive and inspect returned goods' : 'Confirm return pickup', reference(record), true);
    const rows = physicalReturnLines(record).filter(line => (receiving ? line.remainingReceipt : line.remainingPickup) > 0).map(line => {
      const remaining = receiving ? line.remainingReceipt : line.remainingPickup;
      return {line, remaining, quantity: input('number', '0', {min: 0, max: remaining, step: 1, 'aria-label': `${line.name} ${line.variant || 'Standard'} ${receiving ? 'received' : 'picked up'} quantity`}),
        disposition: receiving ? select([['nonresalable', 'Nonresalable / damaged'], ['resalable', 'Inspected and resalable']], 'nonresalable') : null};
    });
    m.content.append(notice(receiving ? 'Only inspected resalable goods increase known warehouse stock. Enter separate receipts when a line has different dispositions.' : 'Confirm goods physically leaving the store. This does not approve credit or restock the warehouse.'), table(receiving ? ['Item', 'Available', 'Received', 'Disposition'] : ['Item', 'Remaining', 'Picked up'], rows.map(row => el('tr', {}, td(`${row.line.name} · ${row.line.variant || 'Standard'} · ${row.line.unit}${row.line.unit === 'case' ? ' (' + row.line.packSize + ' items)' : ''}`), td(row.remaining), td(row.quantity), receiving ? td(row.disposition) : null))));
    const note = el('textarea', {maxlength: 2000, placeholder: 'Collection or inspection note (optional)'});
    m.content.append(field('Note', note));
    m.footer.append(button('Cancel', m.close), button(receiving ? 'Record receipt & inspection' : 'Record pickup', async () => {
      captured.check();
      const lines = [];
      for (const row of rows) {
        if (!/^\d+$/.test(row.quantity.value)) throw new Error('Enter whole quantities.');
        const quantity = Number(row.quantity.value);
        if (quantity > row.remaining) throw new Error('A quantity exceeds the remaining goods.');
        if (quantity) lines.push({lineId: row.line.lineId, variant: row.line.variant || '', quantity, ...(receiving ? {disposition: row.disposition.value} : {})});
      }
      if (!lines.length) throw new Error('Enter at least one quantity.');
      const result = await command(receiving ? 'return.receive' : 'return.pickup', {storeId: captured.storeId, returnId: record.id, expectedVersion: record.version, lines, note: note.value || ''});
      captured.check(); m.close(); showCreditDetails(result); toast(receiving ? 'Warehouse receipt and inspection recorded.' : 'Return pickup recorded.');
    }, 'primary'));
  }

  function showCreditDetails(record) {
    const captured = capture();
    if (record.storeId !== captured.storeId) throw new Error('Select this request’s store first.');
    const actor = ctx.getActor(), staff = actor.role !== 'customer', adjustment = ['adjustment', 'unverified'].includes(record.kind);
    const m = modal(record.creditMemoNumber || kindLabel(record), `${reference(record)} · ${record.status}`, true);
    const amount = record.status === 'approved' ? record.totalCents : requestedAmount(record);
    m.content.append(el('p', {}, record.reason || ''), el('p', {class: 'mt'}, el('strong', {}, `${record.status === 'approved' ? 'Approved account credit issued' : 'Requested credit'}: ${amount == null ? 'Unverified' : cash(amount)}`)));
    if (record.kind === 'unverified') m.content.append(notice('No financial credit has been posted. A verified original invoice and owner reconciliation are required.'));
    if (record.lines?.length) m.content.append(table(['Original item', 'Quantity', 'Credit'], record.lines.map(line => el('tr', {}, td(`${line.name || 'Original invoice line'}${line.variant ? ' · ' + line.variant : ''}`), td(line.quantity ? `${line.quantity} ${line.unit || 'each'}` : 'Adjustment'), td(line.totalCents == null ? 'Unverified' : cash(line.totalCents))))));
    const physical = physicalReturnLines(record);
    if (physical.length) m.content.append(el('h3', {class: 'mt'}, 'Collection and inspection'), table(['Item', 'Requested', 'Picked up', 'Received'], physical.map(line => el('tr', {}, td(`${line.name} · ${line.variant || 'Standard'}`), td(`${line.quantity} ${line.unit}`), td(line.pickedQuantity), td(line.receivedQuantity)))), el('p', {class: 'small'}, 'Credit approval and physical handling are recorded separately.'));
    if (record.restockWarnings?.length) m.content.append(notice('Some returned goods have an unknown warehouse stock baseline. A stock count is needed; their receipt did not invent an on-hand total.'));
    m.footer.append(button('Close', m.close));
    if(record.status==='approved'&&ctx.downloadCreditMemo)m.footer.append(button('Download credit memo',()=>{captured.check();return ctx.downloadCreditMemo(record);}));
    if (record.status === 'pending') {
      if (adjustment && actor.role === 'master') m.footer.append(button(record.kind === 'unverified' ? 'Reconcile original sale' : 'Approve account credit', async () => {
        captured.check();
        if (record.kind === 'unverified') {m.close(); return showReconciliation(record);}
        const result = await command('credit.approve', {storeId: captured.storeId, creditId: record.id, expectedVersion: record.version});
        captured.check(); m.close(); showCreditDetails(result); toast('Adjustment approved and credited once.');
      }, 'primary'));
      if (!adjustment && staff) m.footer.append(button('Approve return credit', async () => {
        captured.check();
        const result = await command('return.approve', {storeId: captured.storeId, returnId: record.id, expectedVersion: record.version, restock: false});
        captured.check(); m.close(); showCreditDetails(result); toast('Return credit approved. Record pickup and receipt separately.');
      }, 'primary'));
      const moved = physical.some(line => line.pickedQuantity > 0);
      if (!moved && (staff || record.createdBy === actor.uid)) m.footer.append(button('Cancel request', () => {captured.check(); m.close(); showResolution(record, false);}));
      if (!moved && staff) m.footer.append(button('Reject request', () => {captured.check(); m.close(); showResolution(record, true);}));
    }
    if (staff && ['pending', 'approved'].includes(record.status)) {
      if (physical.some(line => line.remainingPickup > 0)) m.footer.append(button('Confirm pickup', () => {captured.check();m.close();showPhysical(record, false);}));
      if (physical.some(line => line.remainingReceipt > 0)) m.footer.append(button('Receive & inspect', () => {captured.check();m.close();showPhysical(record, true);}));
    }
    return m;
  }

  return {renderBuilderSection, showCreditDetails, showRequest};
}
