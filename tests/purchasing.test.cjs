'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {MemoryRepository}=require('../lib/repository.cjs'),{helpers:h}=require('../lib/domain.cjs');
const purchasing=require('../lib/purchasing.cjs');
const owner={uid:'owner',role:'master'},staff={uid:'rep',role:'salesman',storeIds:['s1']},customer={uid:'buyer',role:'customer',storeIds:['s1']};
const NOW=Date.UTC(2026,8,28,12),DAY=86400000;
function fixture(extra={}) {
  const repo=new MemoryRepository({products:[{id:'p1',name:'Drink',variants:['Orange','Lime'],packSize:12,active:true}],inventory:[{id:h.inventoryId('p1','Orange'),productId:'p1',variant:'Orange',onHand:20,reserved:5,targetEach:200,reorderPoint:30,version:1}],suppliers:[{id:'s1',name:'Supplier',email:'orders@example.test',terms:'Net 30',active:true,version:1}],supplierProducts:[{id:'m1',supplierId:'s1',productId:'p1',variant:'Orange',supplierSku:'SUP-CASE',unit:'case',packSize:12,orderMultiple:1,unitCostCents:1200,leadTimeDays:3,active:true,version:1}],...extra});
  let sequence=0;const context={now:NOW,id:()=>`generated-${++sequence}`,actor:owner};
  const run=(type,payload,actor=owner,commandId=`cmd-${++sequence}`)=>repo.transaction(tx=>{purchasing.authorize(actor,type,payload,h);return purchasing.execute(tx,actor,{id:commandId,type,payload},{...context,actor},h);});
  return {repo,run};
}
async function ordered(f,{quantity=10,id='po1'}={}) {const po=await f.run('purchase.save',{id,supplierId:'s1',expectedDeliveryAt:NOW+3*DAY,lines:[{id:'line1',supplierProductId:'m1',quantity}]});return f.run('purchase.order',{id:po.id,expectedVersion:po.version});}
const receipt=(po,acceptedQuantity,rejectedQuantity=0,extra={})=>({id:po.id,expectedVersion:po.version,lines:[{lineId:'line1',acceptedQuantity,rejectedQuantity,...(rejectedQuantity?{rejectedDisposition:'replacement'}:{})}],...extra});
test('supplier maintenance and committed purchasing are owner-only while all warehouse mutations reject customers',async()=>{
  const f=fixture();
  for(const type of ['supplier.save','supplierProduct.save','purchase.save','purchase.order','purchase.amend','purchase.close'])await assert.rejects(()=>f.run(type,{},staff),{code:'FORBIDDEN'});
  for(const type of purchasing.commands)await assert.rejects(()=>f.run(type,{},customer),{code:'FORBIDDEN'});
});
test('private supplier mapping snapshots explicit packs and costs without putting them in catalog products',async()=>{
  const f=fixture();const result=await f.run('supplierProduct.save',{id:'m2',supplierId:'s1',productId:'p1',variant:'Lime',supplierSku:'LIME-SUP',unit:'case',packSize:24,orderMultiple:2,unitCostCents:1800,leadTimeDays:5});
  assert.equal(result.packSize,24);assert.equal(result.unitCostCents,1800);assert.equal((await f.repo.get('products','p1')).unitCostCents,undefined);
  await assert.rejects(()=>f.run('supplierProduct.save',{...result,expectedVersion:0}),{code:'INVALID_INPUT'});
  await assert.rejects(()=>f.run('supplier.save',{id:'s1',expectedVersion:9,name:'Stale'}),{code:'VERSION_CONFLICT'});
});
test('draft purchase order snapshots supplier costs and does not count inbound or alter stock',async()=>{
  const f=fixture();const po=await f.run('purchase.save',{id:'po',supplierId:'s1',lines:[{id:'line1',supplierProductId:'m1',quantity:10}]});
  assert.equal(po.status,'draft');assert.equal(po.lines[0].eachQuantity,120);assert.equal(po.totalCostCents,12000);assert.match(po.purchaseNumber,/^PO-2026-/);
  assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).onHand,20);
  const suggestions=purchasing.suggestions({inventory:await f.repo.list('inventory'),supplierProducts:await f.repo.list('supplierProducts'),purchaseOrders:[po],now:NOW});assert.equal(suggestions[0].inboundEach,0);
});
test('only explicit ordered confirmation establishes inbound and ordered snapshots cannot be silently saved over',async()=>{
  const f=fixture(),po=await ordered(f);assert.equal(po.status,'ordered');assert.equal(po.orderedAt,NOW);
  const result=purchasing.suggestions({inventory:await f.repo.list('inventory'),supplierProducts:await f.repo.list('supplierProducts'),purchaseOrders:[po],now:NOW});assert.equal(result[0].inboundEach,120);assert.equal(result[0].suggestedEach,72);
  await assert.rejects(()=>f.run('purchase.save',{id:po.id,expectedVersion:po.version,supplierId:'s1',lines:[]}),{code:'INVALID_TRANSITION'});
});
test('receiving four of ten cases uses the saved conversion and leaves six outstanding',async()=>{
  const f=fixture(),po=await ordered(f);await f.repo.put('products','p1',{...(await f.repo.get('products','p1')),packSize:24});await f.repo.put('supplierProducts','m1',{...(await f.repo.get('supplierProducts','m1')),packSize:36,unitCostCents:9999});
  const received=await f.run('purchase.receive',receipt(po,4),staff);
  assert.equal(received.status,'partially received');assert.equal(received.lines[0].acceptedQuantity,4);assert.equal(received.lines[0].outstandingQuantity,6);assert.equal(received.lines[0].unitCostCents,1200);
  assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).onHand,68);assert.equal((await f.repo.list('warehouseMovements'))[0].quantityEach,48);assert.equal((await f.repo.list('purchaseReceipts')).length,1);
});
test('retrying a receipt is exactly once and reusing its id for different quantities conflicts',async()=>{
  const f=fixture(),po=await ordered(f),payload=receipt(po,4);const first=await f.run('purchase.receive',payload,staff,'receipt-one');await f.run('purchase.receive',payload,staff,'receipt-one');
  assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).onHand,68);assert.equal((await f.repo.list('purchaseReceipts')).length,1);
  await assert.rejects(()=>f.run('purchase.receive',receipt(po,5),staff,'receipt-one'),{code:'COMMAND_CONFLICT'});
  await assert.rejects(()=>f.run('purchase.receive',receipt(po,1),staff),{code:'VERSION_CONFLICT'});assert.equal(first.version,3);
});
test('rejected replacement goods add no resalable stock and remain receivable as obligations',async()=>{
  const f=fixture();let po=await ordered(f);po=await f.run('purchase.receive',receipt(po,4,6),staff);
  assert.equal(po.lines[0].outstandingQuantity,6);assert.equal(po.lines[0].rejectedQuantity,6);assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).onHand,68);
  po=await f.run('purchase.receive',receipt(po,6),staff);assert.equal(po.status,'received');assert.equal(po.lines[0].acceptedQuantity,10);assert.equal(po.lines[0].outstandingQuantity,0);assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).onHand,140);
});
test('closing damaged quantities requires owner and produces closed instead of fully received',async()=>{
  const f=fixture(),po=await ordered(f),payload=receipt(po,4,6,{lines:[{lineId:'line1',acceptedQuantity:4,rejectedQuantity:6,rejectedDisposition:'close'}]});
  await assert.rejects(()=>f.run('purchase.receive',payload,staff),{code:'FORBIDDEN'});
  const result=await f.run('purchase.receive',payload);assert.equal(result.status,'closed');assert.equal(result.lines[0].closedQuantity,6);assert.equal(result.lines[0].outstandingQuantity,0);
});
test('each delivery attempt cannot exceed outstanding and any failure rolls back stock and receipts',async()=>{
  const f=fixture(),po=await ordered(f);
  for(const payload of [receipt(po,11),receipt(po,6,5),receipt(po,-1),receipt(po,1.5),receipt(po,0)])await assert.rejects(()=>f.run('purchase.receive',payload,staff));
  assert.equal((await f.repo.list('purchaseReceipts')).length,0);assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).onHand,20);
});
test('accepted receipt requires a known warehouse count baseline and preserves reservation values',async()=>{
  const f=fixture({inventory:[]}),po=await ordered(f);await assert.rejects(()=>f.run('purchase.receive',receipt(po,4),staff),{code:'UNKNOWN_STOCK_BASELINE'});assert.equal((await f.repo.list('purchaseReceipts')).length,0);
});
test('owner amendments retain historical expectations and cannot fall below accepted plus closed',async()=>{
  const f=fixture();let po=await ordered(f);po=await f.run('purchase.receive',receipt(po,4),staff);const before=po.lines[0].quantity;
  await assert.rejects(()=>f.run('purchase.amend',{id:po.id,expectedVersion:po.version,reason:'Reduction',lines:[{lineId:'line1',quantity:3}]}),{code:'PURCHASE_QUANTITY'});
  po=await f.run('purchase.amend',{id:po.id,expectedVersion:po.version,reason:'Supplier confirmed extra cases',lines:[{lineId:'line1',quantity:12}]});assert.equal(po.lines[0].outstandingQuantity,8);assert.equal(po.amendments[0].lines[0].beforeQuantity,before);assert.equal(po.amendments[0].lines[0].quantity,12);
  po=await f.run('purchase.close',{id:po.id,expectedVersion:po.version,reason:'Supplier cannot fulfill remainder'});assert.equal(po.status,'closed');assert.equal(po.lines[0].acceptedQuantity,4);assert.equal(po.lines[0].closedQuantity,8);
});
test('inventory metadata configuration preserves physical counts, reservations and unknown stock',async()=>{
  const f=fixture();const result=await f.run('inventory.configure',{productId:'p1',variant:'Orange',expectedVersion:1,warehouseBin:'A-02',targetEach:240,reorderPoint:36},staff);assert.equal(result.onHand,20);assert.equal(result.reserved,5);assert.equal(result.targetEach,240);
  const unknown=await f.run('inventory.configure',{productId:'p1',variant:'Lime',targetEach:null,warehouseBin:'A-03'},staff);assert.equal(unknown.onHand,null);assert.equal(unknown.reserved,0);
});
test('suggestions round target gaps to supplier multiples and expose missing inputs instead of guessing',()=>{
  const mappings=[{id:'m',supplierId:'s',productId:'p',variant:'',active:true,unit:'case',packSize:12,orderMultiple:2}],inventory=[{id:'stock',productId:'p',variant:'',onHand:30,reserved:10,targetEach:100,reorderPoint:40}];
  const purchaseOrders=[{id:'po',status:'ordered',expectedDeliveryAt:NOW-DAY,lines:[{productId:'p',variant:'',quantity:3,acceptedQuantity:1,closedQuantity:0,unit:'case',packSize:12}]}];
  let suggestion=purchasing.suggestions({inventory,supplierProducts:mappings,purchaseOrders,now:NOW})[0];assert.equal(suggestion.availableEach,20);assert.equal(suggestion.inboundEach,24);assert.equal(suggestion.suggestedEach,72);assert.equal(suggestion.suggestedQuantity,6);assert.deepEqual(suggestion.overdueOrders,['po']);
  suggestion=purchasing.suggestions({inventory:[{...inventory[0],onHand:null}],supplierProducts:mappings,purchaseOrders,now:NOW})[0];assert.equal(suggestion.eligible,false);assert.equal(suggestion.suggestedEach,null);assert.ok(suggestion.missingInputs.includes('onHand'));
  suggestion=purchasing.suggestions({inventory,supplierProducts:[{...mappings[0],orderMultiple:null}],purchaseOrders,now:NOW})[0];assert.equal(suggestion.suggestedEach,null);assert.ok(suggestion.missingInputs.includes('orderMultiple'));
});
test('competing receivers serialize one stock change and force the stale receiver to review',async()=>{
  const f=fixture(),po=await ordered(f),payload=receipt(po,4);
  const attempts=await Promise.allSettled([f.run('purchase.receive',payload,staff,'receiver-one'),f.run('purchase.receive',payload,{...staff,uid:'other-receiver'},'receiver-two')]);
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);assert.equal(attempts.find(result=>result.status==='rejected').reason.code,'VERSION_CONFLICT');assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).onHand,68);assert.equal((await f.repo.list('purchaseReceipts')).length,1);
});
test('multi-line unknown stock failure rolls back every earlier increment and movement',async()=>{
  const f=fixture();await f.run('supplierProduct.save',{id:'m2',supplierId:'s1',productId:'p1',variant:'Lime',unit:'each',packSize:1,orderMultiple:1,unitCostCents:null});
  let po=await f.run('purchase.save',{supplierId:'s1',lines:[{id:'orange',supplierProductId:'m1',quantity:4},{id:'lime',supplierProductId:'m2',quantity:5}]});po=await f.run('purchase.order',{id:po.id,expectedVersion:po.version});
  await assert.rejects(()=>f.run('purchase.receive',{id:po.id,expectedVersion:po.version,lines:[{lineId:'orange',acceptedQuantity:4,rejectedQuantity:0},{lineId:'lime',acceptedQuantity:5,rejectedQuantity:0}]},staff),{code:'UNKNOWN_STOCK_BASELINE'});
  assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).onHand,20);assert.equal((await f.repo.list('warehouseMovements')).length,0);assert.equal((await f.repo.get('purchaseOrders',po.id)).version,2);
});
test('unknown cost remains unknown, unknown case pack prevents ordering, and unknown multiples prevent suggestions',async()=>{
  const f=fixture();await f.repo.put('supplierProducts','m1',{...(await f.repo.get('supplierProducts','m1')),packSize:null,unitCostCents:null,orderMultiple:null});
  const po=await f.run('purchase.save',{supplierId:'s1',lines:[{id:'line1',supplierProductId:'m1',quantity:3}]});assert.equal(po.totalCostCents,null);assert.equal(po.costsComplete,false);assert.equal(po.lines[0].eachQuantity,null);
  await assert.rejects(()=>f.run('purchase.order',{id:po.id,expectedVersion:po.version}),{code:'PACK_SIZE_REQUIRED'});assert.equal((await f.repo.get('purchaseOrders',po.id)).status,'draft');
});
test('supplier mismatch, invalid multiples, private-field injection and fractional cost are rejected',async()=>{
  const f=fixture();await f.run('supplier.save',{id:'s2',name:'Other supplier'});
  await assert.rejects(()=>f.run('purchase.save',{supplierId:'s2',lines:[{id:'l',supplierProductId:'m1',quantity:3}]}),{code:'INVALID_SUPPLIER'});
  await f.repo.put('supplierProducts','m1',{...(await f.repo.get('supplierProducts','m1')),orderMultiple:2});
  await assert.rejects(()=>f.run('purchase.save',{supplierId:'s1',lines:[{id:'l',supplierProductId:'m1',quantity:3}]}),{code:'INVALID_ORDER_MULTIPLE'});
  await assert.rejects(()=>f.run('supplierProduct.save',{id:'new',supplierId:'s1',productId:'p1',variant:'Orange',unit:'case',packSize:12,unitCostCents:1.5}),{code:'INVALID_INPUT'});
  await assert.rejects(()=>f.run('inventory.configure',{productId:'p1',variant:'Orange',expectedVersion:1,targetEach:200,onHand:9999},staff),{code:'INVALID_INPUT'});
});
test('closed obligation cannot receive more stock and role downgrade denies replay of owner closure decisions',async()=>{
  const f=fixture();let po=await ordered(f);const payload=receipt(po,0,10,{lines:[{lineId:'line1',acceptedQuantity:0,rejectedQuantity:10,rejectedDisposition:'close'}]});po=await f.run('purchase.receive',payload,owner,'closed-goods');assert.equal(po.status,'closed');
  await assert.rejects(()=>f.run('purchase.receive',payload,{uid:'owner',role:'salesman'},'closed-goods'),{code:'FORBIDDEN'});
  await assert.rejects(()=>f.run('purchase.receive',receipt(po,1),staff),{code:'INVALID_TRANSITION'});assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).onHand,20);
});
test('explicit owner amendment can reopen a received PO without rewriting prior accepted or closed quantities',async()=>{
  const f=fixture();let po=await ordered(f);po=await f.run('purchase.receive',receipt(po,10),staff);assert.equal(po.status,'received');
  po=await f.run('purchase.amend',{id:po.id,expectedVersion:po.version,reason:'Confirmed extra two cases in supplier shipment',lines:[{lineId:'line1',quantity:12}]});
  assert.equal(po.status,'partially received');assert.equal(po.lines[0].acceptedQuantity,10);assert.equal(po.lines[0].outstandingQuantity,2);assert.equal(po.lines[0].originalQuantity,10);
  po=await f.run('purchase.receive',receipt(po,2),staff);assert.equal(po.status,'received');assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).onHand,164);
});
test('suggestions outside supported whole-unit bounds require review instead of unreceivable quantities',()=>{
  const result=purchasing.suggestions({inventory:[{productId:'p',variant:'',onHand:0,reserved:0,targetEach:1_000_000_000}],supplierProducts:[{id:'m',supplierId:'s',productId:'p',variant:'',unit:'each',packSize:1,orderMultiple:1}],purchaseOrders:[],now:NOW})[0];
  assert.equal(result.eligible,false);assert.equal(result.suggestedQuantity,null);assert.ok(result.missingInputs.includes('quantityLimit'));
});
