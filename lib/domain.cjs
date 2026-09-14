'use strict';
const {createHash, randomUUID} = require('node:crypto');

const MONEY_LIMIT = 1_000_000_000_000;
const QUANTITY_LIMIT = 1_000_000;
const ROLES = new Set(['master', 'salesman', 'customer']);
const COMMANDS = new Set(['product.save','category.save','store.save','order.save','order.submit','order.transition','payment.report','payment.verify','payment.allocate','inventory.adjust','return.create','return.approve','notification.read','preferences.save','migration.reconcile']);
class AppError extends Error {
  constructor(code, message, status=400) { super(message); this.name='AppError'; this.code=code; this.status=status; }
}
const fail=(code,message,status=400)=>{throw new AppError(code,message,status);};
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value||{},key);
function object(value,label='Value') {
  if (!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail('INVALID_INPUT',`${label} must be an object.`);
  return value;
}
function text(value,label,max=500,required=false) {
  if (value===undefined || value===null) value='';
  if (typeof value!=='string' || value.length>max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) fail('INVALID_INPUT',`${label} is invalid.`);
  const out=value.trim();
  if(required&&!out) fail('INVALID_INPUT',`${label} is required.`);
  return out;
}
function recordId(value,label='ID') {
  const out=text(value,label,200,true);
  if(out==='.'||out==='..'||out.includes('/')||out==='__proto__'||out==='constructor'||out==='prototype') fail('INVALID_INPUT',`${label} is invalid.`);
  return out;
}
function integer(value,label,{min=0,max=MONEY_LIMIT,nullable=false}={}) {
  if(nullable&&(value===null||value===undefined)) return null;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max) fail('INVALID_INPUT',`${label} must be a whole number between ${min} and ${max}.`);
  return value;
}
function money(value,label='Amount',options={}) {return integer(value,label,{max:MONEY_LIMIT,...options});}
function safeTotal(value) {return money(value,'Total',{min:-MONEY_LIMIT});}
function roundRatio(value,numerator,denominator) {
  return Number((BigInt(value)*BigInt(numerator)+BigInt(Math.floor(denominator/2)))/BigInt(denominator));
}
function bool(value,label,defaultValue=false) {
  if(value===undefined)return defaultValue;
  if(typeof value!=='boolean')fail('INVALID_INPUT',`${label} must be true or false.`);
  return value;
}
function stringArray(value,label,max=100) {
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>max)fail('INVALID_INPUT',`${label} is invalid.`);
  const values=value.map(v=>text(v,label,200,true));
  if(new Set(values).size!==values.length)fail('INVALID_INPUT',`${label} contains duplicates.`);
  return values;
}
function validateActor(actor) {
  if(!actor||typeof actor.uid!=='string'||!ROLES.has(actor.role)||actor.active===false||actor.status==='disabled')fail('UNAUTHENTICATED','An active account is required.',401);
  recordId(actor.uid,'User ID');
}
function requireStaff(actor) {validateActor(actor);if(actor.role==='customer')fail('FORBIDDEN','Staff access is required.',403);}
function requireMaster(actor) {validateActor(actor);if(actor.role!=='master')fail('FORBIDDEN','Owner access is required.',403);}
function authorizeStore(actor,storeId) {
  validateActor(actor);recordId(storeId,'Store ID');
  if(actor.role!=='master'&&(!Array.isArray(actor.storeIds)||!actor.storeIds.includes(storeId)))fail('FORBIDDEN','You do not have access to this store.',403);
  return true;
}
function versionGuard(previous,expectedVersion) {
  if(previous) {
    if(!Number.isInteger(expectedVersion)||expectedVersion!==(previous.version||1))fail('VERSION_CONFLICT','This record changed. Refresh it before saving again.',409);
  } else if(expectedVersion!==undefined&&expectedVersion!==null&&expectedVersion!==0)fail('VERSION_CONFLICT','This record no longer exists. Refresh before saving.',409);
}
function versioned(previous,fields,now,actor) {
  return {...previous,...fields,version:(previous?.version||0)+1,createdAt:previous?.createdAt??now,createdBy:previous?.createdBy||actor.uid,updatedAt:now,updatedBy:actor.uid};
}
async function required(tx,collection,id,label) {
  const value=await tx.get(collection,recordId(id,`${label} ID`));
  if(!value||value.deleted)fail('NOT_FOUND',`${label} was not found.`,404);
  return value;
}
function financialAccess(store) {
  if(store.migrationBlocked)fail('RECONCILIATION_REQUIRED','The owner must reconcile this store’s migrated balance before financial changes.',409);
}
function inventoryId(productId,variant='') {
  return `${encodeURIComponent(recordId(productId,'Product ID'))}~${encodeURIComponent(text(variant,'Variant',200))}`;
}
function storeBalance(ledger,storeId) {
  if(!Array.isArray(ledger))fail('INVALID_INPUT','Ledger must be an array.');
  return ledger.filter(row=>row.storeId===storeId&&!row.deleted).reduce((total,row)=>safeTotal(total+money(row.deltaCents,'Ledger balance change',{min:-MONEY_LIMIT})),0);
}
function variantFor(product,variant) {
  const out=text(variant,'Variant',200);
  const variants=Array.isArray(product.variants)?product.variants:[];
  if(variants.length?!variants.includes(out):out!=='')fail('INVALID_VARIANT',`Choose a valid variant for ${product.name||'this product'}.`);
  return out;
}
function draftLines(lines,{allowEmpty=true}={}) {
  if(!Array.isArray(lines)||lines.length>150||(!allowEmpty&&lines.length===0))fail('INVALID_INPUT','An order requires 1–150 lines.');
  const ids=new Set();
  return lines.map(line=>{
    object(line,'Order line');const id=recordId(line.id,'Line ID');
    if(ids.has(id))fail('INVALID_INPUT','Every order line must have a unique ID.');ids.add(id);
    const unit=line.unit??'each';if(!['each','case'].includes(unit))fail('INVALID_INPUT','Order unit must be each or case.');
    return {id,productId:recordId(line.productId,'Product ID'),variant:text(line.variant,'Variant',200),quantity:integer(line.quantity,'Quantity',{min:1,max:QUANTITY_LIMIT}),unit,note:text(line.note,'Line note',2000)};
  });
}
function priceFor(product,variant,store) {
  let price=product.priceCents;
  if(own(product.variantPricesCents,variant)&&product.variantPricesCents[variant]!==null)price=product.variantPricesCents[variant];
  if(own(store.priceOverrides,product.id)) {
    const override=store.priceOverrides[product.id];
    if(typeof override==='number')price=override;
    else if(override&&typeof override==='object') {
      if(override.priceCents!==null&&override.priceCents!==undefined)price=override.priceCents;
      if(own(override.variantPricesCents,variant)&&override.variantPricesCents[variant]!==null)price=override.variantPricesCents[variant];
    }
  }
  if(price===null||price===undefined)fail('PRICE_REQUIRED',`A price is required for ${product.name}${variant?' — '+variant:''}.`);
  return money(price,'Product price');
}
function calculateOrder(lines,products,store) {
  object(store,'Store');const normalized=draftLines(lines,{allowEmpty:false});
  const byId=products instanceof Map?products:new Map((Array.isArray(products)?products:Object.values(products||{})).map(p=>[p.id,p]));
  const taxRateBps=integer(store.taxRateBps??0,'Tax rate',{max:10000});
  const snapshots=normalized.map(line=>{
    const product=byId.get(line.productId);
    if(!product||product.deleted||product.active===false)fail('INVALID_PRODUCT','The order contains a product that is no longer available.');
    const variant=variantFor(product,line.variant);
    let packSize=product.packSize==null?null:integer(product.packSize,'Pack size',{min:1,max:QUANTITY_LIMIT});
    if(line.unit==='case'&&packSize===null)fail('PACK_SIZE_REQUIRED',`A case size is required for ${product.name}.`);
    const eachQuantity=integer(line.quantity*(line.unit==='case'?packSize:1),'Individual quantity',{min:1,max:1_000_000_000});
    const eachPriceCents=priceFor(product,variant,store);
    const unitPriceCents=money(eachPriceCents*(line.unit==='case'?packSize:1),'Unit price');
    const lineTotalCents=money(unitPriceCents*line.quantity,'Line total');
    const taxable=product.taxable!==false;
    const taxCents=taxable?money(roundRatio(lineTotalCents,taxRateBps,10000),'Line tax'):0;
    return {...line,name:text(product.name,'Product name',300,true),sku:text(product.sku||product.id,'SKU',200,true),barcode:text(product.variantBarcodes?.[variant]||product.barcode,'Barcode',200),variant,packSize,eachQuantity,eachPriceCents,unitPriceCents,lineTotalCents,taxable,taxRateBps:taxable?taxRateBps:0,taxCents};
  });
  const subtotalCents=money(snapshots.reduce((sum,line)=>sum+line.lineTotalCents,0),'Subtotal');
  const taxCents=money(snapshots.reduce((sum,line)=>sum+line.taxCents,0),'Tax');
  return {lines:snapshots,subtotalCents,taxCents,totalCents:money(subtotalCents+taxCents,'Invoice total'),taxRateBps};
}
function priceMap(value,label='Variant prices') {
  if(value===undefined||value===null)return {};
  object(value,label);if(Object.keys(value).length>200)fail('INVALID_INPUT',`${label} is too large.`);
  return Object.fromEntries(Object.entries(value).map(([key,price])=>[text(key,'Variant',200,true),money(price,label,{nullable:true})]));
}
function priceOverrides(value) {
  if(value===undefined||value===null)return {};
  object(value,'Store prices');if(Object.keys(value).length>2000)fail('INVALID_INPUT','Too many store prices.');
  return Object.fromEntries(Object.entries(value).map(([key,v])=>{
    recordId(key,'Product ID');
    if(typeof v==='number')return [key,money(v,'Store price')];
    object(v,'Store price');return [key,{priceCents:money(v.priceCents,'Store price',{nullable:true}),variantPricesCents:priceMap(v.variantPricesCents)}];
  }));
}
function imageUrl(value) {
  const out=text(value,'Image',2000);if(!out)return '';
  if(out.startsWith('/assets/')&&!out.includes('..')&&!/[\s\\]/.test(out))return out;
  try {const url=new URL(out);if(url.protocol==='https:'&&!url.username&&!url.password)return url.href;}catch{}
  fail('INVALID_INPUT','Use a local asset or an HTTPS image URL.');
}
function stableJson(value) {
  if(Array.isArray(value))return '['+value.map(stableJson).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>JSON.stringify(key)+':'+stableJson(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
function hash(value) {return createHash('sha256').update(value).digest('hex');}
function aggregateInventory(lines) {
  const groups=new Map();
  for(const line of lines) {
    const key=inventoryId(line.productId,line.variant);
    const entry=groups.get(key)||{id:key,productId:line.productId,variant:line.variant,quantity:0,reservedQuantity:0};
    entry.quantity=integer(entry.quantity+line.eachQuantity,'Stock quantity',{max:1_000_000_000});
    entry.reservedQuantity+=line.reservedQuantity||0;
    groups.set(key,entry);
  }
  return [...groups.values()];
}
function inventoryValues(record) {
  return {onHand:integer(record.onHand,'Inventory on hand',{nullable:true,max:1_000_000_000}),reserved:integer(record.reserved??0,'Reserved inventory',{max:1_000_000_000}),reorderPoint:integer(record.reorderPoint??0,'Reorder threshold',{max:1_000_000_000})};
}
async function reserveStock(tx,calculated,now,actor) {
  const known=new Set();const warnings=[];
  for(const group of aggregateInventory(calculated.lines)) {
    const record=await tx.get('inventory',group.id);
    if(!record||record.onHand===null||record.onHand===undefined){warnings.push({productId:group.productId,variant:group.variant,code:'UNKNOWN_STOCK'});continue;}
    const values=inventoryValues(record);
    if(values.onHand-values.reserved<group.quantity)fail('INSUFFICIENT_STOCK',`Not enough available stock for ${group.productId}${group.variant?' — '+group.variant:''}.`,409);
    await tx.set('inventory',group.id,versioned(record,{...values,reserved:values.reserved+group.quantity},now,actor));known.add(group.id);
  }
  return {lines:calculated.lines.map(line=>({...line,reservedQuantity:known.has(inventoryId(line.productId,line.variant))?line.eachQuantity:0,stockTracked:known.has(inventoryId(line.productId,line.variant))})),inventoryWarnings:warnings};
}
async function releaseOrDeliver(tx,order,deliver,now,actor) {
  const warnings=[];
  for(const group of aggregateInventory(order.lines)) {
    const record=await tx.get('inventory',group.id);
    if(!record||record.onHand===null||record.onHand===undefined){
      if(group.reservedQuantity>0)fail('INVENTORY_CONFLICT','Reserved inventory is missing. Reconcile stock before proceeding.',409);
      if(deliver)warnings.push({productId:group.productId,variant:group.variant,code:'DELIVERED_WITH_UNKNOWN_STOCK'});
      continue;
    }
    const values=inventoryValues(record);
    if(values.reserved<group.reservedQuantity)fail('INVENTORY_CONFLICT','The stock reservation changed. Reconcile stock before proceeding.',409);
    if(deliver&&values.onHand-(values.reserved-group.reservedQuantity)<group.quantity)fail('INSUFFICIENT_STOCK','Available stock cannot fulfill this delivery.',409);
    await tx.set('inventory',group.id,versioned(record,{...values,onHand:values.onHand-(deliver?group.quantity:0),reserved:values.reserved-group.reservedQuantity},now,actor));
  }
  return warnings;
}
async function notify(tx,{storeId=null,userId=null,type,message,recordId:targetId=null},context) {
  const id=context.id();
  await tx.set('notifications',id,{id,storeId,userId,type,message,recordId:targetId,readBy:[],createdAt:context.now,version:1});
}
async function postLedger(tx,{id,storeId,type,deltaCents,referenceId,note},context) {
  const previous=await tx.get('ledger',id);
  if(previous) {
    if(previous.storeId!==storeId||previous.deltaCents!==deltaCents||previous.type!==type)fail('LEDGER_CONFLICT','This transaction already exists with different financial details.',409);
    return previous;
  }
  const row={id,storeId,type,deltaCents:safeTotal(deltaCents),amountCents:Math.abs(deltaCents),referenceId,note:note||'',createdAt:context.now,createdBy:context.actor.uid,version:1};
  await tx.set('ledger',id,row);return row;
}

function requireAllocatable(order) {
  if(!['submitted','approved','picking','delivered'].includes(order.status)||!order.invoiceNumber||order.legacy?.needsPriceReview||!Number.isSafeInteger(order.totalCents)||order.totalCents<0)fail('INVOICE_NOT_ALLOCATABLE','Payments can be assigned only to submitted invoices with confirmed original prices.',409);
}
function invoiceAmounts(order,payments,returns,{excludePaymentId=null}={}) {
  const totalCents=money(order.totalCents,'Invoice total');
  const creditedCents=order.status==='cancelled'?totalCents:money(returns.filter(r=>r.orderId===order.id&&r.status==='approved').reduce((sum,r)=>sum+money(r.totalCents,'Approved return amount'),0),'Invoice credits');
  if(creditedCents>totalCents)fail('INVOICE_CREDIT_CONFLICT','Approved credits exceed the original invoice. Reconcile this invoice.',409);
  const paidCents=money(payments.filter(p=>p.status==='verified'&&p.storeId===order.storeId&&p.id!==excludePaymentId).reduce((sum,p)=>sum+(p.allocations||[]).filter(a=>a.orderId===order.id).reduce((allocated,a)=>allocated+money(a.amountCents,'Allocated payment',{min:1}),0),0),'Allocated invoice payments');
  const netTotalCents=totalCents-creditedCents,amountDueCents=Math.max(0,netTotalCents-paidCents),creditBalanceCents=Math.max(0,paidCents-netTotalCents);
  const paymentStatus=creditBalanceCents>0?'credit':order.status==='cancelled'?'cancelled':amountDueCents===0?(creditedCents>0&&paidCents===0?'credited':'paid'):paidCents>0?'partial':'unpaid';
  return {paidCents,creditedCents,netTotalCents,amountDueCents,creditBalanceCents,paymentStatus};
}
async function refreshInvoiceAmounts(tx,order,context) {
  const figures=invoiceAmounts(order,await tx.list('payments'),await tx.list('returns'));
  if(Object.entries(figures).every(([key,value])=>order[key]===value))return order;
  const result=versioned(order,figures,context.now,context.actor);await tx.set('orders',order.id,result);return result;
}
function normalizeAllocations(input) {
  if(!Array.isArray(input)||input.length>100)fail('INVALID_INPUT','Specify up to 100 invoice allocations.');
  const seen=new Set();return input.map(raw=>{
    object(raw,'Allocation');const orderId=recordId(raw.orderId,'Order ID');if(seen.has(orderId))fail('INVALID_INPUT','An invoice can appear only once in an allocation list.');seen.add(orderId);
    return {orderId,amountCents:money(raw.amountCents,'Allocated amount',{min:1})};
  });
}

async function executeCommand(tx,actor,command,{now=Date.now(),id=randomUUID}={}) {
  validateActor(actor);object(command,'Command');const commandId=recordId(command.id,'Command ID');
  if(!COMMANDS.has(command.type))fail('INVALID_COMMAND','This command is not supported.');
  const payload=object(command.payload??{},'Payload');
  integer(now,'Timestamp',{max:Number.MAX_SAFE_INTEGER});
  if(['product.save','category.save','store.save','migration.reconcile'].includes(command.type))requireMaster(actor);
  if(['payment.verify','payment.allocate','inventory.adjust','return.approve'].includes(command.type))requireStaff(actor);
  const receiptId=hash(actor.uid+'\n'+commandId),fingerprint=hash(stableJson({type:command.type,payload}));
  const receipt=await tx.get('commandReceipts',receiptId);
  if(receipt) {
    if(receipt.fingerprint!==fingerprint)fail('COMMAND_CONFLICT','This command ID was already used for different changes.',409);
    if(receipt.result?.storeId)authorizeStore(actor,receipt.result.storeId);
    return receipt.result;
  }
  const context={now,id,actor};let result;let auditDetails=null;
  if(command.type==='category.save') {
    const categoryId=payload.id?recordId(payload.id):id();const previous=await tx.get('categories',categoryId);versionGuard(previous,payload.expectedVersion);
    result=versioned(previous,{id:categoryId,name:text(payload.name??previous?.name,'Category name',150,true),sortOrder:integer(payload.sortOrder??previous?.sortOrder??0,'Sort order',{max:100000}),active:bool(payload.active,'Active',previous?.active!==false)},now,actor);
    await tx.set('categories',categoryId,result);
  } else if(command.type==='product.save') {
    const productId=payload.id?recordId(payload.id):id();const previous=await tx.get('products',productId);versionGuard(previous,payload.expectedVersion);const value={...previous,...payload};
    const categoryIds=stringArray(value.categoryIds,'Categories');for(const categoryId of categoryIds)await required(tx,'categories',categoryId,'Category');
    const variants=stringArray(value.variants,'Variants',200),variantPricesCents=priceMap(value.variantPricesCents);
    for(const variant of Object.keys(variantPricesCents))if(!variants.includes(variant))fail('INVALID_VARIANT','A price names an unknown variant.');
    object(value.variantBarcodes??{},'Variant barcodes');const variantBarcodes={};
    for(const [variant,barcode] of Object.entries(value.variantBarcodes??{})){if(!variants.includes(variant))fail('INVALID_VARIANT','A barcode names an unknown variant.');Object.defineProperty(variantBarcodes,variant,{value:text(barcode,'Barcode',200),enumerable:true,writable:true,configurable:true});}
    result=versioned(previous,{id:productId,name:text(value.name,'Product name',300,true),sku:text(value.sku,'SKU',200),categoryIds,variants,priceCents:money(value.priceCents,'Product price',{nullable:true}),variantPricesCents,packSize:integer(value.packSize,'Case size',{nullable:true,min:1,max:QUANTITY_LIMIT}),barcode:text(value.barcode,'Barcode',200),variantBarcodes,taxable:bool(value.taxable,'Taxable',true),stockStatus:text(value.stockStatus,'Stock status',100),image:imageUrl(value.image),active:bool(value.active,'Active',true)},now,actor);
    await tx.set('products',productId,result);
  } else if(command.type==='store.save') {
    const storeId=payload.id?recordId(payload.id):id();const previous=await tx.get('stores',storeId);versionGuard(previous,payload.expectedVersion);const value={...previous,...payload};
    result=versioned(previous,{id:storeId,name:text(value.name,'Store name',300,true),address:text(value.address,'Address',1000),county:text(value.county,'County',200),contact:text(value.contact,'Contact',300),phone:text(value.phone,'Phone',100),email:text(value.email,'Email',320),taxRateBps:integer(value.taxRateBps??0,'Tax rate',{max:10000}),creditLimitCents:money(value.creditLimitCents,'Credit limit',{nullable:true}),terms:text(value.terms,'Payment terms',300),salesmanId:value.salesmanId?recordId(value.salesmanId,'Salesman ID'):null,priceOverrides:priceOverrides(value.priceOverrides),active:bool(value.active,'Active',true)},now,actor);
    await tx.set('stores',storeId,result);
  } else if(command.type==='order.save') {
    const orderId=recordId(payload.id,'Order ID');const previous=await tx.get('orders',orderId);
    if(previous) {
      authorizeStore(actor,previous.storeId);
      if(actor.role==='customer'&&previous.createdBy!==actor.uid)fail('FORBIDDEN','Only the creator can edit this draft.',403);
      if(previous.status!=='draft')fail('INVALID_TRANSITION','Submitted orders cannot be edited. Create a new draft or a return.',409);
      if(payload.storeId!==undefined&&payload.storeId!==previous.storeId)fail('INVALID_INPUT','A saved order cannot move between stores.');
    }
    const storeId=recordId(payload.storeId??previous?.storeId,'Store ID');authorizeStore(actor,storeId);const store=await required(tx,'stores',storeId,'Store');if(store.active===false)fail('INVALID_INPUT','This store is inactive.');
    versionGuard(previous,payload.expectedVersion);const lines=draftLines(payload.lines??previous?.lines??[]);
    for(const line of lines)variantFor(await required(tx,'products',line.productId,'Product'),line.variant);
    const review=previous?.legacy&&(previous.legacy.requiresReview||previous.migrationBlocked)&&payload.acknowledgeLegacyReview===true
      ? {legacy:{...previous.legacy,requiresReview:false,reviewedAt:now,reviewedBy:actor.uid},migrationBlocked:false}:{};
    result=versioned(previous,{id:orderId,storeId,storeName:store.name,lines,notes:text(payload.notes??previous?.notes,'Order notes',10000),status:'draft',...review},now,actor);
    await tx.set('orders',orderId,result);
  } else if(command.type==='order.submit') {
    const previous=await required(tx,'orders',payload.id,'Order');authorizeStore(actor,previous.storeId);
    if(actor.role==='customer'&&previous.createdBy!==actor.uid)fail('FORBIDDEN','Only the creator can submit this draft.',403);
    if(previous.status!=='draft') {
      if(['submitted','approved','picking','delivered'].includes(previous.status)&&previous.invoiceNumber)result=previous;
      else fail('INVALID_TRANSITION','This order cannot be submitted.',409);
    } else {
      versionGuard(previous,payload.expectedVersion);
      if(previous.legacy?.requiresReview||previous.migrationBlocked)fail('LEGACY_REVIEW_REQUIRED','Review the recovered draft and confirm its products and quantities before submitting.',409);
      const store=await required(tx,'stores',previous.storeId,'Store');financialAccess(store);if(store.active===false)fail('INVALID_INPUT','This store is inactive.');
      const products=[];for(const productId of new Set(previous.lines.map(line=>line.productId)))products.push(await required(tx,'products',productId,'Product'));
      const calculated=calculateOrder(previous.lines,products,store);
      if(own(payload,'expectedTotalCents')&&money(payload.expectedTotalCents,'Reviewed order total')!==calculated.totalCents)fail('PRICE_CHANGED','Prices changed since this order was reviewed. Review the updated total before submitting.',409);
      const balance=storeBalance(await tx.list('ledger'),store.id);
      if(store.creditLimitCents!==null&&store.creditLimitCents!==undefined&&safeTotal(balance+calculated.totalCents)>money(store.creditLimitCents,'Credit limit'))fail('CREDIT_LIMIT','This order exceeds the store’s credit limit. Verify a payment or have the owner update the limit.',409);
      const reservation=await reserveStock(tx,calculated,now,actor);
      const year=new Date(now).getUTCFullYear();const counterId='invoices-'+year;const counter=await tx.get('counters',counterId);const sequence=integer((counter?.value||0)+1,'Invoice sequence',{min:1,max:999999999});
      await tx.set('counters',counterId,{id:counterId,value:sequence,version:(counter?.version||0)+1});
      const invoiceNumber=`AW-${year}-${String(sequence).padStart(6,'0')}`;
      result=versioned(previous,{...calculated,...reservation,...invoiceAmounts({...previous,totalCents:calculated.totalCents,status:'submitted'},[],[]),status:'submitted',invoiceNumber,submittedAt:now,submittedBy:actor.uid,storeSnapshot:{id:store.id,name:store.name,address:store.address||'',contact:store.contact||'',phone:store.phone||'',email:store.email||'',terms:store.terms||'',salesmanId:store.salesmanId||null},statusHistory:[...(previous.statusHistory||[]),{status:'submitted',at:now,by:actor.uid}]},now,actor);
      await postLedger(tx,{id:'charge-'+previous.id,storeId:store.id,type:'charge',deltaCents:result.totalCents,referenceId:previous.id,note:invoiceNumber},context);
      await tx.set('orders',previous.id,result);
      await notify(tx,{storeId:store.id,type:'order.submitted',message:`Order ${invoiceNumber} submitted.`,recordId:previous.id},context);
    }
  } else if(command.type==='order.transition') {
    const previous=await required(tx,'orders',payload.id,'Order');authorizeStore(actor,previous.storeId);const status=text(payload.status,'Status',40,true);
    if(actor.role==='customer'&&(status!=='cancelled'||!['draft','submitted','cancelled'].includes(previous.status)||previous.createdBy!==actor.uid))fail('FORBIDDEN','Staff must make this order status change.',403);
    if(status===previous.status)result=previous;
    else {
      versionGuard(previous,payload.expectedVersion);
      const allowed={draft:['cancelled'],submitted:['approved','cancelled'],approved:['picking','cancelled'],picking:['delivered','cancelled'],delivered:[],cancelled:[]};
      if(!allowed[previous.status]?.includes(status))fail('INVALID_TRANSITION',`Cannot move an order from ${previous.status} to ${status}.`,409);
      const store=await required(tx,'stores',previous.storeId,'Store');
      if(status==='cancelled'&&previous.invoiceNumber)financialAccess(store);
      let inventoryWarnings=previous.inventoryWarnings||[];
      if(status==='cancelled'&&previous.status!=='draft') {
        await releaseOrDeliver(tx,previous,false,now,actor);
        await postLedger(tx,{id:'cancel-'+previous.id,storeId:store.id,type:'cancellation',deltaCents:-money(previous.totalCents,'Order total'),referenceId:previous.id,note:`Cancelled ${previous.invoiceNumber}`},context);
      }
      if(status==='delivered')inventoryWarnings=await releaseOrDeliver(tx,previous,true,now,actor);
      result=versioned(previous,{status,inventoryWarnings,statusHistory:[...(previous.statusHistory||[]),{status,at:now,by:actor.uid}],...(status==='delivered'?{deliveredAt:now,deliveredBy:actor.uid}:{}),...(status==='cancelled'?{cancelledAt:now,cancelledBy:actor.uid}:{})},now,actor);
      if(status==='cancelled'&&previous.invoiceNumber)Object.assign(result,invoiceAmounts(result,await tx.list('payments'),await tx.list('returns')));
      await tx.set('orders',previous.id,result);
      await notify(tx,{storeId:store.id,type:'order.'+status,message:`Order ${previous.invoiceNumber||previous.id} ${status}.`,recordId:previous.id},context);
    }
  } else if(command.type==='payment.report') {
    const storeId=recordId(payload.storeId,'Store ID');authorizeStore(actor,storeId);await required(tx,'stores',storeId,'Store');
    const orderId=payload.orderId?recordId(payload.orderId,'Order ID'):null;
    if(orderId){const order=await required(tx,'orders',orderId,'Order');authorizeStore(actor,order.storeId);if(order.storeId!==storeId)fail('FORBIDDEN','The invoice belongs to a different store.',403);requireAllocatable(order);}
    const paymentId=id();result=versioned(null,{id:paymentId,storeId,orderId,allocations:[],allocatedCents:0,unallocatedCents:0,amountCents:money(payload.amountCents,'Payment amount',{min:1}),method:text(payload.method,'Payment method',100)||'unspecified',reference:text(payload.reference,'Payment reference',500),note:text(payload.note,'Payment note',2000),status:'pending',reportedBy:actor.uid,reportedAt:now},now,actor);
    await tx.set('payments',paymentId,result);await notify(tx,{storeId,type:'payment.pending',message:'A payment is awaiting staff verification.',recordId:paymentId},context);
  } else if(command.type==='payment.verify') {
    const previous=await required(tx,'payments',payload.paymentId,'Payment');authorizeStore(actor,previous.storeId);
    if(previous.status==='verified')result=previous;
    else {
      if(previous.status!=='pending')fail('INVALID_TRANSITION','This payment cannot be verified.',409);
      const store=await required(tx,'stores',previous.storeId,'Store');financialAccess(store);
      if(payload.expectedVersion!==undefined)versionGuard(previous,payload.expectedVersion);
      await postLedger(tx,{id:'payment-'+previous.id,storeId:store.id,type:'payment',deltaCents:-money(previous.amountCents,'Payment amount',{min:1}),referenceId:previous.id,note:previous.reference||previous.method},context);
      let allocations=[],allocationWarning=null,targetOrder=null;
      if(previous.orderId){
        targetOrder=await required(tx,'orders',previous.orderId,'Order');authorizeStore(actor,targetOrder.storeId);if(targetOrder.storeId!==store.id)fail('FORBIDDEN','The invoice belongs to a different store.',403);
        if(targetOrder.status==='cancelled')allocationWarning='TARGET_CANCELLED';
        else {requireAllocatable(targetOrder);const figures=invoiceAmounts(targetOrder,await tx.list('payments'),await tx.list('returns'));const allocated=Math.min(previous.amountCents,figures.amountDueCents);if(allocated>0)allocations=[{orderId:targetOrder.id,amountCents:allocated}];}
      }
      const allocatedCents=allocations.reduce((sum,a)=>sum+a.amountCents,0);
      result=versioned(previous,{status:'verified',verifiedBy:actor.uid,verifiedAt:now,allocations,allocatedCents,unallocatedCents:previous.amountCents-allocatedCents,allocationWarning},now,actor);await tx.set('payments',previous.id,result);
      if(targetOrder&&allocations.length)await refreshInvoiceAmounts(tx,targetOrder,context);
      await notify(tx,{storeId:store.id,type:'payment.verified',message:'Your payment has been verified and credited.',recordId:previous.id},context);
    }
  } else if(command.type==='payment.allocate') {
    const previous=await required(tx,'payments',payload.paymentId,'Payment');authorizeStore(actor,previous.storeId);
    if(previous.status!=='verified')fail('INVALID_TRANSITION','Only verified payments can be allocated to invoices.',409);
    versionGuard(previous,payload.expectedVersion);const store=await required(tx,'stores',previous.storeId,'Store');financialAccess(store);
    const allocations=normalizeAllocations(payload.allocations),allocatedCents=money(allocations.reduce((sum,a)=>sum+a.amountCents,0),'Total allocations');
    if(allocatedCents>money(previous.amountCents,'Payment amount',{min:1}))fail('ALLOCATION_LIMIT','Allocations exceed this verified payment.',409);
    const payments=await tx.list('payments'),returns=await tx.list('returns'),affected=new Map();
    for(const allocation of allocations){
      const order=await required(tx,'orders',allocation.orderId,'Order');authorizeStore(actor,order.storeId);if(order.storeId!==store.id)fail('FORBIDDEN','The invoice belongs to a different store.',403);requireAllocatable(order);
      const figures=invoiceAmounts(order,payments,returns,{excludePaymentId:previous.id});if(allocation.amountCents>figures.amountDueCents)fail('ALLOCATION_LIMIT',`Allocation exceeds the remaining amount due for ${order.invoiceNumber}.`,409);affected.set(order.id,order);
    }
    for(const allocation of previous.allocations||[]){if(!affected.has(allocation.orderId)){const order=await required(tx,'orders',allocation.orderId,'Order');authorizeStore(actor,order.storeId);if(order.storeId!==store.id)fail('FORBIDDEN','The invoice belongs to a different store.',403);affected.set(order.id,order);}}
    auditDetails={before:previous.allocations||[],after:allocations};
    result=versioned(previous,{allocations,allocatedCents,unallocatedCents:previous.amountCents-allocatedCents,allocationWarning:null,allocatedAt:now,allocatedBy:actor.uid},now,actor);await tx.set('payments',previous.id,result);
    for(const order of affected.values())await refreshInvoiceAmounts(tx,order,context);
    await notify(tx,{storeId:store.id,type:'payment.allocated',message:'Verified payment allocations were updated.',recordId:previous.id},context);
  } else if(command.type==='inventory.adjust') {
    const product=await required(tx,'products',payload.productId,'Product');const variant=variantFor(product,payload.variant);const key=inventoryId(product.id,variant);const previous=await tx.get('inventory',key);versionGuard(previous,payload.expectedVersion);
    const reason=text(payload.reason,'Adjustment reason',2000,true);const onHand=integer(payload.onHand,'Stock on hand',{max:1_000_000_000});const reserved=previous?.reserved||0;
    if(onHand<reserved)fail('RESERVED_STOCK','Stock cannot be lower than the quantity reserved by open orders.',409);
    result=versioned(previous,{id:key,productId:product.id,variant,onHand,reserved,reorderPoint:integer(payload.reorderPoint??previous?.reorderPoint??0,'Reorder threshold',{max:1_000_000_000}),lastAdjustmentReason:reason},now,actor);
    await tx.set('inventory',key,result);
    if(onHand-reserved<=result.reorderPoint)await notify(tx,{type:'inventory.low',message:`Low stock: ${product.name}${variant?' — '+variant:''}.`,recordId:key},context);
  } else if(command.type==='return.create') {
    const order=await required(tx,'orders',payload.orderId,'Order');authorizeStore(actor,order.storeId);
    if(order.status!=='delivered'||order.legacy?.needsPriceReview)fail('INVALID_TRANSITION','Returns require a delivered order with confirmed prices.',409);
    if(!Array.isArray(payload.lines)||payload.lines.length===0||payload.lines.length>150)fail('INVALID_INPUT','Choose at least one return line.');
    const existing=(await tx.list('returns')).filter(r=>r.orderId===order.id&&['pending','approved'].includes(r.status));
    const seen=new Set();
    for(const input of payload.lines){object(input,'Return line');const lineId=recordId(input.lineId,'Line ID');if(seen.has(lineId))fail('INVALID_INPUT','Each return line must be unique.');seen.add(lineId);}
    const lines=payload.lines.map(input=>{
      const lineId=input.lineId;
      const original=order.lines.find(l=>l.id===lineId);if(!original)fail('INVALID_INPUT','This line is not part of the order.');
      const quantity=integer(input.quantity,'Return quantity',{min:1,max:QUANTITY_LIMIT});const already=existing.reduce((sum,r)=>sum+r.lines.filter(l=>l.lineId===lineId).reduce((s,l)=>s+l.quantity,0),0);
      if(quantity+already>original.quantity)fail('RETURN_QUANTITY','Returned quantities cannot exceed the delivered quantities.',409);
      const subtotalCents=money(original.unitPriceCents*quantity,'Return subtotal');
      const taxCents=roundRatio(original.taxCents,already+quantity,original.quantity)-roundRatio(original.taxCents,already,original.quantity);
      return {lineId,productId:original.productId,variant:original.variant,name:original.name,sku:original.sku,quantity,unit:original.unit,packSize:original.packSize,eachQuantity:quantity*(original.unit==='case'?original.packSize:1),unitPriceCents:original.unitPriceCents,subtotalCents,taxCents,totalCents:money(subtotalCents+taxCents,'Return amount')};
    });
    const returnId=id();result=versioned(null,{id:returnId,orderId:order.id,storeId:order.storeId,invoiceNumber:order.invoiceNumber,storeSnapshot:order.storeSnapshot||null,lines,reason:text(payload.reason,'Return reason',2000,true),subtotalCents:money(lines.reduce((s,l)=>s+l.subtotalCents,0)),taxCents:money(lines.reduce((s,l)=>s+l.taxCents,0)),totalCents:money(lines.reduce((s,l)=>s+l.totalCents,0)),status:'pending'},now,actor);
    await tx.set('returns',returnId,result);await notify(tx,{storeId:order.storeId,type:'return.pending',message:`A return for ${order.invoiceNumber} needs approval.`,recordId:returnId},context);
  } else if(command.type==='return.approve') {
    const previous=await required(tx,'returns',payload.returnId,'Return');authorizeStore(actor,previous.storeId);const restock=bool(payload.restock,'Restock');
    if(previous.status==='approved') {
      if(previous.restock!==restock)fail('COMMAND_CONFLICT','This return was already approved with a different restocking decision.',409);
      result=previous;
    } else {
      if(previous.status!=='pending')fail('INVALID_TRANSITION','This return cannot be approved.',409);
      const store=await required(tx,'stores',previous.storeId,'Store');financialAccess(store);if(payload.expectedVersion!==undefined)versionGuard(previous,payload.expectedVersion);
      const order=await required(tx,'orders',previous.orderId,'Order');if(order.status!=='delivered')fail('INVALID_TRANSITION','The order must have been delivered.',409);
      const all=(await tx.list('returns')).filter(r=>r.orderId===order.id&&['pending','approved'].includes(r.status));
      for(const line of order.lines)if(all.reduce((sum,r)=>sum+r.lines.filter(l=>l.lineId===line.id).reduce((s,l)=>s+l.quantity,0),0)>line.quantity)fail('RETURN_QUANTITY','Return quantities exceed the delivered quantities.',409);
      const restockWarnings=[];
      if(restock)for(const group of aggregateInventory(previous.lines)) {
        const record=await tx.get('inventory',group.id);
        if(!record||record.onHand===null||record.onHand===undefined){restockWarnings.push({productId:group.productId,variant:group.variant,code:'RESTOCK_UNKNOWN_BASELINE',quantity:group.quantity});continue;}
        const values=inventoryValues(record);await tx.set('inventory',group.id,versioned(record,{...values,onHand:integer(values.onHand+group.quantity,'Stock on hand',{max:1_000_000_000})},now,actor));
      }
      await postLedger(tx,{id:'return-'+previous.id,storeId:store.id,type:'credit',deltaCents:-money(previous.totalCents,'Return amount'),referenceId:previous.id,note:`Return for ${previous.invoiceNumber}`},context);
      result=versioned(previous,{status:'approved',approvedAt:now,approvedBy:actor.uid,restock,restockWarnings,creditMemoNumber:`CM-${previous.invoiceNumber}-${previous.id.slice(-8)}`},now,actor);await tx.set('returns',previous.id,result);
      await refreshInvoiceAmounts(tx,order,context);
      await notify(tx,{storeId:store.id,type:'return.approved',message:`Your return for ${previous.invoiceNumber} was approved and credited.`,recordId:previous.id},context);
    }
  } else if(command.type==='notification.read') {
    const previous=await required(tx,'notifications',payload.id,'Notification');
    if(previous.userId&&previous.userId!==actor.uid)fail('FORBIDDEN','This notification belongs to another user.',403);
    if(previous.storeId)authorizeStore(actor,previous.storeId);else if(!previous.userId)requireStaff(actor);
    result={...previous,readBy:[...new Set([...(previous.readBy||[]),actor.uid])],version:(previous.version||0)+1};await tx.set('notifications',previous.id,result);
  } else if(command.type==='preferences.save') {
    const previous=await tx.get('preferences',actor.uid);versionGuard(previous,payload.expectedVersion);
    const theme=payload.theme??previous?.theme??'system';if(!['light','dark','system'].includes(theme))fail('INVALID_INPUT','Choose light, dark or system theme.');
    const favorites={};for(const [storeId,products] of Object.entries(object(payload.favorites??previous?.favorites??{},'Favorites'))){authorizeStore(actor,storeId);favorites[storeId]=stringArray(products,'Favorite products',2000).map(p=>recordId(p,'Product ID'));}
    const notificationPreferences=object(payload.notificationPreferences??previous?.notificationPreferences??{},'Notification preferences');
    const templates=payload.templates??previous?.templates??[];if(!Array.isArray(templates)||templates.length>100)fail('INVALID_INPUT','Too many templates.');
    const emailEnabled=bool(notificationPreferences.email,'Email notifications',false);
    const emailEnabledAt=emailEnabled?(previous?.notificationPreferences?.email===true?previous.notificationPreferences.emailEnabledAt??now:now):null;
    const safeTemplates=templates.map(t=>{object(t,'Template');return {id:recordId(t.id,'Template ID'),name:text(t.name,'Template name',200,true),text:text(t.text,'Template text',10000)};});
    result=versioned(previous,{id:actor.uid,uid:actor.uid,theme,favorites,notificationPreferences:{inApp:bool(notificationPreferences.inApp,'In-app notifications',true),email:emailEnabled,emailEnabledAt},templates:safeTemplates},now,actor);await tx.set('preferences',actor.uid,result);
  } else if(command.type==='migration.reconcile') {
    const store=await required(tx,'stores',payload.storeId,'Store');versionGuard(store,payload.expectedVersion);
    const target=money(payload.openingBalanceCents,'Reconciled balance',{min:-MONEY_LIMIT}),reason=text(payload.reason,'Reconciliation reason',4000,true),current=storeBalance(await tx.list('ledger'),store.id);
    const adjustment=safeTotal(target-current);const adjustmentId='reconciliation-'+id();
    await postLedger(tx,{id:adjustmentId,storeId:store.id,type:'reconciliation',deltaCents:adjustment,referenceId:store.id,note:reason},context);
    result=versioned(store,{migrationBlocked:false,reconciliation:{at:now,by:actor.uid,reason,previousBalanceCents:current,balanceCents:target,ledgerId:adjustmentId,negativePaymentReview:'owner-reconciled'}},now,actor);await tx.set('stores',store.id,result);
    await notify(tx,{storeId:store.id,type:'migration.reconciled',message:'The owner reconciled the migrated account balance.',recordId:adjustmentId},context);
  }
  const auditId=id();
  await tx.set('audit',auditId,{id:auditId,commandId,type:command.type,actorUid:actor.uid,actorRole:actor.role,storeId:result?.storeId||(command.type==='store.save'||command.type==='migration.reconcile'?result?.id:null)||null,recordId:result?.id||null,at:now,createdAt:now,version:result?.version||null,details:auditDetails});
  await tx.set('commandReceipts',receiptId,{id:receiptId,commandId,actorUid:actor.uid,fingerprint,type:command.type,result,createdAt:now});
  return result;
}
module.exports={AppError,executeCommand,authorizeStore,calculateOrder,inventoryId,storeBalance,MONEY_LIMIT};
