'use strict';
const {helpers:h}=require('./domain.cjs');

const PO_FIELDS=['id','number','poNumber','purchaseNumber','purchaseOrderNumber','supplierId','status','version','createdAt','updatedAt','orderedAt','expectedAt','expectedDeliveryAt','receivedAt','closedAt','cancelledAt'];
const LINE_FIELDS=['id','lineId','supplierProductId','productId','variant','name','supplierSku','quantity','unit','packSize','eachQuantity','orderMultiple','acceptedQuantity','closedQuantity','rejectedQuantity','outstandingQuantity','acceptedEach','rejectedEach','closedEach','rejectedDisposition'];
const WARNING_FIELDS=['code','productId','variant','quantity','quantityEach','eachQuantity','lineId'];
const primitive=value=>value===null||['string','number','boolean'].includes(typeof value);
function fields(value,keys){return Object.fromEntries(keys.filter(key=>Object.hasOwn(value||{},key)&&primitive(value[key])).map(key=>[key,value[key]]));}
const warnings=value=>Array.isArray(value)?value.map(row=>fields(row,WARNING_FIELDS)):[];

function projectPurchaseOrder(record,actor){
  h.requireStaff(actor);
  if(actor.role==='master')return structuredClone(record);
  return {...fields(record,PO_FIELDS),supplierSnapshot:fields(record.supplierSnapshot,['id','name']),
    lines:(record.lines||[]).map(line=>fields(line,LINE_FIELDS)),inventoryWarnings:warnings(record.inventoryWarnings),receiptWarnings:warnings(record.receiptWarnings)};
}
function projectPurchaseReceipt(record,actor){
  h.requireStaff(actor);
  if(actor.role==='master')return structuredClone(record);
  return {...fields(record,['id','purchaseOrderId','purchaseNumber','poId','receivedAt','recordedAt','createdAt','version']),
    lines:(record.lines||[]).map(line=>fields(line,LINE_FIELDS)),inventoryWarnings:warnings(record.inventoryWarnings),warnings:warnings(record.warnings)};
}
function projectInventory(record){return fields(record,['id','productId','variant','onHand','reserved','reorderPoint','targetEach','target','bin','warehouseBin','version','updatedAt']);}
function projectWarehouseCommand(type,result,actor){
  if(type==='purchase.receive')return projectPurchaseOrder(result,actor);
  if(type.startsWith('purchase.')||type.startsWith('supplier.')||type.startsWith('supplierProduct.')){h.requireMaster(actor);return structuredClone(result);}
  if(type==='inventory.configure'){h.requireStaff(actor);return projectInventory(result);}
  return result;
}

function projectProduct(product){
  const result=fields(product,['id','name','sku','barcode','packSize','active','deleted','standardVariantEnabled']);
  result.variants=(product.variants||[]).filter(value=>typeof value==='string');
  result.variantBarcodes=Object.fromEntries(Object.entries(product.variantBarcodes||{}).filter(([,value])=>typeof value==='string'));
  return result;
}
function projectMovement(record,actor){
  if(actor.role==='master')return structuredClone(record);
  return fields(record,['id','productId','variant','kind','type','quantityEach','eachQuantity','receivedQuantityEach','deltaEachQuantity','deltaEach','beforeEach','afterEach','beforeOnHand','afterOnHand','sourceType','sourceId','purchaseOrderId','orderId','returnId','disposition','appliedToInventory','effectiveAt','recordedAt','createdAt','version']);
}
function projectSuggestion(row){
  return {...fields(row,['productId','variant','mappingId','supplierId','availableEach','inboundEach','targetEach','multipleEach','suggestedEach','suggestedQuantity','unit','eligible','kind']),
    missingInputs:(row.missingInputs||[]).filter(value=>typeof value==='string'),
    overdueOrders:(row.overdueOrders||[]).map(value=>typeof value==='string'?value:fields(value,['id','number','poNumber','expectedAt','expectedDeliveryAt']))};
}

const validQuantity=value=>Number.isSafeInteger(value)&&value>=0&&value<=1_000_000_000;
const known=value=>validQuantity(value)?value:null;
function confirmedInbound(purchaseOrders){
  const inbound=new Map();
  for(const order of purchaseOrders){
    if(order.deleted||!['ordered','partially received','partially-received','partially_received'].includes(order.status))continue;
    for(const line of order.lines||[]){
      const key=h.inventoryId(line.productId,line.variant||'');
      const outstanding=line.outstandingQuantity??(line.quantity-(line.acceptedQuantity||0)-(line.closedQuantity||0));
      const multiplier=line.unit==='case'?line.packSize:1;
      const value=validQuantity(outstanding)&&Number.isSafeInteger(multiplier)&&multiplier>0?outstanding*multiplier:null;
      if(value===null||!validQuantity(value)||inbound.get(key)===null)inbound.set(key,null);
      else inbound.set(key,known((inbound.get(key)||0)+value));
    }
  }
  return inbound;
}

function stockRows(products,inventory,purchaseOrders,suggestions,complete){
  const catalog=new Map(products.map(product=>[product.id,product]));
  const records=new Map(inventory.map(record=>[h.inventoryId(record.productId,record.variant||''),record]));
  const identities=new Map();
  for(const product of products){
    const variants=product.variants?.length?[...(product.standardVariantEnabled?['']:[]),...product.variants]:[''];
    for(const variant of variants)identities.set(h.inventoryId(product.id,variant),{productId:product.id,variant});
  }
  for(const record of inventory)identities.set(h.inventoryId(record.productId,record.variant||''),{productId:record.productId,variant:record.variant||''});
  const inbound=confirmedInbound(purchaseOrders);
  return [...identities].map(([id,item])=>{
    const record=records.get(id),product=catalog.get(item.productId),onHand=known(record?.onHand),reserved=record?.reserved==null?0:known(record.reserved);
    const availableEach=onHand===null||reserved===null?null:onHand-reserved,targetEach=known(record?.targetEach??record?.target),bin=typeof(record?.warehouseBin??record?.bin)==='string'?(record.warehouseBin??record.bin):'';
    const rows=suggestions.filter(row=>row.productId===item.productId&&(row.variant||'')===item.variant);
    const suggestion=rows.length===1?rows[0]:null;
    const confirmedInboundEach=complete?(inbound.has(id)?inbound.get(id):0):null;
    const warningCodes=[];
    if(onHand===null)warningCodes.push('UNKNOWN_STOCK');
    if(targetEach===null)warningCodes.push('TARGET_NOT_CONFIGURED');
    if(!complete)warningCodes.push('INCOMPLETE_HISTORY');
    if(!rows.length)warningCodes.push('SUPPLIER_MAPPING_REQUIRED');
    if(rows.length>1)warningCodes.push('CHOOSE_SUPPLIER_MAPPING');
    return {id,...item,name:product?.name||item.productId,sku:product?.sku||'',barcode:product?.variantBarcodes?.[item.variant]||product?.barcode||'',
      onHand,reserved,available:availableEach,availableEach,reorderPoint:known(record?.reorderPoint),target:targetEach,targetEach,bin,
      inboundEach:confirmedInboundEach,confirmedInboundEach,suggestedEach:complete&&onHand!==null&&suggestion?.eligible?suggestion.suggestedEach:null,
      suggestedQuantity:complete&&onHand!==null&&suggestion?.eligible?suggestion.suggestedQuantity:null,suggestedUnit:suggestion?.unit||null,
      warnings:warningCodes,missingInputs:suggestion?.missingInputs||[],version:record?.version||0,updatedAt:record?.updatedAt||null};
  });
}

function privateResponse(res){res.set({'Cache-Control':'private, no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff'});}
function queryLimit(query,maximum){
  if(Object.keys(query).some(key=>key!=='limit'))h.fail('INVALID_INPUT','The warehouse query contains unsupported fields.');
  return query.limit===undefined?maximum:h.integer(typeof query.limit==='string'&&/^\d+$/.test(query.limit)?Number(query.limit):NaN,'History limit',{min:1,max:maximum});
}
async function registerWarehouseRoutes(app,{repo,now=Date.now,purchasing,historyLimit=5000,renderPurchaseOrder}={}){
  h.integer(historyLimit,'Warehouse history limit',{min:1,max:10000});
  async function readBounded(collection,limit,options={}){
    const values=await repo.list(collection,{...options,limit:limit+1});
    return {rows:values.slice(0,limit).filter(row=>!row.deleted),truncated:values.length>limit};
  }
  app.get('/api/warehouse/state',async(req,res)=>{
    h.requireStaff(req.actor);privateResponse(res);
    const limit=queryLimit(req.query,historyLimit);
    const names=['products','inventory','supplierProducts','purchaseOrders','purchaseReceipts','warehouseMovements',...(req.actor.role==='master'?['suppliers']:[])];
    const pages=await Promise.all(names.map(name=>readBounded(name,limit,name==='warehouseMovements'?{orderBy:[['recordedAt','desc']]}:['purchaseOrders','purchaseReceipts'].includes(name)?{orderBy:[['createdAt','desc']]}:{})));
    const rows=Object.fromEntries(names.map((name,index)=>[name,pages[index].rows]));
    const truncatedCollections=names.filter((name,index)=>pages[index].truncated);
    const calculationComplete=!['products','inventory','supplierProducts','purchaseOrders'].some(name=>truncatedCollections.includes(name));
    const engine=purchasing||require('./purchasing.cjs');
    const computed=engine.suggestions({inventory:rows.inventory,supplierProducts:rows.supplierProducts,purchaseOrders:rows.purchaseOrders,now:now()});
    const suggestions=computed.map(projectSuggestion).map(row=>calculationComplete?row:{...row,eligible:false,suggestedEach:null,suggestedQuantity:null,missingInputs:[...new Set([...row.missingInputs,'INCOMPLETE_HISTORY'])]});
    const products=rows.products.map(projectProduct);
    res.json({me:fields(req.actor,['uid','role','name','displayName']),products,
      stock:stockRows(products,rows.inventory,rows.purchaseOrders,suggestions,calculationComplete),suggestions,
      suppliers:req.actor.role==='master'?rows.suppliers:[],supplierProducts:req.actor.role==='master'?rows.supplierProducts:[],
      purchaseOrders:rows.purchaseOrders.map(row=>projectPurchaseOrder(row,req.actor)),
      receipts:rows.purchaseReceipts.map(row=>projectPurchaseReceipt(row,req.actor)),movements:rows.warehouseMovements.map(row=>projectMovement(row,req.actor)),
      history:{complete:truncatedCollections.length===0,truncatedCollections,limit}});
  });
  app.get('/api/warehouse/purchase-orders/:id',async(req,res)=>{
    h.requireStaff(req.actor);privateResponse(res);
    const limit=queryLimit(req.query,historyLimit),order=await h.required(repo,'purchaseOrders',req.params.id,'Purchase order');
    const receipts=await readBounded('purchaseReceipts',limit,{where:[['purchaseOrderId','==',order.id]],orderBy:[['receivedAt','desc']]});
    res.json({purchaseOrder:projectPurchaseOrder(order,req.actor),receipts:receipts.rows.map(row=>projectPurchaseReceipt(row,req.actor)),history:{complete:!receipts.truncated,truncatedCollections:receipts.truncated?['purchaseReceipts']:[],limit}});
  });
  app.get('/api/warehouse/purchase-orders/:id/document',async(req,res)=>{
    h.requireMaster(req.actor);privateResponse(res);
    if(Object.keys(req.query).length)h.fail('INVALID_INPUT','The purchase document query contains unsupported fields.');
    const order=await h.required(repo,'purchaseOrders',req.params.id,'Purchase order');
    const render=renderPurchaseOrder||require('./purchase-document.cjs').renderPurchaseOrder;
    const data=await render(order);
    const reference=String(order.purchaseNumber||order.number||order.poNumber||order.purchaseOrderNumber||order.id).replace(/[^A-Za-z0-9._-]/g,'-').slice(0,100)||'purchase-order';
    res.type('application/pdf');res.set('Content-Disposition',`attachment; filename="${reference}.pdf"`);res.send(data);
  });
}

module.exports={registerWarehouseRoutes,projectPurchaseOrder,projectPurchaseReceipt,projectWarehouseCommand,projectProduct,stockRows};
