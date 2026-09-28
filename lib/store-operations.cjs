'use strict';
const {createHash}=require('node:crypto');
const commands=['storeInventory.count','storeInventory.movement','order.handoff','order.place','order.addition','placement.receive'];
const digest=value=>createHash('sha256').update(value).digest('hex');
const storeInventoryId=(storeId,productId,variant='')=>'stock-'+digest(JSON.stringify([storeId,productId,variant]));
const placementId=orderId=>'placement-'+digest(orderId);
function authorize(actor,type,payload,h) {
  h.validateActor(actor);
  const allowed={
    'storeInventory.count':['storeId','productId','variant','quantity','unit','measuredAt','targetEach','expectedVersion','expectedPackSize','note','correctionOf'],
    'storeInventory.movement':['storeId','productId','variant','kind','quantity','unit','effectiveAt','reason'],
    'order.handoff':['id','expectedVersion'],'order.place':['handoffId'],
    'order.addition':['id','storeId','parentOrderId','parentPlacementId'],
    'placement.receive':['id','effectiveAt','note','actualMixAllocations']
  };
  h.object(payload,'Payload');if(Object.keys(payload).some(key=>!allowed[type]?.includes(key)))h.fail('INVALID_INPUT','The operation contains unsupported fields.');
  if(payload.storeId!==undefined)h.authorizeStore(actor,payload.storeId);
}
function timestamp(value,label,now,h) {return h.integer(value,label,{min:0,max:now});}
function creator(actor,record,h) {if(actor.role==='customer'&&record.createdBy!==actor.uid)h.fail('FORBIDDEN','Only the creator can confirm this order.',403);}
// The dispatcher calls this before serving a cached command result. Creator
// checks need the current actor role and saved record, not the original receipt.
async function authorizeReplay(tx,actor,command,result,h) {
  authorize(actor,command.type,command.payload,h);
  if(result?.storeId)await scopedStore(tx,actor,result.storeId,h);
  if(command.type==='order.handoff') {
    const order=await h.required(tx,'orders',command.payload.id,'Order');
    await scopedStore(tx,actor,order.storeId,h);creator(actor,order,h);
  } else if(command.type==='order.place') {
    const handoff=await h.required(tx,'orderHandoffs',command.payload.handoffId,'Mail handoff');
    await scopedStore(tx,actor,handoff.storeId,h);creator(actor,handoff,h);
    const order=await h.required(tx,'orders',handoff.orderId,'Order');
    await scopedStore(tx,actor,order.storeId,h);creator(actor,order,h);
  }
}
async function scopedStore(tx,actor,storeId,h) {
  h.authorizeStore(actor,storeId);const store=await h.required(tx,'stores',storeId,'Store');
  if(store.active===false)h.fail('INVALID_INPUT','This store is inactive.');return store;
}
function quantity(input,product,h,{signed=false,zero=false}={}) {
  const unit=input.unit??'each';if(!['each','case'].includes(unit))h.fail('INVALID_INPUT','Unit must be each or case.');
  const amount=h.integer(input.quantity,'Quantity',{min:signed?-1_000_000:zero?0:1,max:1_000_000});
  if(!zero&&amount===0)h.fail('INVALID_INPUT','A movement must have a nonzero quantity.');
  const packSize=product.packSize==null?null:h.integer(product.packSize,'Case size',{min:1,max:1_000_000});
  if(unit==='case'&&packSize===null)h.fail('PACK_SIZE_REQUIRED','A known case size is required.');
  if(unit==='case'&&input.expectedPackSize!==undefined&&h.integer(input.expectedPackSize,'Observed case size',{min:1,max:1_000_000})!==packSize)h.fail('PACK_SIZE_CHANGED','The case size changed. Review the observed count before syncing.',409);
  return {quantity:amount,unit,packSize,each:h.integer(amount*(unit==='case'?packSize:1),'Individual quantity',{min:signed?-1_000_000_000:0,max:1_000_000_000})};
}
function orderedContent(order,h) {
  return {storeId:order.storeId,notes:order.notes||'',creditRequestIds:[...(order.creditRequestIds||[])].sort(),lines:(order.lines||[]).map(line=>{
    const unit=line.unit||'each',packSize=unit==='case'?line.packSize??null:1;
    return {productId:line.productId,variant:line.selectionMode==='mix'?'':line.variant||'',quantity:line.quantity,unit,packSize,eachQuantity:line.eachQuantity??(packSize===null?null:line.quantity*packSize),note:line.note||'',...(line.selectionMode==='mix'?{selectionMode:'mix',allowedVariants:[...(line.allowedVariants||[])].sort(),excludedVariants:[...(line.excludedVariants||[])].sort()}:{} )};
  })};
}
function contentHash(order,h) {return digest(h.stableJson(orderedContent(order,h)));}
async function assertParent(tx,order,h) {
  if(!order.parentOrderId&&!order.parentPlacementId)return;
  const parent=order.rootOrderId||order.parentOrderId?await h.required(tx,'orders',order.rootOrderId||order.parentOrderId,'Original order'):null;
  const placement=order.rootPlacementId||order.parentPlacementId?await h.required(tx,'orderPlacements',order.rootPlacementId||order.parentPlacementId,'Original placement'):null;
  if((parent&&(parent.storeId!==order.storeId||parent.status==='cancelled'))||(placement&&(placement.storeId!==order.storeId||placement.status==='cancelled')))h.fail('INVALID_PARENT_ORDER','The original order is unavailable for additions.',409);
}
async function ensureSubmittedPlacement(tx,order,context,h) {
  await scopedStore(tx,context.actor,order.storeId,h);await assertParent(tx,order,h);
  const key=placementId(order.id),existing=await tx.get('orderPlacements',key),hash=contentHash(order,h);
  if(existing) {
    // Recompute from the immutable snapshot so older placement hashes receive
    // the same conversion check without rewriting their sent contents.
    if(existing.storeId!==order.storeId||contentHash(existing,h)!==hash)h.fail('PLACEMENT_CONTENT_CONFLICT','This draft differs from the order already marked placed, including its case conversion. Create an addition or resolve the placed order before submitting.',409);
    return existing;
  }
  const record={id:key,orderId:order.id,storeId:order.storeId,orderNumber:order.orderNumber??null,orderVersion:order.version??1,lines:structuredClone(order.lines),creditRequestIds:[...(order.creditRequestIds||[])],notes:order.notes||'',contentHash:hash,provenance:'submitted',placedAt:order.submittedAt??context.now,createdAt:context.now,createdBy:context.actor.uid,rootOrderId:order.rootOrderId||order.id,parentOrderId:order.parentOrderId||null,parentPlacementId:order.parentPlacementId||null,rootPlacementId:order.rootPlacementId||key,additionReference:order.additionReference||null,handoffId:null,receivedAt:null,version:1};
  await tx.set('orderPlacements',key,record);return record;
}
function concreteReceiptLines(order,h) {
  return (order.lines||[]).flatMap(line=>{
    if(line.selectionMode!=='mix')return [line];
    if(!line.pickedAt||!Array.isArray(line.allocations)||!line.allocations.length)h.fail('MIX_ALLOCATION_REQUIRED','Confirm actual picked flavors before receiving a Mix order.',409);
    return line.allocations.map(allocation=>({...line,...allocation,selectionMode:undefined}));
  });
}
function receiptGroups(order,h) {
  const groups=new Map();
  for(const line of concreteReceiptLines(order,h)) {
    const productId=h.recordId(line.productId),variant=h.text(line.variant,'Variant',200),lineKey=storeInventoryId(order.storeId,productId,variant);
    let each=line.eachQuantity;
    if(each==null){if(line.unit==='case'&&!Number.isSafeInteger(line.packSize))h.fail('PACK_SIZE_REQUIRED','The placed order has no verified case size.');each=line.quantity*(line.unit==='case'?line.packSize:1);}
    each=h.integer(each,'Received quantity',{min:1,max:1_000_000_000});
    const group=groups.get(lineKey)||{productId,variant,quantityEach:0};group.quantityEach=h.integer(group.quantityEach+each,'Received quantity',{max:1_000_000_000});groups.set(lineKey,group);
  }
  return groups;
}
function receiptHash(groups,h) {return digest(h.stableJson([...groups].sort(([a],[b])=>a.localeCompare(b))));}
async function recordReceipt(tx,placement,order,context,h,{effectiveAt=context.now,note='',sourceType='placement-receipt'}={}) {
  const fulfillmentId=placement.id,key='fulfillment-'+digest(fulfillmentId),groups=receiptGroups(order,h),fulfillmentHash=receiptHash(groups,h);
  const existing=await tx.get('storeInventoryReceipts',key);
  if(existing) {
    const savedHash=existing.fulfillmentHash||(placement.receivedLines?receiptHash(receiptGroups({...placement,lines:placement.receivedLines},h),h):null);
    if(existing.storeId!==order.storeId||existing.orderId!==order.id||savedHash!==fulfillmentHash)h.fail('FULFILLMENT_CONFLICT','These quantities or actual flavors differ from the goods already received. Reconcile the fulfillment before confirming delivery.',409);
    return existing;
  }
  for(const [lineKey,group] of groups) {
    const id='receipt-'+digest(fulfillmentId+'\n'+lineKey);
    await tx.set('storeInventoryMovements',id,{id,storeId:order.storeId,...group,kind:'receipt',quantity:group.quantityEach,unit:'each',packSize:null,effectiveAt,recordedAt:context.now,createdAt:context.now,createdBy:context.actor.uid,reason:note||'Confirmed order receipt',sourceType,sourceId:order.id,fulfillmentId,version:1});
  }
  const receipt={id:key,storeId:order.storeId,placementId:placement.id,orderId:order.id,fulfillmentHash,effectiveAt,recordedAt:context.now,createdBy:context.actor.uid,version:1};
  await tx.set('storeInventoryReceipts',key,receipt);
  await tx.set('orderPlacements',placement.id,{...placement,receivedLines:structuredClone(order.lines),receivedAt:effectiveAt,receiptId:key,version:(placement.version||1)+1});return receipt;
}
function actualMailMixLines(placement,input,context,h) {
  if(input===undefined)return placement.receivedLines||placement.lines;
  if(placement.provenance!=='mail-confirmed'||!Array.isArray(input)||input.length>placement.lines.length)h.fail('INVALID_MIX_ALLOCATION','Confirm actual flavors only for a Mail placement.');
  const requested=new Map();
  for(const row of input){h.object(row,'Received mix');if(Object.keys(row).some(key=>!['lineId','allocations'].includes(key)))h.fail('INVALID_MIX_ALLOCATION','Unexpected received mix field.');const lineId=h.recordId(row.lineId,'Line ID');if(requested.has(lineId))h.fail('INVALID_MIX_ALLOCATION','Each mixed item must appear once.');requested.set(lineId,row.allocations);}
  const lines=placement.lines.map(line=>{
    if(line.selectionMode!=='mix')return line;
    const rows=requested.get(line.id);requested.delete(line.id);
    if(!Array.isArray(rows)||!rows.length||rows.length>200)h.fail('INVALID_MIX_ALLOCATION','Confirm actual quantities for every mixed item.');
    const seen=new Set(),pack=line.unit==='case'?h.integer(line.packSize,'Case size',{min:1,max:1_000_000}):1;
    const allocations=rows.map(row=>{
      h.object(row,'Received flavor');if(Object.keys(row).some(key=>!['variant','quantity'].includes(key)))h.fail('INVALID_MIX_ALLOCATION','Unexpected received flavor field.');
      const variant=h.text(row.variant,'Received flavor',200);if(!line.allowedVariants.includes(variant)||(line.excludedVariants||[]).includes(variant)||seen.has(variant))h.fail('INVALID_MIX_ALLOCATION','Use only the frozen allowed flavors, once each.');seen.add(variant);
      const quantity=h.integer(row.quantity,'Received quantity',{min:1,max:1_000_000});return {variant,quantity,eachQuantity:h.integer(quantity*pack,'Individual quantity',{max:1_000_000_000})};
    });
    if(allocations.reduce((sum,row)=>sum+row.quantity,0)!==line.quantity)h.fail('INVALID_MIX_ALLOCATION','Actual flavors must sum to the placed quantity.');
    return {...line,allocations,pickedAt:context.now,pickedBy:context.actor.uid};
  });
  if(requested.size||!placement.lines.some(line=>line.selectionMode==='mix'))h.fail('INVALID_MIX_ALLOCATION','Only saved mixed items can receive a flavor split.');
  if(placement.receivedLines) {
    const splits=rows=>rows.filter(line=>line.selectionMode==='mix').map(line=>({id:line.id,allocations:line.allocations}));
    if(h.stableJson(splits(lines))!==h.stableJson(splits(placement.receivedLines)))h.fail('COMMAND_CONFLICT','This placement was already received with different actual flavors.',409);
  }
  return lines;
}
async function recordOrderDelivery(tx,order,context,h) {
  const placement=order.placementId?await h.required(tx,'orderPlacements',order.placementId,'Placement'):await ensureSubmittedPlacement(tx,order,context,h);
  if(placement.storeId!==order.storeId||placement.orderId!==order.id)h.fail('FORBIDDEN','This placement belongs to a different order.',403);
  if(contentHash(placement,h)!==contentHash(order,h))h.fail('FULFILLMENT_CONFLICT','The delivery differs from the placed quantities or case conversion. Reconcile the fulfillment before confirming delivery.',409);
  return recordReceipt(tx,placement,order,context,h,{effectiveAt:order.deliveredAt??context.now,sourceType:'order-delivery'});
}
async function execute(tx,actor,command,context,h) {
  const p=h.object(command.payload||{},'Payload'),{now,id}=context;authorize(actor,command.type,p,h);
  if(command.type==='storeInventory.count'||command.type==='storeInventory.movement') {
    const storeId=h.recordId(p.storeId,'Store ID');await scopedStore(tx,actor,storeId,h);
    const product=await h.required(tx,'products',p.productId,'Product'),variant=h.variantFor(product,p.variant);
    if(command.type==='storeInventory.movement') {
      const kind=h.text(p.kind,'Movement type',40,true);if(!['receipt','return-out','damage','transfer-in','transfer-out','correction','unclassified'].includes(kind))h.fail('INVALID_INPUT','Choose a valid physical movement.');
      const q=quantity(p,product,h,{signed:['correction','unclassified'].includes(kind)}),reason=h.text(p.reason,'Movement reason',2000,true),effectiveAt=timestamp(p.effectiveAt,'Movement date',now,h);
      const movementId=id(),sign=['return-out','damage','transfer-out'].includes(kind)?-1:1;
      const result={id:movementId,storeId,productId:product.id,variant,kind,quantityEach:q.each*sign,quantity:q.quantity,unit:q.unit,packSize:q.packSize,effectiveAt,recordedAt:now,createdAt:now,createdBy:actor.uid,reason,sourceType:'manual',sourceId:movementId,version:1};
      await tx.set('storeInventoryMovements',movementId,result);return result;
    }
    const key=storeInventoryId(storeId,product.id,variant),previous=await tx.get('storeInventory',key);h.versionGuard(previous,p.expectedVersion);
    const q=quantity(p,product,h,{zero:true}),measuredAt=timestamp(p.measuredAt,'Count date',now,h),countId=id();
    const correctionOf=p.correctionOf?h.recordId(p.correctionOf,'Corrected count ID'):null;
    if(correctionOf) {
      const original=await h.required(tx,'storeInventoryCounts',correctionOf,'Count');
      if(original.storeId!==storeId||original.productId!==product.id||original.variant!==variant||original.measuredAt!==measuredAt)h.fail('INVALID_CORRECTION','Correct the same item and measurement time.');
      const replacements=await tx.list('storeInventoryCounts',{where:[['correctionOf','==',correctionOf]],limit:1});if(replacements.length)h.fail('INVALID_CORRECTION','This count already has a correction. Correct its latest replacement.',409);
    }
    const observation={id:countId,storeId,productId:product.id,variant,countEach:q.each,quantity:q.quantity,unit:q.unit,packSize:q.packSize,measuredAt,recordedAt:now,createdAt:now,createdBy:actor.uid,note:h.text(p.note,'Count note',2000),correctionOf,version:1};
    await tx.set('storeInventoryCounts',countId,observation);
    const isLatest=!previous||measuredAt>=previous.measuredAt;
    const targetEach=p.targetEach===undefined?previous?.targetEach??null:p.targetEach===null?null:h.integer(p.targetEach,'Target quantity',{max:1_000_000_000});
    const result=h.versioned(previous,{id:key,storeId,productId:product.id,variant,targetEach,...(isLatest?{countEach:q.each,measuredAt,latestCountId:countId}:{})},now,actor);
    await tx.set('storeInventory',key,result);return result;
  }
  if(command.type==='order.handoff') {
    const order=await h.required(tx,'orders',p.id,'Order');await scopedStore(tx,actor,order.storeId,h);creator(actor,order,h);h.versionGuard(order,p.expectedVersion);await assertParent(tx,order,h);
    if(!['draft','submitted','approved','picking','delivered'].includes(order.status))h.fail('INVALID_TRANSITION','This order cannot be prepared for Mail.',409);
    const store=await h.required(tx,'stores',order.storeId,'Store');let snapshot=structuredClone(order);
    if(order.status==='draft') {
      const products=[];for(const productId of new Set(order.lines.map(line=>line.productId)))products.push(await h.required(tx,'products',productId,'Product'));
      snapshot={...snapshot,...h.calculateOrder(order.lines,products,store,await h.loadProductCategories(tx,products))};
    }
    const key='handoff-'+digest(order.id+'\n'+order.version),existing=await tx.get('orderHandoffs',key);if(existing)return existing;
    snapshot.creditRequests=(await Promise.all((order.creditRequestIds||[]).map(id=>tx.get('returns',id)))).filter(row=>row?.storeId===order.storeId);
    const result={id:key,storeId:order.storeId,orderId:order.id,orderVersion:order.version,contentHash:contentHash(snapshot,h),snapshot,createdAt:now,createdBy:actor.uid,version:1};await tx.set('orderHandoffs',key,result);return result;
  }
  if(command.type==='order.place') {
    const handoff=await h.required(tx,'orderHandoffs',p.handoffId,'Mail handoff');await scopedStore(tx,actor,handoff.storeId,h);creator(actor,handoff,h);
    const order=await h.required(tx,'orders',handoff.orderId,'Order');creator(actor,order,h);if(order.status==='cancelled')h.fail('INVALID_TRANSITION','A canceled order cannot be marked placed.',409);await assertParent(tx,order,h);
    const key=placementId(order.id),existing=await tx.get('orderPlacements',key);
    if(existing){if(contentHash(existing,h)!==contentHash(handoff.snapshot,h))h.fail('PLACEMENT_CONTENT_CONFLICT','This order already has a different confirmed placement. Create an addition.',409);return existing;}
    const snapshot=handoff.snapshot;
    const result={id:key,orderId:order.id,storeId:order.storeId,orderNumber:snapshot.orderNumber??null,orderVersion:handoff.orderVersion,lines:structuredClone(snapshot.lines),creditRequestIds:[...(snapshot.creditRequestIds||[])],notes:snapshot.notes||'',contentHash:handoff.contentHash,provenance:'mail-confirmed',placedAt:now,createdAt:now,createdBy:actor.uid,rootOrderId:order.rootOrderId||order.id,parentOrderId:order.parentOrderId||null,parentPlacementId:order.parentPlacementId||null,rootPlacementId:order.rootPlacementId||key,additionReference:order.additionReference||null,handoffId:handoff.id,receivedAt:null,version:1};
    await tx.set('orderPlacements',key,result);await tx.set('orders',order.id,h.versioned(order,{placementId:key},now,actor));return result;
  }
  if(command.type==='placement.receive') {
    const placement=await h.required(tx,'orderPlacements',p.id,'Placement');await scopedStore(tx,actor,placement.storeId,h);
    const order=await h.required(tx,'orders',placement.orderId,'Order');if(order.status==='cancelled')h.fail('INVALID_TRANSITION','A canceled order cannot be received.',409);
    const effectiveAt=p.effectiveAt===undefined?now:timestamp(p.effectiveAt,'Receipt date',now,h);if(effectiveAt<placement.placedAt)h.fail('INVALID_INPUT','Receipt cannot precede placement.');
    if(placement.provenance==='submitted'&&order.status!=='delivered')h.fail('INVALID_TRANSITION','App orders are received when staff confirm delivery.',409);
    const lines=placement.provenance==='mail-confirmed'?actualMailMixLines(placement,p.actualMixAllocations,context,h):order.lines;
    if(placement.provenance!=='mail-confirmed'&&p.actualMixAllocations!==undefined)h.fail('INVALID_MIX_ALLOCATION','Staff must confirm app-order picks before delivery.');
    await recordReceipt(tx,placement,{...order,lines},context,h,{effectiveAt,note:h.text(p.note,'Receipt note',2000)});
    return await tx.get('orderPlacements',placement.id);
  }
  if(command.type==='order.addition') {
    const storeId=h.recordId(p.storeId,'Store ID');await scopedStore(tx,actor,storeId,h);if(Boolean(p.parentOrderId)===Boolean(p.parentPlacementId))h.fail('INVALID_INPUT','Choose one original order or placement.');
    const initialPlacement=p.parentPlacementId?await h.required(tx,'orderPlacements',p.parentPlacementId,'Original placement'):null;
    const initialOrder=await h.required(tx,'orders',initialPlacement?.orderId||p.parentOrderId,'Original order');
    const rootId=initialOrder.rootOrderId||initialOrder.id,root=await h.required(tx,'orders',rootId,'Original order');
    if(root.storeId!==storeId||initialOrder.storeId!==storeId||initialPlacement&&initialPlacement.storeId!==storeId)h.fail('FORBIDDEN','The original order belongs to a different store.',403);
    const rootPlacement=await tx.get('orderPlacements',root.rootPlacementId||root.placementId||placementId(root.id));
    if(root.status==='cancelled'||initialOrder.status==='cancelled'||(!rootPlacement&&!['submitted','approved','picking','delivered'].includes(root.status)))h.fail('INVALID_PARENT_ORDER','Additions require an active placed or submitted original order.',409);
    const orderId=h.recordId(p.id,'Addition ID');if(await tx.get('orders',orderId))h.fail('VERSION_CONFLICT','This addition already exists. Refresh before trying again.',409);
    const counterId='order-additions-'+digest(rootId),counter=await tx.get('counters',counterId),additionNumber=h.integer((counter?.value||0)+1,'Addition number',{min:1,max:999999});
    const sequence=await tx.get('counters','order-numbers'),orderNumber=h.integer((sequence?.value||0)+1,'Order number',{min:1,max:Number.MAX_SAFE_INTEGER});
    const reference=String(root.orderNumber??root.invoiceNumber??root.id);
    const result=h.versioned(null,{id:orderId,storeId,status:'draft',lines:[],notes:'',orderNumber,parentOrderId:rootId,rootOrderId:rootId,parentPlacementId:rootPlacement?.id||null,rootPlacementId:rootPlacement?.id||null,additionNumber,parentReference:reference,additionReference:`${reference}-A${additionNumber}`,additionDelivery:root.status==='delivered'?'follow-up':'original-delivery'},now,actor);
    await tx.set('counters',counterId,{id:counterId,value:additionNumber,version:(counter?.version||0)+1});await tx.set('counters','order-numbers',{id:'order-numbers',value:orderNumber,version:(sequence?.version||0)+1});await tx.set('orders',orderId,result);return result;
  }
  h.fail('INVALID_COMMAND','This store operation is not supported.');
}
module.exports={commands,authorize,authorizeReplay,execute,storeInventoryId,contentHash,ensureSubmittedPlacement,recordOrderDelivery};
