'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {MemoryRepository} = require('../lib/repository.cjs');
const {helpers:h} = require('../lib/domain.cjs');
const operations = require('../lib/store-operations.cjs');
const actor={uid:'buyer',role:'customer',storeIds:['s1']};
const now=Date.UTC(2026,8,28);
function fixture(extra={}) {
  let sequence=0;
  const repo=new MemoryRepository({stores:[{id:'s1',name:'Store',taxRateBps:0},{id:'s2',name:'Other'}],products:[{id:'p1',name:'Drink',variants:['Orange','Lime'],packSize:12,priceCents:100}],orders:[{id:'o1',storeId:'s1',status:'draft',createdBy:'buyer',version:1,orderNumber:1,notes:'Deliver',lines:[{id:'l1',productId:'p1',variant:'Orange',quantity:2,unit:'case'}]}],...extra});
  const context={now,id:()=>`generated-${++sequence}`,actor};
  const run=(type,payload,who=actor)=>repo.transaction(tx=>{operations.authorize(who,type,payload,h);return operations.execute(tx,who,{type,payload},context,h);});
  return {repo,run,context};
}
const count=(overrides={})=>({storeId:'s1',productId:'p1',variant:'Orange',quantity:2,unit:'case',measuredAt:now-1000,targetEach:36,expectedVersion:0,...overrides});
test('counts preserve immutable measurements and use a known case conversion',async()=>{
  const f=fixture();const first=await f.run('storeInventory.count',count());
  assert.equal(first.countEach,24);assert.equal(first.targetEach,36);
  const second=await f.run('storeInventory.count',count({quantity:10,unit:'each',measuredAt:now,expectedVersion:1}));
  assert.equal(second.countEach,10);assert.equal(second.version,2);
  const history=await f.repo.list('storeInventoryCounts');assert.equal(history.length,2);assert.equal(history[0].countEach,24);assert.equal(history[0].packSize,12);
  assert.equal((await f.repo.list('inventory')).length,0);
});
test('stale count writes and cross-store counts roll back without erasing observations',async()=>{
  const f=fixture();await f.run('storeInventory.count',count());
  await assert.rejects(()=>f.run('storeInventory.count',count()),{code:'VERSION_CONFLICT'});
  await assert.rejects(()=>f.run('storeInventory.count',count({storeId:'s2'})),{code:'FORBIDDEN'});
  assert.equal((await f.repo.list('storeInventoryCounts')).length,1);
});
test('count correction replaces only its matching observation and preserves the earlier record',async()=>{
  const f=fixture();const first=await f.run('storeInventory.count',count());
  const next=await f.run('storeInventory.count',count({quantity:3,expectedVersion:1,correctionOf:first.latestCountId}));
  assert.equal(next.countEach,36);const rows=await f.repo.list('storeInventoryCounts');assert.equal(rows[0].countEach,24);assert.equal(rows[1].correctionOf,rows[0].id);
  await assert.rejects(()=>f.run('storeInventory.count',count({variant:'Lime',correctionOf:first.latestCountId})),{code:'INVALID_CORRECTION'});
});
test('negative counts, future observations and unknown case packs are rejected',async()=>{
  const f=fixture({products:[{id:'p1',name:'Drink',variants:['Orange'],packSize:null}]});
  for(const overrides of [{quantity:-1,unit:'each'},{measuredAt:now+1,unit:'each'},{quantity:1.2,unit:'each'}]) await assert.rejects(()=>f.run('storeInventory.count',count(overrides)),{code:'INVALID_INPUT'});
  await assert.rejects(()=>f.run('storeInventory.count',count()),{code:'PACK_SIZE_REQUIRED'});
});
test('case count preserves the pack the user observed and rejects a changed pack',async()=>{
  const f=fixture();const saved=await f.run('storeInventory.count',count({expectedPackSize:12}));assert.equal(saved.countEach,24);
  await f.repo.put('products','p1',{...(await f.repo.get('products','p1')),packSize:24});
  await assert.rejects(()=>f.run('storeInventory.count',count({expectedVersion:1,expectedPackSize:12})),{code:'PACK_SIZE_CHANGED'});
});
test('physical movements retain signed corrections and require reasons',async()=>{
  const f=fixture();const base={storeId:'s1',productId:'p1',variant:'Orange',unit:'each',effectiveAt:now,reason:'Broken stock'};
  const damaged=await f.run('storeInventory.movement',{...base,kind:'damage',quantity:2});assert.equal(damaged.quantityEach,-2);
  const correction=await f.run('storeInventory.movement',{...base,kind:'correction',quantity:-3});assert.equal(correction.quantityEach,-3);
  await assert.rejects(()=>f.run('storeInventory.movement',{...base,kind:'correction',quantity:3,reason:''}),{code:'INVALID_INPUT'});
});
test('handoff freezes exact saved revision; placement confirms it after later draft edits',async()=>{
  const f=fixture();const handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1});
  await f.repo.put('orders','o1',{...(await f.repo.get('orders','o1')),version:2,lines:[{id:'l1',productId:'p1',variant:'Orange',quantity:5,unit:'case'}]});
  const placed=await f.run('order.place',{handoffId:handoff.id});assert.equal(placed.lines[0].quantity,2);assert.equal(placed.orderVersion,1);
  const again=await f.run('order.place',{handoffId:handoff.id});assert.equal(again.id,placed.id);
  assert.equal((await f.repo.list('orderPlacements')).length,1);assert.equal((await f.repo.list('ledger')).length,0);assert.equal((await f.repo.list('inventory')).length,0);
});
test('handoff requires latest saved revision and customer creator ownership',async()=>{
  const f=fixture();await assert.rejects(()=>f.run('order.handoff',{id:'o1',expectedVersion:2}),{code:'VERSION_CONFLICT'});
  await assert.rejects(()=>f.run('order.handoff',{id:'o1',expectedVersion:1},{...actor,uid:'different'}),{code:'FORBIDDEN'});
});
test('Mail placement receipt and subsequent linked delivery share one fulfillment identity',async()=>{
  const f=fixture();const handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1});const placed=await f.run('order.place',{handoffId:handoff.id});
  await f.run('placement.receive',{id:placed.id,effectiveAt:now});await f.run('placement.receive',{id:placed.id,effectiveAt:now});
  const order={...(await f.repo.get('orders','o1')),status:'delivered',placementId:placed.id,lines:placed.lines};
  await f.repo.transaction(tx=>operations.recordOrderDelivery(tx,order,f.context,h));
  const rows=await f.repo.list('storeInventoryMovements');assert.equal(rows.length,1);assert.equal(rows[0].quantityEach,24);
});
test('matching submission reuses placement while changed Mail contents fail closed',async()=>{
  const f=fixture();const handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1});const placed=await f.run('order.place',{handoffId:handoff.id});
  const draft={...(await f.repo.get('orders','o1')),lines:handoff.snapshot.lines};const linked=await f.repo.transaction(tx=>operations.ensureSubmittedPlacement(tx,draft,f.context,h));assert.equal(linked.id,placed.id);
  await assert.rejects(()=>f.repo.transaction(tx=>operations.ensureSubmittedPlacement(tx,{...draft,lines:[{...draft.lines[0],quantity:9}]},f.context,h)),{code:'PLACEMENT_CONTENT_CONFLICT'});
});
test('addition drafts contain new items only, carry root identity, and reject canceled parents',async()=>{
  const f=fixture();const handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1});const placed=await f.run('order.place',{handoffId:handoff.id});
  const addition=await f.run('order.addition',{id:'a1',storeId:'s1',parentPlacementId:placed.id});assert.deepEqual(addition.lines,[]);assert.equal(addition.rootOrderId,'o1');assert.equal(addition.parentPlacementId,placed.id);assert.match(addition.additionReference,/A1$/);
  assert.equal((await f.repo.get('orders','o1')).lines.length,1);
  await f.repo.put('orders','o1',{...(await f.repo.get('orders','o1')),status:'cancelled'});
  await assert.rejects(()=>f.run('order.addition',{id:'a2',storeId:'s1',parentOrderId:'o1'}),{code:'INVALID_PARENT_ORDER'});
});
test('Mail Mix receipt requires the actual allowed split, keeps requested snapshot immutable, and deduplicates receipt',async()=>{
  const f=fixture();await f.repo.put('orders','o1',{...(await f.repo.get('orders','o1')),lines:[{id:'mix',productId:'p1',variant:'',selectionMode:'mix',allowedVariants:['Orange'],excludedVariants:['Lime'],quantity:2,unit:'case'}]});
  const handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1}),placed=await f.run('order.place',{handoffId:handoff.id});
  await assert.rejects(()=>f.run('placement.receive',{id:placed.id}),{code:'MIX_ALLOCATION_REQUIRED'});
  await assert.rejects(()=>f.run('placement.receive',{id:placed.id,actualMixAllocations:[{lineId:'mix',allocations:[{variant:'Lime',quantity:2}]}]}),{code:'INVALID_MIX_ALLOCATION'});
  const received=await f.run('placement.receive',{id:placed.id,actualMixAllocations:[{lineId:'mix',allocations:[{variant:'Orange',quantity:2}]}]});
  assert.equal(received.lines[0].allocations,undefined);assert.equal(received.receivedLines[0].allocations[0].eachQuantity,24);assert.equal((await f.repo.list('storeInventoryMovements'))[0].variant,'Orange');
  await f.run('placement.receive',{id:placed.id});assert.equal((await f.repo.list('storeInventoryMovements')).length,1);
});
test('handoff identity includes linked return requests and rejects unsupported count scope fields',async()=>{
  const f=fixture();const handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1});await f.run('order.place',{handoffId:handoff.id});
  const order=await f.repo.get('orders','o1');await assert.rejects(()=>f.repo.transaction(tx=>operations.ensureSubmittedPlacement(tx,{...order,creditRequestIds:['different-return']},f.context,h)),{code:'PLACEMENT_CONTENT_CONFLICT'});
  await assert.rejects(()=>f.run('storeInventory.count',count({actor:{role:'master'}})),{code:'INVALID_INPUT'});
});
test('placement keeps the handoff return request identities after the current draft changes',async()=>{
  const f=fixture();await f.repo.put('orders','o1',{...(await f.repo.get('orders','o1')),creditRequestIds:['return-original']});
  const handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1});
  await f.repo.put('orders','o1',{...(await f.repo.get('orders','o1')),version:2,creditRequestIds:['return-changed']});
  const placement=await f.run('order.place',{handoffId:handoff.id});assert.deepEqual(placement.creditRequestIds,['return-original']);
});

function commandRunner(f) {
  const {executeCommand}=require('../lib/domain.cjs');let sequence=0;
  return (type,payload,who=actor,commandId=`integration-${++sequence}`)=>f.repo.transaction(tx=>executeCommand(tx,who,{id:commandId,type,payload},{now,id:f.context.id}));
}
test('Mail placement keeps its sent case conversion when the catalog pack changes before submission',async()=>{
  for(const alreadyReceived of [false,true]) {
    const f=fixture({inventory:[{id:h.inventoryId('p1','Orange'),productId:'p1',variant:'Orange',onHand:100,reserved:0,version:1}]}),run=commandRunner(f);
    const handoff=await run('order.handoff',{id:'o1',expectedVersion:1}),placed=await run('order.place',{handoffId:handoff.id});
    if(alreadyReceived)await run('placement.receive',{id:placed.id});
    await f.repo.put('products','p1',{...(await f.repo.get('products','p1')),packSize:24});
    await assert.rejects(()=>run('order.submit',{id:'o1',expectedVersion:2}),{code:'PLACEMENT_CONTENT_CONFLICT'});
    assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).reserved,0);assert.equal((await f.repo.get('orders','o1')).status,'draft');assert.equal((await f.repo.list('ledger')).length,0);
    assert.equal((await f.repo.get('orderPlacements',placed.id)).lines[0].eachQuantity,24);
    const movements=await f.repo.list('storeInventoryMovements');assert.equal(movements.length,alreadyReceived?1:0);if(alreadyReceived)assert.equal(movements[0].quantityEach,24);
  }
});
test('each-unit Mail placement can submit unchanged when only the catalog case size changes',async()=>{
  const f=fixture(),run=commandRunner(f);await f.repo.put('orders','o1',{...(await f.repo.get('orders','o1')),lines:[{id:'l1',productId:'p1',variant:'Orange',quantity:2,unit:'each'}]});
  const handoff=await run('order.handoff',{id:'o1',expectedVersion:1});await run('order.place',{handoffId:handoff.id});await f.repo.put('products','p1',{...(await f.repo.get('products','p1')),packSize:24});
  const submitted=await run('order.submit',{id:'o1',expectedVersion:2});assert.equal(submitted.lines[0].eachQuantity,2);
});
test('conflicting actual Mix delivery rolls back warehouse effects after a Mail receipt and matching picks remain exactly once',async()=>{
  const f=fixture({inventory:['Orange','Lime'].map(variant=>({id:h.inventoryId('p1',variant),productId:'p1',variant,onHand:100,reserved:0,version:1}))}),run=commandRunner(f),staff={uid:'staff',role:'salesman',storeIds:['s1']};
  await f.repo.put('orders','o1',{...(await f.repo.get('orders','o1')),lines:[{id:'mix',productId:'p1',variant:'',selectionMode:'mix',allowedVariants:['Orange','Lime'],excludedVariants:[],quantity:2,unit:'case'}]});
  const handoff=await run('order.handoff',{id:'o1',expectedVersion:1}),placement=await run('order.place',{handoffId:handoff.id});await run('placement.receive',{id:placement.id,actualMixAllocations:[{lineId:'mix',allocations:[{variant:'Orange',quantity:2}]}]});
  let order=await run('order.submit',{id:'o1',expectedVersion:2});for(const status of ['approved','picking'])order=await run('order.transition',{id:order.id,expectedVersion:order.version,status},staff);
  order=await run('order.pick',{id:order.id,expectedVersion:order.version,allocations:[{lineId:'mix',variants:[{variant:'Lime',quantity:2}]}]},staff);
  await assert.rejects(()=>run('order.transition',{id:order.id,expectedVersion:order.version,status:'delivered'},staff),{code:'FULFILLMENT_CONFLICT'});
  assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Lime'))).onHand,100);assert.equal((await f.repo.get('orders',order.id)).status,'picking');assert.equal((await f.repo.list('warehouseMovements')).length,0);
  order=await run('order.pick',{id:order.id,expectedVersion:order.version,allocations:[{lineId:'mix',variants:[{variant:'Orange',quantity:2}]}]},staff);
  order=await run('order.transition',{id:order.id,expectedVersion:order.version,status:'delivered'},staff);assert.equal(order.status,'delivered');assert.equal((await f.repo.get('inventory',h.inventoryId('p1','Orange'))).onHand,76);assert.equal((await f.repo.list('storeInventoryMovements')).length,1);
});
test('delivery receipt identity rejects a different concrete quantity even without a current catalog change',async()=>{
  const f=fixture(),handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1}),placed=await f.run('order.place',{handoffId:handoff.id});await f.run('placement.receive',{id:placed.id});
  const order={...(await f.repo.get('orders','o1')),status:'delivered',placementId:placed.id,lines:placed.lines.map(line=>({...line,quantity:3,eachQuantity:36}))};
  await assert.rejects(()=>f.repo.transaction(tx=>operations.recordOrderDelivery(tx,order,f.context,h)),{code:'FULFILLMENT_CONFLICT'});assert.equal((await f.repo.list('storeInventoryMovements'))[0].quantityEach,24);
});
test('store replay authorization reloads creator ownership after a staff account becomes a customer',async()=>{
  const f=fixture(),staff={uid:'rep',role:'salesman',storeIds:['s1']},handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1},staff),command={type:'order.handoff',payload:{id:'o1',expectedVersion:1}};
  await assert.rejects(()=>f.repo.transaction(tx=>operations.authorizeReplay(tx,{...staff,role:'customer'},command,handoff,h)),{code:'FORBIDDEN'});
  await f.repo.transaction(tx=>operations.authorizeReplay(tx,staff,command,handoff,h));
  const ownHandoff=await f.run('order.handoff',{id:'o1',expectedVersion:1});await f.repo.transaction(tx=>operations.authorizeReplay(tx,actor,command,ownHandoff,h));
});
test('an older linked order cannot make its first receipt with quantities different from the placed snapshot',async()=>{
  const f=fixture(),handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1}),placed=await f.run('order.place',{handoffId:handoff.id});
  const order={...(await f.repo.get('orders','o1')),status:'delivered',placementId:placed.id,lines:placed.lines.map(line=>({...line,packSize:24,eachQuantity:48}))};
  await assert.rejects(()=>f.repo.transaction(tx=>operations.recordOrderDelivery(tx,order,f.context,h)),{code:'FULFILLMENT_CONFLICT'});assert.equal((await f.repo.list('storeInventoryMovements')).length,0);
});
test('older receipt records validate frozen received lines when no fulfillment hash was saved',async()=>{
  const f=fixture(),handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1}),placed=await f.run('order.place',{handoffId:handoff.id});await f.run('placement.receive',{id:placed.id});
  const saved=(await f.repo.list('storeInventoryReceipts'))[0];delete saved.fulfillmentHash;await f.repo.put('storeInventoryReceipts',saved.id,saved);
  const order={...(await f.repo.get('orders','o1')),status:'delivered',placementId:placed.id,lines:placed.lines};await f.repo.transaction(tx=>operations.recordOrderDelivery(tx,order,f.context,h));
  await assert.rejects(()=>f.repo.transaction(tx=>operations.recordOrderDelivery(tx,{...order,lines:order.lines.map(line=>({...line,variant:'Lime'}))},f.context,h)),{code:'FULFILLMENT_CONFLICT'});assert.equal((await f.repo.list('storeInventoryMovements')).length,1);
});
test('placement replay rechecks the underlying order creator after staff role downgrade',async()=>{
  const f=fixture(),staff={uid:'rep',role:'salesman',storeIds:['s1']},handoff=await f.run('order.handoff',{id:'o1',expectedVersion:1},staff),placed=await f.run('order.place',{handoffId:handoff.id},staff),command={type:'order.place',payload:{handoffId:handoff.id}};
  await assert.rejects(()=>f.repo.transaction(tx=>operations.authorizeReplay(tx,{...staff,role:'customer'},command,placed,h)),{code:'FORBIDDEN'});await f.repo.transaction(tx=>operations.authorizeReplay(tx,staff,command,placed,h));
});
test('cached Mail handoff and placement commands deny creator-only actions after role downgrade',async()=>{
  const f=fixture(),run=commandRunner(f),staff={uid:'rep',role:'salesman',storeIds:['s1']},customer={...staff,role:'customer'};
  const handoff=await run('order.handoff',{id:'o1',expectedVersion:1},staff,'cached-handoff');const placed=await run('order.place',{handoffId:handoff.id},staff,'cached-placement');
  await assert.rejects(()=>run('order.handoff',{id:'o1',expectedVersion:1},customer,'cached-handoff'),{code:'FORBIDDEN'});await assert.rejects(()=>run('order.place',{handoffId:handoff.id},customer,'cached-placement'),{code:'FORBIDDEN'});
  assert.equal((await run('order.place',{handoffId:handoff.id},staff,'cached-placement')).id,placed.id);assert.equal((await f.repo.list('orderPlacements')).length,1);
});
