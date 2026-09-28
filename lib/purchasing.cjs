'use strict';
const commands=['supplier.save','supplierProduct.save','purchase.save','purchase.order','purchase.amend','purchase.close','purchase.receive','inventory.configure'];
const OWNER_COMMANDS=new Set(commands.filter(type=>!['purchase.receive','inventory.configure'].includes(type)));
const OPEN_STATUSES=new Set(['ordered','partially received']);
const LIMIT=1_000_000,STOCK_LIMIT=1_000_000_000;
const FIELDS={
  'supplier.save':['id','expectedVersion','name','contact','email','phone','notes','terms','active'],
  'supplierProduct.save':['id','expectedVersion','supplierId','productId','variant','supplierSku','unit','packSize','orderMultiple','unitCostCents','leadTimeDays','active'],
  'purchase.save':['id','expectedVersion','supplierId','expectedDeliveryAt','notes','lines'],
  'purchase.order':['id','expectedVersion'],
  'purchase.amend':['id','expectedVersion','reason','lines','expectedDeliveryAt'],
  'purchase.close':['id','expectedVersion','reason','lines'],
  'purchase.receive':['id','expectedVersion','receivedAt','note','lines'],
  'inventory.configure':['productId','variant','expectedVersion','warehouseBin','targetEach','reorderPoint']
};
function fields(value,allowed,label,h) {h.object(value,label);if(Object.keys(value).some(key=>!allowed.includes(key)))h.fail('INVALID_INPUT',`${label} contains unsupported fields.`);}
function authorize(actor,type,payload,h) {
  if(OWNER_COMMANDS.has(type))h.requireMaster(actor);else h.requireStaff(actor);
  fields(payload,FIELDS[type]||[],'Operation',h);
  if(type==='purchase.receive'&&Array.isArray(payload.lines)&&payload.lines.some(line=>line?.rejectedDisposition==='close'))h.requireMaster(actor);
}
const has=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const quantity=(value,label,h,min=0)=>h.integer(value,label,{min,max:LIMIT});
const nullableInt=(value,label,h,max=STOCK_LIMIT)=>value==null?null:h.integer(value,label,{max});
function unitPack(unit,packSize,h) {
  if(!['each','case'].includes(unit))h.fail('INVALID_INPUT','Ordering unit must be each or case.');
  if(unit==='each'){if(packSize!=null&&packSize!==1)h.fail('INVALID_INPUT','Individual ordering units have a conversion of one.');return 1;}
  return packSize==null?null:h.integer(packSize,'Supplier case size',{min:1,max:LIMIT});
}
function lineAmounts(line,h) {
  const eachQuantity=line.packSize===null?null:h.integer(line.quantity*line.packSize,'Expected individual quantity',{max:STOCK_LIMIT});
  return {...line,eachQuantity,outstandingQuantity:line.quantity-line.acceptedQuantity-line.closedQuantity,lineCostCents:line.unitCostCents===null?null:h.money(line.quantity*line.unitCostCents,'Purchase line cost')};
}
function totals(lines,h) {return {totalCostCents:lines.some(line=>line.lineCostCents===null)?null:h.money(lines.reduce((sum,line)=>sum+line.lineCostCents,0),'Purchase cost total'),costsComplete:lines.every(line=>line.lineCostCents!==null)};}
function statusFor(po) {
  const outstanding=po.lines.reduce((sum,line)=>sum+line.outstandingQuantity,0),closed=po.lines.reduce((sum,line)=>sum+line.closedQuantity,0),accepted=po.lines.reduce((sum,line)=>sum+line.acceptedQuantity,0);
  if(outstanding===0)return closed>0?'closed':accepted>0?'received':'cancelled';
  return po.receiptIds.length?'partially received':'ordered';
}
async function activeSupplier(tx,id,h) {const supplier=await h.required(tx,'suppliers',id,'Supplier');if(supplier.active===false)h.fail('INVALID_SUPPLIER','Select an active supplier.');return supplier;}
function supplierSnapshot(supplier) {return {id:supplier.id,name:supplier.name,contact:supplier.contact||'',email:supplier.email||'',phone:supplier.phone||'',terms:supplier.terms||'',notes:supplier.notes||''};}
async function saveLines(tx,raw,supplierId,h) {
  if(!Array.isArray(raw)||raw.length>2000)h.fail('INVALID_INPUT','Specify up to 2,000 purchase lines.');
  const ids=new Set(),lines=[];
  for(const item of raw) {
    fields(item,['id','supplierProductId','quantity'],'Purchase line',h);
    const id=h.recordId(item.id,'Purchase line ID');if(ids.has(id))h.fail('INVALID_INPUT','Purchase line IDs must be unique.');ids.add(id);
    const mapping=await h.required(tx,'supplierProducts',item.supplierProductId,'Supplier product');
    if(mapping.supplierId!==supplierId)h.fail('INVALID_SUPPLIER','Every purchase line must belong to the selected supplier.');if(mapping.active===false)h.fail('INVALID_PRODUCT','This supplier product is inactive.');
    const product=await h.required(tx,'products',mapping.productId,'Product');if(product.active===false)h.fail('INVALID_PRODUCT','This catalog product is inactive.');h.variantFor(product,mapping.variant);
    const ordered=quantity(item.quantity,'Ordered quantity',h,1),packSize=unitPack(mapping.unit,mapping.packSize,h),orderMultiple=mapping.orderMultiple==null?null:quantity(mapping.orderMultiple,'Supplier ordering multiple',h,1);
    if(orderMultiple!==null&&ordered%orderMultiple!==0)h.fail('INVALID_ORDER_MULTIPLE','Order quantity must match the supplier ordering multiple.');
    const unitCostCents=mapping.unitCostCents==null?null:h.money(mapping.unitCostCents,'Supplier unit cost');
    lines.push(lineAmounts({id,supplierProductId:mapping.id,productId:product.id,name:product.name,variant:mapping.variant||'',sku:product.sku||product.id,supplierSku:mapping.supplierSku||'',quantity:ordered,originalQuantity:ordered,unit:mapping.unit,packSize,orderMultiple,unitCostCents,leadTimeDays:mapping.leadTimeDays??null,acceptedQuantity:0,closedQuantity:0,rejectedQuantity:0},h));
  }
  return lines;
}
function changedLines(raw,po,h,{close=false}={}) {
  if(!Array.isArray(raw)||raw.length===0||raw.length>po.lines.length)h.fail('INVALID_INPUT','Choose purchase lines and quantities.');
  const requested=new Map();
  for(const item of raw){fields(item,['lineId','quantity'],'Purchase amendment line',h);const id=h.recordId(item.lineId,'Purchase line ID');if(requested.has(id)||!po.lines.some(line=>line.id===id))h.fail('INVALID_INPUT','Select each existing purchase line once.');requested.set(id,quantity(item.quantity,'Purchase quantity',h,close?1:0));}
  return requested;
}
async function execute(tx,actor,command,context,h) {
  const p=command.payload||{},type=command.type,{now,id}=context;authorize(actor,type,p,h);
  if(type==='supplier.save') {
    const supplierId=p.id?h.recordId(p.id,'Supplier ID'):id(),previous=await tx.get('suppliers',supplierId);h.versionGuard(previous,p.expectedVersion);const value={...previous,...p};
    const email=h.text(value.email,'Supplier email',320);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))h.fail('INVALID_INPUT','Enter a valid supplier email.');
    const result=h.versioned(previous,{id:supplierId,name:h.text(value.name,'Supplier name',300,true),contact:h.text(value.contact,'Supplier contact',300),email,phone:h.text(value.phone,'Supplier phone',100),notes:h.text(value.notes,'Supplier notes',4000),terms:h.text(value.terms,'Supplier terms',2000),active:h.bool(value.active,'Active',true)},now,actor);await tx.set('suppliers',supplierId,result);return result;
  }
  if(type==='supplierProduct.save') {
    const mappingId=p.id?h.recordId(p.id,'Supplier product ID'):id(),previous=await tx.get('supplierProducts',mappingId);h.versionGuard(previous,p.expectedVersion);const value={...previous,...p};
    const supplier=await activeSupplier(tx,value.supplierId,h),product=await h.required(tx,'products',value.productId,'Product'),variant=h.variantFor(product,value.variant),unit=value.unit??'each',packSize=unitPack(unit,value.packSize,h);
    const result=h.versioned(previous,{id:mappingId,supplierId:supplier.id,productId:product.id,variant,supplierSku:h.text(value.supplierSku,'Supplier SKU',200),unit,packSize,orderMultiple:value.orderMultiple==null?null:quantity(value.orderMultiple,'Ordering multiple',h,1),unitCostCents:value.unitCostCents==null?null:h.money(value.unitCostCents,'Supplier unit cost'),leadTimeDays:nullableInt(value.leadTimeDays,'Lead time days',h,3650),active:h.bool(value.active,'Active',true)},now,actor);await tx.set('supplierProducts',mappingId,result);return result;
  }
  if(type==='inventory.configure') {
    const product=await h.required(tx,'products',p.productId,'Product'),variant=h.variantFor(product,p.variant),key=h.inventoryId(product.id,variant),previous=await tx.get('inventory',key);h.versionGuard(previous,p.expectedVersion);
    const values=previous?h.inventoryValues(previous):{onHand:null,reserved:0,reorderPoint:0};
    const result=h.versioned(previous,{id:key,productId:product.id,variant,...values,warehouseBin:has(p,'warehouseBin')?h.text(p.warehouseBin,'Warehouse bin',200):previous?.warehouseBin||'',targetEach:has(p,'targetEach')?nullableInt(p.targetEach,'Target stock',h):previous?.targetEach??null,...(has(p,'reorderPoint')?{reorderPoint:h.integer(p.reorderPoint,'Reorder point',{max:STOCK_LIMIT})}:{})},now,actor);
    await tx.set('inventory',key,result);return result;
  }
  if(type==='purchase.save') {
    const purchaseId=p.id?h.recordId(p.id,'Purchase order ID'):id(),previous=await tx.get('purchaseOrders',purchaseId);h.versionGuard(previous,p.expectedVersion);
    if(previous&&previous.status!=='draft')h.fail('INVALID_TRANSITION','Placed purchase orders require an explicit amendment.',409);
    const supplier=await activeSupplier(tx,p.supplierId??previous?.supplierId,h),lines=await saveLines(tx,p.lines??previous?.lines?.map(line=>({id:line.id,supplierProductId:line.supplierProductId,quantity:line.quantity}))??[],supplier.id,h);
    let purchaseNumber=previous?.purchaseNumber;
    if(!previous){const year=new Date(now).getUTCFullYear(),counterId='purchase-orders-'+year,counter=await tx.get('counters',counterId),sequence=h.integer((counter?.value||0)+1,'Purchase sequence',{min:1,max:999999999});purchaseNumber=`PO-${year}-${String(sequence).padStart(6,'0')}`;await tx.set('counters',counterId,{id:counterId,value:sequence,version:(counter?.version||0)+1});}
    const result=h.versioned(previous,{id:purchaseId,purchaseNumber,supplierId:supplier.id,supplierSnapshot:supplierSnapshot(supplier),lines,...totals(lines,h),notes:h.text(p.notes??previous?.notes,'Purchase notes',4000),expectedDeliveryAt:has(p,'expectedDeliveryAt')?nullableInt(p.expectedDeliveryAt,'Expected delivery date',h,Number.MAX_SAFE_INTEGER):previous?.expectedDeliveryAt??null,status:'draft',receiptIds:[],amendments:[],closureHistory:[]},now,actor);await tx.set('purchaseOrders',purchaseId,result);return result;
  }
  const po=await h.required(tx,'purchaseOrders',p.id,'Purchase order');
  if(type==='purchase.receive') {
    const receiptId='purchase-receipt-'+h.hash(actor.uid+'\n'+h.recordId(command.id,'Command ID')),fingerprint=h.hash(h.stableJson(p)),existing=await tx.get('purchaseReceipts',receiptId);
    if(existing){if(existing.fingerprint!==fingerprint||existing.purchaseOrderId!==po.id)h.fail('COMMAND_CONFLICT','This receipt identity was already used for different quantities.',409);return po;}
    h.versionGuard(po,p.expectedVersion);if(!OPEN_STATUSES.has(po.status))h.fail('INVALID_TRANSITION','Only an outstanding placed purchase order can be received.',409);
    if(!Array.isArray(p.lines)||!p.lines.length||p.lines.length>po.lines.length)h.fail('INVALID_INPUT','Enter received quantities against purchase lines.');
    const receivedAt=p.receivedAt===undefined?now:h.integer(p.receivedAt,'Receipt time',{max:now});if(receivedAt<po.orderedAt)h.fail('INVALID_INPUT','Receipt cannot precede confirmed placement.');
    const seen=new Set(),events=[];
    for(const row of p.lines) {
      fields(row,['lineId','acceptedQuantity','rejectedQuantity','rejectedDisposition'],'Receipt line',h);const lineId=h.recordId(row.lineId,'Purchase line ID'),line=po.lines.find(line=>line.id===lineId);
      if(!line||seen.has(lineId))h.fail('INVALID_INPUT','Select each purchase line once.');seen.add(lineId);
      const acceptedQuantity=quantity(row.acceptedQuantity??0,'Accepted quantity',h),rejectedQuantity=quantity(row.rejectedQuantity??0,'Rejected quantity',h);
      if(acceptedQuantity+rejectedQuantity===0)h.fail('INVALID_INPUT','Each receipt line needs a delivered quantity.');
      if(acceptedQuantity+rejectedQuantity>line.outstandingQuantity)h.fail('PURCHASE_QUANTITY','A delivery attempt cannot exceed the outstanding supplier obligation. Approve an amendment first.',409);
      let rejectedDisposition=null;
      if(rejectedQuantity>0){rejectedDisposition=h.text(row.rejectedDisposition,'Rejected goods disposition',30,true);if(!['replacement','close'].includes(rejectedDisposition))h.fail('INVALID_INPUT','Choose replacement expected or close this quantity.');if(rejectedDisposition==='close')h.requireMaster(actor);}
      else if(row.rejectedDisposition!==undefined&&!['replacement','close'].includes(row.rejectedDisposition))h.fail('INVALID_INPUT','Invalid rejection disposition.');
      const multiplier=h.integer(line.packSize,'Saved supplier pack',{min:1,max:LIMIT}),acceptedEach=h.integer(acceptedQuantity*multiplier,'Accepted individual quantity',{max:STOCK_LIMIT}),rejectedEach=h.integer(rejectedQuantity*multiplier,'Rejected individual quantity',{max:STOCK_LIMIT});
      events.push({lineId,productId:line.productId,variant:line.variant,unit:line.unit,packSize:multiplier,acceptedQuantity,rejectedQuantity,rejectedDisposition,acceptedEach,rejectedEach});
    }
    const stockChanges=new Map();
    for(const event of events)if(event.acceptedEach>0){const key=h.inventoryId(event.productId,event.variant);stockChanges.set(key,(stockChanges.get(key)||0)+event.acceptedEach);}
    for(const [key,change] of stockChanges){const previous=await tx.get('inventory',key);if(!previous||previous.onHand==null)h.fail('UNKNOWN_STOCK_BASELINE','Record a physical warehouse count before accepting this product into stock.',409);const values=h.inventoryValues(previous);await tx.set('inventory',key,h.versioned(previous,{...values,onHand:h.integer(values.onHand+change,'Warehouse stock',{max:STOCK_LIMIT})},now,actor));}
    const lines=po.lines.map(line=>{const event=events.find(event=>event.lineId===line.id);return event?lineAmounts({...line,acceptedQuantity:quantity(line.acceptedQuantity+event.acceptedQuantity,'Total accepted quantity',h),closedQuantity:quantity(line.closedQuantity+(event.rejectedDisposition==='close'?event.rejectedQuantity:0),'Total closed quantity',h),rejectedQuantity:h.integer(line.rejectedQuantity+event.rejectedQuantity,'Cumulative rejected attempts',{max:STOCK_LIMIT})},h):line;});
    const receiptIds=[...po.receiptIds,receiptId],result=h.versioned(po,{lines,receiptIds,lastReceivedAt:receivedAt,status:statusFor({...po,lines,receiptIds})},now,actor),note=h.text(p.note,'Receipt note',2000);
    for(const event of events){const movementId=receiptId+'-'+h.hash(event.lineId).slice(0,24);await tx.set('warehouseMovements',movementId,{id:movementId,productId:event.productId,variant:event.variant,kind:'purchase-receipt',quantityEach:event.acceptedEach,acceptedEach:event.acceptedEach,rejectedEach:event.rejectedEach,rejectedDisposition:event.rejectedDisposition,sourceType:'purchase-receipt',sourceId:receiptId,purchaseOrderId:po.id,lineId:event.lineId,effectiveAt:receivedAt,recordedAt:now,createdAt:now,createdBy:actor.uid,reason:note||'Supplier delivery receipt',version:1});}
    await tx.set('purchaseReceipts',receiptId,{id:receiptId,purchaseOrderId:po.id,purchaseNumber:po.purchaseNumber,supplierId:po.supplierId,lines:events,receivedAt,recordedAt:now,createdAt:now,createdBy:actor.uid,note,fingerprint,version:1});await tx.set('purchaseOrders',po.id,result);return result;
  }
  h.versionGuard(po,p.expectedVersion);
  if(type==='purchase.order') {
    if(po.status!=='draft')h.fail('INVALID_TRANSITION','Only a draft can be confirmed ordered.',409);await activeSupplier(tx,po.supplierId,h);
    if(!po.lines.length)h.fail('INVALID_INPUT','Add at least one purchase line before confirming placement.');
    for(const line of po.lines){if(line.packSize===null)h.fail('PACK_SIZE_REQUIRED','Confirm the supplier case conversion before placing this purchase order.');const product=await h.required(tx,'products',line.productId,'Product');if(product.active===false)h.fail('INVALID_PRODUCT','This purchase contains an inactive product.');h.variantFor(product,line.variant);}
    const result=h.versioned(po,{status:'ordered',orderedAt:now,orderedBy:actor.uid},now,actor);await tx.set('purchaseOrders',po.id,result);return result;
  }
  if(type==='purchase.amend') {
    if(!['ordered','partially received','received','closed'].includes(po.status))h.fail('INVALID_TRANSITION','Only a confirmed purchase order can be amended.',409);
    const requested=changedLines(p.lines,po,h),reason=h.text(p.reason,'Amendment reason',2000,true),changes=[];
    const lines=po.lines.map(line=>{if(!requested.has(line.id))return line;const next=requested.get(line.id);if(next<line.acceptedQuantity+line.closedQuantity)h.fail('PURCHASE_QUANTITY','Amended quantity cannot be lower than accepted plus closed quantities.',409);if(line.orderMultiple&&next%line.orderMultiple!==0)h.fail('INVALID_ORDER_MULTIPLE','Amended quantity must match the frozen supplier ordering multiple.');changes.push({lineId:line.id,beforeQuantity:line.quantity,quantity:next});return lineAmounts({...line,quantity:next},h);});
    const amendment={id:id(),at:now,by:actor.uid,reason,lines:changes,previousExpectedDeliveryAt:po.expectedDeliveryAt??null,expectedDeliveryAt:has(p,'expectedDeliveryAt')?nullableInt(p.expectedDeliveryAt,'Expected delivery date',h,Number.MAX_SAFE_INTEGER):po.expectedDeliveryAt??null};
    const result=h.versioned(po,{lines,...totals(lines,h),expectedDeliveryAt:amendment.expectedDeliveryAt,amendments:[...po.amendments,amendment],status:statusFor({...po,lines})},now,actor);await tx.set('purchaseOrders',po.id,result);return result;
  }
  if(type==='purchase.close') {
    if(!OPEN_STATUSES.has(po.status))h.fail('INVALID_TRANSITION','Only an outstanding placed purchase order can be closed.',409);
    const reason=h.text(p.reason,'Closure reason',2000,true),requested=p.lines===undefined?new Map(po.lines.filter(line=>line.outstandingQuantity>0).map(line=>[line.id,line.outstandingQuantity])):changedLines(p.lines,po,h,{close:true}),changes=[];
    const lines=po.lines.map(line=>{if(!requested.has(line.id))return line;const close=requested.get(line.id);if(close>line.outstandingQuantity)h.fail('PURCHASE_QUANTITY','Closed quantities cannot exceed the remaining supplier obligation.',409);changes.push({lineId:line.id,closedQuantity:close});return lineAmounts({...line,closedQuantity:line.closedQuantity+close},h);});
    let status=statusFor({...po,lines});if(status==='closed'&&!po.receiptIds.length&&lines.every(line=>line.acceptedQuantity===0))status='cancelled';
    const result=h.versioned(po,{lines,status,closureHistory:[...po.closureHistory,{id:id(),at:now,by:actor.uid,reason,lines:changes}]},now,actor);await tx.set('purchaseOrders',po.id,result);return result;
  }
  h.fail('INVALID_COMMAND','Unsupported purchasing operation.');
}
const valid=value=>Number.isSafeInteger(value)&&value>=0&&value<=STOCK_LIMIT;
const stockKey=(productId,variant='')=>JSON.stringify([productId,variant]);
function suggestions({inventory=[],supplierProducts=[],purchaseOrders=[],now=Date.now()}={}) {
  const stock=new Map(inventory.map(row=>[stockKey(row.productId,row.variant),row])),inbound=new Map(),active=supplierProducts.filter(row=>row.active!==false&&!row.deleted),mapped=new Set(active.map(row=>stockKey(row.productId,row.variant))),rows=[...active,...inventory.filter(row=>!mapped.has(stockKey(row.productId,row.variant))).map(row=>({productId:row.productId,variant:row.variant,missingMapping:true}))];
  for(const po of purchaseOrders)if(OPEN_STATUSES.has(po.status)&&!po.deleted)for(const line of po.lines||[]) {
    const key=stockKey(line.productId,line.variant),entry=inbound.get(key)||{each:0,orders:[],overdue:[]},outstanding=line.quantity-(line.acceptedQuantity??0)-(line.closedQuantity??0),pack=line.unit==='each'?1:line.packSize;
    if(!valid(outstanding)||!valid(pack)||pack===0||!valid(outstanding*pack))entry.each=null;else if(entry.each!==null)entry.each+=outstanding*pack;
    if(outstanding>0){entry.orders.push({id:po.id,expectedDeliveryAt:po.expectedDeliveryAt??null,outstandingEach:valid(pack)&&pack>0?outstanding*pack:null});if(Number.isSafeInteger(po.expectedDeliveryAt)&&po.expectedDeliveryAt<now)entry.overdue.push(po.id);}
    inbound.set(key,entry);
  }
  return rows.map(mapping=>{
    const row=stock.get(stockKey(mapping.productId,mapping.variant)),arrivals=inbound.get(stockKey(mapping.productId,mapping.variant))||{each:0,orders:[],overdue:[]},missingInputs=[];
    if(!valid(row?.onHand))missingInputs.push('onHand');if(!valid(row?.reserved??0))missingInputs.push('reserved');if(!valid(row?.targetEach))missingInputs.push('targetEach');if(mapping.missingMapping)missingInputs.push('supplierProduct');if(!valid(mapping.orderMultiple)||mapping.orderMultiple===0)missingInputs.push('orderMultiple');
    const pack=mapping.unit==='each'?1:mapping.packSize;if(!valid(pack)||pack===0)missingInputs.push('packSize');if(!valid(arrivals.each))missingInputs.push('confirmedInbound');
    const availableEach=valid(row?.onHand)&&valid(row?.reserved??0)?row.onHand-(row.reserved??0):null;if(availableEach!==null&&availableEach<0)missingInputs.push('reservedExceedsOnHand');
    const multipleEach=valid(pack)&&valid(mapping.orderMultiple)&&pack>0&&mapping.orderMultiple>0?pack*mapping.orderMultiple:null;if(multipleEach!==null&&!valid(multipleEach))missingInputs.push('orderMultiple');
    let eligible=missingInputs.length===0,suggestedEach=eligible?Math.ceil(Math.max(0,row.targetEach-availableEach-arrivals.each)/multipleEach)*multipleEach:null;
    if(suggestedEach!==null&&(!valid(suggestedEach)||suggestedEach/pack>LIMIT)){missingInputs.push('quantityLimit');eligible=false;suggestedEach=null;}
    return {productId:mapping.productId,variant:mapping.variant||'',mappingId:mapping.id||null,supplierId:mapping.supplierId||null,kind:'stock-target',eligible,availableEach,inboundEach:arrivals.each,targetEach:row?.targetEach??null,reorderPoint:row?.reorderPoint??null,atOrBelowReorderPoint:availableEach!==null&&valid(row?.reorderPoint)?availableEach<=row.reorderPoint:null,multipleEach,suggestedEach,suggestedQuantity:suggestedEach===null?null:suggestedEach/pack,unit:mapping.unit||null,missingInputs:[...new Set(missingInputs)],inboundOrders:arrivals.orders,overdueOrders:[...new Set(arrivals.overdue)],leadTimeDays:mapping.leadTimeDays??null,limitations:['Stock-target suggestion; future demand is not forecast.']};
  });
}
module.exports={commands,authorize,execute,suggestions,OPEN_STATUSES};
