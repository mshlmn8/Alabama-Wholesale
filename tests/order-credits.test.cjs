'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {MemoryRepository} = require('../lib/repository.cjs');
const domain = require('../lib/domain.cjs');
const h = domain.helpers;
let credits;
try { credits = require('../lib/order-credits.cjs'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const owner={uid:'owner',role:'master',storeIds:[]};
const rep={uid:'rep',role:'salesman',storeIds:['s1']};
const customer={uid:'buyer',role:'customer',storeIds:['s1']};
const now=1790596800000;
const original={id:'o1',storeId:'s1',invoiceNumber:'AW-2026-000001',status:'delivered',subtotalCents:1000,taxCents:83,totalCents:1083,version:1,storeSnapshot:{id:'s1',name:'Store One'},lines:[{id:'l1',productId:'p1',name:'Drink',sku:'drink',variant:'Orange',quantity:10,unit:'each',packSize:12,unitPriceCents:100,eachPriceCents:100,lineTotalCents:1000,taxCents:83,eachQuantity:10}]};
const physicalReturn={id:'r1',orderId:'o1',storeId:'s1',invoiceNumber:original.invoiceNumber,status:'pending',version:1,createdBy:'buyer',subtotalCents:400,taxCents:33,totalCents:433,reason:'Return sealed goods',pickupRequested:true,lines:[{lineId:'l1',productId:'p1',name:'Drink',variant:'Orange',quantity:4,unit:'each',packSize:12,eachQuantity:4,unitPriceCents:100,subtotalCents:400,taxCents:33,totalCents:433}]};
function fixture(extra={}) {
  const repo=new MemoryRepository({stores:[{id:'s1',name:'Store One',version:1},{id:'s2',name:'Other',version:1}],orders:[original],inventory:[{id:h.inventoryId('p1','Orange'),onHand:10,reserved:0,reorderPoint:0,version:1}],...extra});
  let n=0;
  return {repo,get:repo.get.bind(repo),list:repo.list.bind(repo),run(type,payload,actor=owner,commandId='cmd-'+(++n)) {
    assert.ok(credits,'Credit and physical return extension is implemented');
    return repo.transaction(tx=>credits.execute(tx,actor,{id:commandId,type,payload},{now,id:()=>`generated-${++n}`,actor},h));
  }};
}
const rejectsCode=(fn,code)=>assert.rejects(fn,error=>error.code===code);
const request=(f,payload={},actor=customer)=>f.run('credit.request',{storeId:'s1',orderId:'o1',subtotalCents:100,taxCents:8,reason:'Documented price correction',...payload},actor);

test('credit requests reserve frozen amounts without posting account credit',async()=>{
  const f=fixture(); const r=await request(f);
  assert.equal(r.kind,'adjustment'); assert.equal(r.status,'pending'); assert.equal(r.totalCents,108);
  assert.equal(r.lines[0].lineId,'l1'); assert.equal(r.lines[0].subtotalCents,100);
  assert.deepEqual(await f.list('ledger'),[]); assert.deepEqual(await f.get('orders','o1'),original);
});
test('only owners approve credit, once, without changing frozen invoice totals',async()=>{
  const f=fixture(); const r=await request(f);
  await rejectsCode(()=>f.run('credit.approve',{storeId:'s1',creditId:r.id,expectedVersion:r.version},rep),'FORBIDDEN');
  const approved=await f.run('credit.approve',{storeId:'s1',creditId:r.id,expectedVersion:r.version});
  const again=await f.run('credit.approve',{storeId:'s1',creditId:r.id,expectedVersion:r.version});
  assert.equal(approved.status,'approved'); assert.deepEqual(again,approved); assert.match(approved.creditMemoNumber,/^CM-/);
  assert.equal((await f.list('ledger')).length,1); assert.equal((await f.list('ledger'))[0].deltaCents,-108);
  const invoice=await f.get('orders','o1'); assert.equal(invoice.subtotalCents,1000); assert.equal(invoice.taxCents,83); assert.equal(invoice.totalCents,1083); assert.equal(invoice.creditedCents,108); assert.equal(invoice.amountDueCents,975);
});
test('pending physical returns and pending adjustments jointly cap subtotal and tax',async()=>{
  const f=fixture({returns:[physicalReturn]}); await request(f,{subtotalCents:600,taxCents:50});
  await rejectsCode(()=>request(f,{subtotalCents:1,taxCents:0}),'CREDIT_LIMIT');
  await rejectsCode(()=>request(f,{subtotalCents:0,taxCents:1}),'CREDIT_LIMIT');
  assert.equal((await f.list('returns')).length,2);
});
test('individual line budget rejects excess even when invoice has room elsewhere',async()=>{
  const invoice={...original,subtotalCents:2000,taxCents:166,totalCents:2166,lines:[...original.lines,{...original.lines[0],id:'l2',variant:'Lime'}]};
  const f=fixture({orders:[invoice]}); await request(f,{lines:[{lineId:'l1',subtotalCents:1000,taxCents:83}],subtotalCents:undefined,taxCents:undefined});
  await rejectsCode(()=>request(f,{lines:[{lineId:'l1',subtotalCents:1,taxCents:0}],subtotalCents:undefined,taxCents:undefined}),'CREDIT_LIMIT');
});
test('rejecting or cancelling a pending claim releases reserved credit capacity',async()=>{
  const f=fixture(); const r=await request(f,{subtotalCents:1000,taxCents:83});
  await f.run('credit.cancel',{storeId:'s1',creditId:r.id,expectedVersion:r.version,reason:'Wrong request'},customer);
  const next=await request(f,{subtotalCents:1000,taxCents:83});
  await f.run('credit.reject',{storeId:'s1',creditId:next.id,expectedVersion:next.version,reason:'Unsupported'},rep);
  await request(f,{subtotalCents:1000,taxCents:83}); assert.deepEqual(await f.list('ledger'),[]);
});
test('unverified requests cannot post a credit without owner reconciliation to an original invoice',async()=>{
  const f=fixture(); const r=await f.run('credit.request',{storeId:'s1',originalReference:'Old paper sale',lines:[{productId:'p1',name:'Drink',variant:'Orange',quantity:2,unit:'each'}],reason:'Wrong price'},customer);
  assert.equal(r.kind,'unverified'); assert.equal(r.totalCents,0); assert.equal(r.status,'pending');
  await rejectsCode(()=>f.run('credit.approve',{storeId:'s1',creditId:r.id,expectedVersion:r.version}),'RECONCILIATION_REQUIRED');
  const approved=await f.run('credit.approve',{storeId:'s1',creditId:r.id,expectedVersion:r.version,orderId:'o1',subtotalCents:100,taxCents:8});
  assert.equal(approved.kind,'adjustment'); assert.equal(approved.reconciledFromKind,'unverified'); assert.equal(approved.totalCents,108);
  assert.deepEqual(approved.unverifiedRequest.lines,r.lines); assert.equal(approved.unverifiedRequest.originalReference,'Old paper sale');
});
test('credit approval rejects stale versions and migration-blocked financial accounts',async()=>{
  const f=fixture({stores:[{id:'s1',name:'Store One',migrationBlocked:true,version:1}]}); const r=await request(f);
  await rejectsCode(()=>f.run('credit.approve',{storeId:'s1',creditId:r.id,expectedVersion:r.version}),'RECONCILIATION_REQUIRED');
  const other=fixture(); const next=await request(other);
  await rejectsCode(()=>other.run('credit.approve',{storeId:'s1',creditId:next.id,expectedVersion:99}),'VERSION_CONFLICT');
});
test('extension scope and role authorization happens before any transaction reads',async()=>{
  assert.ok(credits); let reads=0; const tx={get(){reads++;throw Error('read');}};
  for(const [type,payload,actor] of [['credit.request',{storeId:'s2'},customer],['credit.approve',{storeId:'s1',creditId:'missing'},rep],['return.pickup',{storeId:'s1',returnId:'missing'},customer]]){
    await rejectsCode(()=>credits.execute(tx,actor,{id:'test',type,payload},{now,actor,id:()=> 'id'},h),'FORBIDDEN');
  }
  assert.equal(reads,0);
});
test('cross-store record IDs cannot escape an authorized payload store',async()=>{
  const f=fixture({orders:[{...original,storeId:'s2'}],returns:[{...physicalReturn,storeId:'s2'}]});
  await rejectsCode(()=>request(f),'FORBIDDEN');
  await rejectsCode(()=>f.run('return.pickup',{storeId:'s1',returnId:'r1',expectedVersion:1,lines:[{lineId:'l1',quantity:1}]},rep),'FORBIDDEN');
});
test('pickup is physical only, enforces partial quantities and records store movement',async()=>{
  const f=fixture({returns:[physicalReturn]}); const picked=await f.run('return.pickup',{storeId:'s1',returnId:'r1',expectedVersion:1,lines:[{lineId:'l1',quantity:2}]},rep);
  assert.equal(picked.status,'pending'); assert.equal(picked.physical.lines[0].pickedQuantity,2); assert.equal(picked.physical.lines[0].receivedQuantity,0);
  assert.equal((await f.get('inventory',h.inventoryId('p1','Orange'))).onHand,10); assert.deepEqual(await f.list('ledger'),[]);
  const movements=await f.list('storeInventoryMovements'); assert.equal(movements.length,1); assert.equal(movements[0].kind,'return-out'); assert.equal(movements[0].quantityEach,-2);
  await rejectsCode(()=>f.run('return.pickup',{storeId:'s1',returnId:'r1',expectedVersion:picked.version,lines:[{lineId:'l1',quantity:3}]},rep),'RETURN_QUANTITY');
});
test('receipt requires prior pickup and damaged dispositions never restock',async()=>{
  const f=fixture({returns:[physicalReturn]});
  await rejectsCode(()=>f.run('return.receive',{storeId:'s1',returnId:'r1',expectedVersion:1,lines:[{lineId:'l1',quantity:1,disposition:'resalable'}]},rep),'RETURN_QUANTITY');
  let r=await f.run('return.pickup',{storeId:'s1',returnId:'r1',expectedVersion:1,lines:[{lineId:'l1',quantity:4}]},rep);
  r=await f.run('return.receive',{storeId:'s1',returnId:'r1',expectedVersion:r.version,lines:[{lineId:'l1',quantity:3,disposition:'nonresalable'}]},rep);
  assert.equal((await f.get('inventory',h.inventoryId('p1','Orange'))).onHand,10);
  r=await f.run('return.receive',{storeId:'s1',returnId:'r1',expectedVersion:r.version,lines:[{lineId:'l1',quantity:1,disposition:'resalable'}]},rep);
  assert.equal(r.physicalStatus,'inspected'); assert.equal(r.physical.lines[0].resalableQuantity,1); assert.equal(r.physical.lines[0].nonresalableQuantity,3);
  assert.equal((await f.get('inventory',h.inventoryId('p1','Orange'))).onHand,11); assert.equal((await f.list('warehouseMovements')).length,2); assert.deepEqual(await f.list('ledger'),[]);
  await rejectsCode(()=>f.run('return.receive',{storeId:'s1',returnId:'r1',expectedVersion:r.version,lines:[{lineId:'l1',quantity:1,disposition:'resalable'}]},rep),'RETURN_QUANTITY');
});
test('legacy restocked approval seeds completed physical disposition to prevent a second restock',async()=>{
  const f=fixture({returns:[{...physicalReturn,status:'approved',restock:true}]});
  await rejectsCode(()=>f.run('return.receive',{storeId:'s1',returnId:'r1',expectedVersion:1,lines:[{lineId:'l1',quantity:1,disposition:'resalable'}]},rep),'RETURN_QUANTITY');
  assert.equal((await f.get('inventory',h.inventoryId('p1','Orange'))).onHand,10);
});
test('resalable receipt preserves unknown inventory and records a reconciliation warning',async()=>{
  const f=fixture({returns:[physicalReturn],inventory:[{id:h.inventoryId('p1','Orange'),onHand:null,reserved:0,version:1}]});
  let r=await f.run('return.pickup',{storeId:'s1',returnId:'r1',expectedVersion:1,lines:[{lineId:'l1',quantity:4}]},rep);
  r=await f.run('return.receive',{storeId:'s1',returnId:'r1',expectedVersion:r.version,lines:[{lineId:'l1',quantity:4,disposition:'resalable'}]},rep);
  assert.equal((await f.get('inventory',h.inventoryId('p1','Orange'))).onHand,null); assert.equal(r.restockWarnings[0].code,'RESTOCK_UNKNOWN_BASELINE');
});
test('financial adjustments cannot enter the physical pickup flow',async()=>{
  const f=fixture(); const r=await request(f);
  await rejectsCode(()=>f.run('return.pickup',{storeId:'s1',returnId:r.id,expectedVersion:r.version,lines:[{lineId:'l1',quantity:1}]},rep),'INVALID_TRANSITION');
});
test('competing adjustment requests serialize the shared invoice budget',async()=>{
  const f=fixture(); const results=await Promise.allSettled([request(f,{subtotalCents:700,taxCents:50}),request(f,{subtotalCents:700,taxCents:50})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1); assert.equal(results.find(result=>result.status==='rejected').reason.code,'CREDIT_LIMIT');
});
test('mixed invoice adjustment uses only the actually delivered flavor budget',async()=>{
  const f=fixture({orders:[{...original,lines:[{...original.lines[0],variant:'',selectionMode:'mix',pickedAt:now,allocations:[{variant:'Orange',quantity:3,eachQuantity:3},{variant:'Lime',quantity:7,eachQuantity:7}]}]}]});
  const r=await request(f,{subtotalCents:undefined,taxCents:undefined,lines:[{lineId:'l1',variant:'Orange',subtotalCents:300,taxCents:25}]});
  assert.equal(r.totalCents,325);
  await rejectsCode(()=>request(f,{subtotalCents:undefined,taxCents:undefined,lines:[{lineId:'l1',variant:'Orange',subtotalCents:1,taxCents:0}]}),'CREDIT_LIMIT');
  await rejectsCode(()=>request(f,{subtotalCents:undefined,taxCents:undefined,lines:[{lineId:'l1',variant:'Grape',subtotalCents:1,taxCents:0}]}),'INVALID_INPUT');
});
test('case pickups and receipts use frozen pack sizes for individual stock movement',async()=>{
  const f=fixture({returns:[{...physicalReturn,lines:[{...physicalReturn.lines[0],unit:'case',packSize:12,eachQuantity:48}]}]});
  let r=await f.run('return.pickup',{storeId:'s1',returnId:'r1',expectedVersion:1,lines:[{lineId:'l1',quantity:1}]},rep);
  r=await f.run('return.receive',{storeId:'s1',returnId:'r1',expectedVersion:r.version,lines:[{lineId:'l1',quantity:1,disposition:'resalable'}]},rep);
  assert.equal((await f.list('storeInventoryMovements'))[0].quantityEach,-12); assert.equal((await f.get('inventory',h.inventoryId('p1','Orange'))).onHand,22);
});
test('malformed saved physical counts fail closed instead of expanding remaining quantities',async()=>{
  const f=fixture({returns:[{...physicalReturn,physical:{lines:[{lineId:'l1',variant:'Orange',pickedQuantity:-5,receivedQuantity:0,resalableQuantity:0,nonresalableQuantity:0}]}}]});
  await rejectsCode(()=>f.run('return.pickup',{storeId:'s1',returnId:'r1',expectedVersion:1,lines:[{lineId:'l1',quantity:5}]},rep),'INVALID_INPUT');
  assert.equal((await f.list('storeInventoryMovements')).length,0);
});
test('physical return rejects an inconsistent cross-store source invoice',async()=>{
  const f=fixture({orders:[{...original,storeId:'s2'}],returns:[physicalReturn]});
  await rejectsCode(()=>f.run('return.pickup',{storeId:'s1',returnId:'r1',expectedVersion:1,lines:[{lineId:'l1',quantity:1}]},rep),'FORBIDDEN');
});
test('approval cannot be replayed with a changed credit amount',async()=>{
  const f=fixture(); const r=await request(f); await f.run('credit.approve',{storeId:'s1',creditId:r.id,expectedVersion:r.version});
  await rejectsCode(()=>f.run('credit.approve',{storeId:'s1',creditId:r.id,subtotalCents:101,taxCents:8}),'COMMAND_CONFLICT');
});
test('fractional and negative amounts cannot enter financial records',async()=>{
  const f=fixture();
  for(const subtotalCents of [-1,0.1,NaN,Infinity,'100'])await rejectsCode(()=>request(f,{subtotalCents}),'INVALID_INPUT');
  assert.equal((await f.list('returns')).length,0);
});
