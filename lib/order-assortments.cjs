'use strict';

function normalize(line, h) {
  if (line.selectionMode === undefined || line.selectionMode === 'manual') return {};
  if (line.selectionMode !== 'mix') h.fail('INVALID_INPUT', 'Choose a supported flavor selection mode.');
  function flavors(value, label, required) {
    if (!Array.isArray(value) || value.length > 200 || (required && !value.length)) h.fail('INVALID_INPUT', `${label} must contain available flavors.`);
    const result = value.map(v => h.text(v, label, 200));
    if (new Set(result).size !== result.length) h.fail('INVALID_INPUT', `${label} contains duplicates.`);
    return result;
  }
  const allowedVariants = flavors(line.allowedVariants, 'Allowed flavors', true);
  const excludedVariants = flavors(line.excludedVariants ?? [], 'Excluded flavors', false);
  if (allowedVariants.some(v => excludedVariants.includes(v))) h.fail('INVALID_INPUT', 'An excluded flavor cannot also be allowed.');
  return {selectionMode:'mix', allowedVariants, excludedVariants};
}

function validate(product, line, h) {
  const selection = normalize(line, h);
  if (!selection.selectionMode) return h.variantFor(product, line.variant);
  if (line.variant) h.fail('INVALID_INPUT', 'A mixed item cannot specify a single flavor.');
  for (const variant of [...selection.allowedVariants, ...selection.excludedVariants]) h.variantFor(product, variant);
  return '';
}

function price(product, line, store, h) {
  validate(product, line, h);
  const prices = line.allowedVariants.map(v => h.priceFor(product, v, store));
  if (new Set(prices).size !== 1) h.fail('MIX_PRICE_REVIEW', 'These flavors have different prices. Choose an exact flavor split before submitting this mix.', 409);
  return prices[0];
}

function expandLines(lines) {
  return lines.flatMap(line => line.selectionMode === 'mix'
    ? (line.allocations || []).map(allocation => ({...line,...allocation,selectionMode:'manual',originalLineId:line.id}))
    : [line]);
}

function returnableLines(order, h) {
  return order.lines.flatMap(line => {
    if (line.selectionMode !== 'mix') return [line];
    if (!line.pickedAt) return [];
    let cumulative = 0;
    return (line.allocations || []).map(a => {
      const taxCents = h.roundRatio(line.taxCents, cumulative + a.quantity, line.quantity) - h.roundRatio(line.taxCents, cumulative, line.quantity);
      cumulative += a.quantity;
      return {...line,...a,selectionMode:'manual',originalLineId:line.id,lineTotalCents:h.money(line.unitPriceCents*a.quantity),taxCents};
    });
  });
}

// Ordinary rows and earlier assortment requests consume the same capacity.
// Batched round-robin allocation stays bounded even for a million units.
async function allocate(tx, lines, h) {
  const used = new Map();
  for (const line of lines.filter(l => l.selectionMode !== 'mix' || l.allocations)) {
    for (const row of expandLines([line])) {
      const key = h.inventoryId(row.productId,row.variant);
      used.set(key,(used.get(key)||0)+row.eachQuantity);
    }
  }
  const result = [];
  for (const line of lines) {
    if (line.selectionMode !== 'mix' || line.allocations) {result.push(line);continue;}
    const pack = line.unit === 'case' ? line.packSize : 1;
    const choices = [];
    for (const variant of line.allowedVariants) {
      const key=h.inventoryId(line.productId,variant), record=await tx.get('inventory',key);
      const available=record?.onHand == null ? line.quantity : Math.max(0,Math.floor((h.inventoryValues(record).onHand-(record.reserved||0)-(used.get(key)||0))/pack));
      choices.push({variant,key,capacity:available,quantity:0});
    }
    let remaining=line.quantity;
    while (remaining>0) {
      const active=choices.filter(c=>c.quantity<c.capacity);
      if (!active.length) h.fail('INSUFFICIENT_STOCK','Not enough stock across the allowed mix flavors.',409);
      const share=Math.max(1,Math.floor(remaining/active.length));
      for(const choice of active) {
        const count=Math.min(remaining,share,choice.capacity-choice.quantity);
        choice.quantity+=count;remaining-=count;
        if(!remaining)break;
      }
    }
    const allocations=choices.filter(c=>c.quantity).map(c=>{
      const eachQuantity=c.quantity*pack;
      used.set(c.key,(used.get(c.key)||0)+eachQuantity);
      return {variant:c.variant,quantity:c.quantity,eachQuantity};
    });
    result.push({...line,allocations});
  }
  return result;
}

async function pick(tx,actor,payload,context,h) {
  h.requireStaff(actor);
  const order=await h.required(tx,'orders',payload.id,'Order');h.authorizeStore(actor,order.storeId);
  h.versionGuard(order,payload.expectedVersion);
  if (!['approved','picking'].includes(order.status)) h.fail('INVALID_TRANSITION','Confirm picked flavors on an approved or picking order.',409);
  if (!Array.isArray(payload.allocations) || payload.allocations.length>order.lines.length) h.fail('INVALID_MIX_ALLOCATION','Supply each mixed item’s actual picked flavors.');
  const input=new Map();
  for(const row of payload.allocations){h.object(row,'Picked item');const lineId=h.recordId(row.lineId);if(input.has(lineId))h.fail('INVALID_MIX_ALLOCATION','Duplicate mixed item.');input.set(lineId,row.variants);}
  const lines=order.lines.map(line=>{
    if(line.selectionMode!=='mix')return line;
    const rows=input.get(line.id);input.delete(line.id);
    if(!Array.isArray(rows)||!rows.length||rows.length>200)h.fail('INVALID_MIX_ALLOCATION','Confirm actual quantities for every mixed item.');
    const seen=new Set(),pack=line.unit==='case'?line.packSize:1;
    const allocations=rows.map(row=>{
      h.object(row,'Picked flavor');const variant=h.text(row.variant,'Flavor',200);
      if(!line.allowedVariants.includes(variant)||line.excludedVariants.includes(variant)||seen.has(variant))h.fail('INVALID_MIX_ALLOCATION','Use each permitted flavor once; excluded flavors cannot be picked.');
      seen.add(variant);const quantity=h.integer(row.quantity,'Picked quantity',{min:1,max:h.QUANTITY_LIMIT});
      return {variant,quantity,eachQuantity:quantity*pack};
    });
    if(allocations.reduce((sum,a)=>sum+a.quantity,0)!==line.quantity)h.fail('INVALID_MIX_ALLOCATION','Picked flavor quantities must equal the total requested.');
    return {...line,allocations,pickedAt:context.now,pickedBy:actor.uid};
  });
  if(input.size||!lines.some(l=>l.selectionMode==='mix'))h.fail('INVALID_MIX_ALLOCATION','Only mixed items can have flavor allocations.');
  await h.releaseOrDeliver(tx,order,false,context.now,actor);
  const reserved=await h.reserveStock(tx,{lines},context.now,actor);
  const result=h.versioned(order,{...reserved,pickedAt:context.now,pickedBy:actor.uid},context.now,actor);
  await tx.set('orders',order.id,result);return result;
}

module.exports={normalize,validate,price,expandLines,returnableLines,allocate,pick};
