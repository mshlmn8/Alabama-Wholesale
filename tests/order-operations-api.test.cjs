'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createApp}=require('../server.js');
const {MemoryRepository}=require('../lib/repository.cjs');
const {createAuthService}=require('../lib/auth.cjs');
const {inventoryId}=require('../lib/domain.cjs');
const now=Date.UTC(2026,8,28,12),day=86400000;
const delivered={id:'old-invoice',storeId:'s1',status:'delivered',invoiceNumber:'AW-2026-001',subtotalCents:1000,taxCents:0,totalCents:1000,createdAt:now-8*day,deliveredAt:now-7*day,createdBy:'buyer',version:1,lines:[{id:'old-line',productId:'p1',name:'Drink',sku:'drink',variant:'Orange',quantity:10,unit:'each',packSize:12,unitPriceCents:100,lineTotalCents:1000,taxCents:0,eachQuantity:10}]};
async function fixture(t,extra={},options={}){
  const repo=new MemoryRepository({users:[{id:'owner',uid:'owner',role:'master',active:true,email:'owner@example.com',storeIds:[]},{id:'rep',uid:'rep',role:'salesman',active:true,email:'rep@example.com',storeIds:['s1']},{id:'buyer',uid:'buyer',role:'customer',active:true,email:'buyer@example.com',storeIds:['s1']}],stores:[{id:'s1',name:'Shop One',taxRateBps:0,version:1},{id:'s2',name:'Private Shop Two',taxRateBps:0,version:1}],products:[{id:'p1',name:'Drink',sku:'drink',variants:['Orange','Lime','Grape'],packSize:12,priceCents:100,active:true,version:1}],inventory:['Orange','Lime','Grape'].map(variant=>({id:inventoryId('p1',variant),productId:'p1',variant,onHand:100,reserved:0,reorderPoint:0,version:1})),orders:[delivered],...extra});
  const tokens=Object.fromEntries(['owner','rep','buyer'].map(uid=>[uid,{uid,email:uid+'@example.com',email_verified:true,firebase:{sign_in_provider:uid==='owner'?'google.com':'password'}}]));
  const auth=createAuthService({repo,ownerEmail:'owner@example.com',verifyIdToken:async token=>{if(!tokens[token])throw Error('Invalid test identity');return tokens[token];},verifyAppCheckToken:async token=>{if(token!=='valid')throw Error('Invalid app check');},requireAppCheck:true});
  const app=createApp({repo,auth,config:{firebaseConfig:{projectId:'test'}},now:()=>now,assistant:async()=>({lines:[],ambiguities:[]}),...options});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=async(route,actor='owner',body)=>{
    const result=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${actor}`,'X-Firebase-AppCheck':'valid','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const text=await result.text();let data;try{data=JSON.parse(text);}catch{data={text};}return {status:result.status,data};
  };
  let sequence=0;
  const send=(type,payload,actor='owner',id='command-'+(++sequence))=>request('/api/commands',actor,{id,type,payload});
  const command=async(...args)=>{const response=await send(...args);assert.equal(response.status,200,JSON.stringify(response.data));return response.data.result;};
  return {repo,request,send,command};
}

test('store inventory, placement and replenishment routes reject cross-store access before reading private records',async t=>{
  const f=await fixture(t);let protectedReads=0;const get=f.repo.get.bind(f.repo),list=f.repo.list.bind(f.repo);
  f.repo.get=async(collection,id)=>{if(collection==='stores'&&id==='s2')protectedReads++;return get(collection,id);};
  f.repo.list=async(collection,options)=>{if(['storeInventory','storeInventoryCounts','storeInventoryMovements','orderPlacements'].includes(collection)&&options?.where?.some(([field,,value])=>field==='storeId'&&value==='s2'))protectedReads++;return list(collection,options);};
  for(const route of ['/api/stores/s2/inventory','/api/stores/s2/placements'])assert.equal((await f.request(route,'buyer')).status,403);
  assert.equal((await f.request('/api/stores/s2/replenishment','buyer',{draft:{lines:[]},explain:false})).status,403);
  assert.equal(protectedReads,0);
});
test('customer state exposes warehouse availability without exact stock or reservation values',async t=>{
  const f=await fixture(t),response=await f.request('/api/state','buyer');assert.equal(response.status,200,JSON.stringify(response.data));
  assert.equal(response.data.inventory.length,3);
  for(const row of response.data.inventory){assert.equal(row.availability,'available');for(const field of ['onHand','reserved','reorderPoint','wholesaleCostCents','costCents'])assert.equal(Object.hasOwn(row,field),false);}
  const staff=await f.request('/api/state','rep');assert.equal(staff.data.inventory[0].onHand,100);
});
test('inventory history and pagination are store scoped, including attacker-supplied foreign cursors',async t=>{
  const f=await fixture(t,{storeInventoryCounts:[{id:'one',storeId:'s1',productId:'p1',variant:'Orange',countEach:12,recordedAt:now-2,measuredAt:now-2},{id:'two',storeId:'s1',productId:'p1',variant:'Orange',countEach:10,recordedAt:now-1,measuredAt:now-1},{id:'private',storeId:'s2',productId:'p1',variant:'Orange',countEach:987654,recordedAt:now,measuredAt:now}]});
  const first=await f.request('/api/stores/s1/inventory?limit=1','buyer');assert.equal(first.status,200);assert.equal(first.data.counts.length,1);assert.equal(first.data.counts[0].id,'two');assert.equal(first.data.history.complete,false);
  const next=await f.request('/api/stores/s1/inventory?limit=1&countsCursor='+encodeURIComponent(first.data.history.nextCountsCursor),'buyer');assert.equal(next.status,200);assert.equal(next.data.counts[0].id,'one');
  assert.equal((await f.request('/api/stores/s1/inventory?countsCursor=private','buyer')).status,403);
  assert.equal((await f.request('/api/stores/s1/inventory?storeId=s2','buyer')).status,400);
});
test('replenishment uses authorized history and rejects alternate store injection',async t=>{
  const f=await fixture(t,{orders:[delivered,{...delivered,id:'private-order',storeId:'s2',lines:[{...delivered.lines[0],productId:'secret-product'}]}],products:[{id:'p1',name:'Drink',variants:['Orange'],packSize:12,priceCents:100},{id:'secret-product',name:'Other store secret product',priceCents:123456,variants:[]}]});
  const result=await f.request('/api/stores/s1/replenishment','buyer',{draft:{lines:[]},explain:false});assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.analysis.storeId,'s1');
  assert.ok(result.data.analysis.candidates.every(row=>row.productId==='p1'));assert.ok(!JSON.stringify(result.data).includes('secret-product'));assert.equal(result.data.ai.status,'not-requested');
  assert.equal((await f.request('/api/stores/s1/replenishment','buyer',{storeId:'s2',draft:{lines:[]},explain:false})).status,400);
});
test('replay rechecks current role and store assignments before returning an old command receipt',async t=>{
  const f=await fixture(t);const request=await f.command('credit.request',{storeId:'s1',orderId:delivered.id,subtotalCents:100,taxCents:0,reason:'Price correction'},'buyer');
  const approval={storeId:'s1',creditId:request.id,expectedVersion:request.version};
  await f.command('credit.approve',approval,'owner','approve-once');
  await f.repo.put('users','owner',{...(await f.repo.get('users','owner')),role:'salesman',storeIds:['s1']});
  assert.equal((await f.send('credit.approve',approval,'owner','approve-once')).status,403);
  const count={storeId:'s1',productId:'p1',variant:'Orange',quantity:5,unit:'each',measuredAt:now,expectedVersion:0};
  await f.command('storeInventory.count',count,'buyer','count-once');
  await f.repo.put('users','buyer',{...(await f.repo.get('users','buyer')),storeIds:['s2']});
  assert.equal((await f.send('storeInventory.count',count,'buyer','count-once')).status,403);
  assert.equal((await f.repo.list('ledger')).filter(row=>row.type==='credit').length,1);assert.equal((await f.repo.list('storeInventoryCounts')).length,1);
});
test('Mail placement commands enforce same-store identity and do not create financial charges',async t=>{
  const f=await fixture(t);const draft=await f.command('order.save',{id:'mail-order',storeId:'s1',lines:[{id:'line',productId:'p1',variant:'Orange',quantity:2,unit:'each'}]},'buyer');
  const handoff=await f.command('order.handoff',{id:draft.id,expectedVersion:draft.version},'buyer');
  const placed=await f.command('order.place',{handoffId:handoff.id},'buyer','place-once');
  assert.deepEqual(await f.command('order.place',{handoffId:handoff.id},'buyer','place-once'),placed);assert.equal((await f.repo.list('ledger')).length,0);
  await f.repo.put('orderPlacements','private-placement',{...placed,id:'private-placement',storeId:'s2'});
  assert.equal((await f.send('placement.receive',{id:'private-placement'},'buyer')).status,403);
  assert.equal((await f.request('/api/stores/s1/placements?cursor=private-placement','buyer')).status,403);
  const own=await f.request('/api/stores/s1/placements','buyer');assert.equal(own.status,200);assert.deepEqual(own.data.placements.map(row=>row.id),[placed.id]);
});
test('new operation collections survive owner backup and verified restore',async t=>{
  const f=await fixture(t);const names=['storeInventory','storeInventoryCounts','storeInventoryMovements','storeInventoryReceipts','orderPlacements','orderHandoffs','warehouseMovements','returnEvents'];
  for(const collection of names)await f.repo.put(collection,'sample-'+collection,{id:'sample-'+collection,storeId:'s1',version:1});
  const response=await f.request('/api/admin/backup');assert.equal(response.status,200);
  for(const collection of names)assert.equal(response.data.collections[collection].length,1,collection);
  assert.equal((await f.request('/api/admin/backup','buyer')).status,403);
  const preview=await f.request('/api/admin/restore','owner',{backup:response.data,dryRun:true});assert.equal(preview.status,200,JSON.stringify(preview.data));
  const restored=await f.request('/api/admin/restore','owner',{backup:response.data,dryRun:false,backupId:preview.data.backupId});assert.equal(restored.status,200,JSON.stringify(restored.data));assert.equal(restored.data.verified,true);
  for(const collection of names)assert.equal((await f.repo.list(collection)).length,1,collection);
});
test('mixed fulfillment, attached credits and physical returns share frozen invoice authority end to end',async t=>{
  const f=await fixture(t),oldCredit=await f.command('credit.request',{storeId:'s1',orderId:delivered.id,subtotalCents:100,taxCents:0,reason:'Documented original adjustment'},'buyer');
  let order=await f.command('order.save',{id:'mixed-order',storeId:'s1',creditRequestIds:[oldCredit.id],lines:[{id:'mix',productId:'p1',variant:'',quantity:6,unit:'each',selectionMode:'mix',allowedVariants:['Orange','Lime'],excludedVariants:['Grape']}]},'buyer');
  assert.deepEqual(order.creditRequestIds,[oldCredit.id]);
  order=await f.command('order.submit',{id:order.id,expectedVersion:order.version},'buyer');assert.equal(order.totalCents,600);
  order=await f.command('order.transition',{id:order.id,status:'approved',expectedVersion:order.version},'rep');
  order=await f.command('order.pick',{id:order.id,expectedVersion:order.version,allocations:[{lineId:'mix',variants:[{variant:'Orange',quantity:5},{variant:'Lime',quantity:1}]}]},'rep');
  if(order.status!=='picking')order=await f.command('order.transition',{id:order.id,status:'picking',expectedVersion:order.version},'rep');
  order=await f.command('order.transition',{id:order.id,status:'delivered',expectedVersion:order.version},'rep');
  assert.equal((await f.repo.get('inventory',inventoryId('p1','Orange'))).onHand,95);assert.equal((await f.repo.get('inventory',inventoryId('p1','Lime'))).onHand,99);
  let returned=await f.command('return.create',{storeId:'s1',orderId:order.id,lines:[{lineId:'mix',variant:'Orange',quantity:1}],reason:'Sealed goods',pickupRequested:true},'buyer');
  const adjustment=await f.command('credit.request',{storeId:'s1',orderId:order.id,subtotalCents:500,taxCents:0,reason:'Invoice correction'},'buyer');
  const excess=await f.send('return.create',{storeId:'s1',orderId:order.id,lines:[{lineId:'mix',variant:'Lime',quantity:1}],reason:'Extra return'},'buyer');assert.equal(excess.status,409);assert.equal(excess.data.error.code,'CREDIT_LIMIT');
  returned=await f.command('return.approve',{storeId:'s1',returnId:returned.id,expectedVersion:returned.version,restock:false},'rep');
  await f.command('credit.approve',{storeId:'s1',creditId:adjustment.id,expectedVersion:adjustment.version},'owner','adjustment-once');
  await f.command('credit.approve',{storeId:'s1',creditId:adjustment.id,expectedVersion:adjustment.version},'owner','adjustment-once');
  assert.equal((await f.repo.list('ledger')).filter(row=>row.type==='credit').length,2);
  const invoice=await f.repo.get('orders',order.id);assert.equal(invoice.totalCents,600);assert.equal(invoice.subtotalCents,600);assert.equal(invoice.creditedCents,600);assert.equal(invoice.amountDueCents,0);
  returned=await f.command('return.pickup',{storeId:'s1',returnId:returned.id,expectedVersion:returned.version,lines:[{lineId:'mix',variant:'Orange',quantity:1}]},'rep','pickup-once');
  const receipt={storeId:'s1',returnId:returned.id,expectedVersion:returned.version,lines:[{lineId:'mix',variant:'Orange',quantity:1,disposition:'nonresalable'}]};
  await f.command('return.receive',receipt,'rep','receipt-once');await f.command('return.receive',receipt,'rep','receipt-once');
  assert.equal((await f.repo.get('inventory',inventoryId('p1','Orange'))).onHand,95);
  assert.equal((await f.repo.list('returnEvents')).length,2);assert.equal((await f.repo.list('warehouseMovements')).filter(row=>row.kind==='return-receipt').length,1);assert.equal((await f.repo.list('warehouseMovements')).filter(row=>row.kind==='order-delivery').length,2);
  assert.equal((await f.repo.list('storeInventoryMovements')).filter(row=>row.kind==='return-out').length,1);
});
test('Mail handoff and receipt replay preserve the existing legacy raw-data privacy boundary',async t=>{
  const f=await fixture(t,{orders:[{...delivered,legacy:{rawLines:[{privateNote:'private-import-data'}],needsPriceReview:false}}]});
  const before=await f.request('/api/orders/'+delivered.id,'buyer');assert.equal(before.data.order.legacy.rawLines,undefined);
  const payload={id:delivered.id,expectedVersion:1};
  for(let i=0;i<2;i++){
    const handoff=await f.command('order.handoff',payload,'buyer','private-handoff');
    assert.equal(handoff.snapshot.legacy.rawLines,undefined);
    assert.equal(JSON.stringify(handoff).includes('private-import-data'),false);
  }
});
test('draft Mix rules and attached requests survive command, detail, and live-draft refresh roundtrips',async t=>{
  const f=await fixture(t),credit=await f.command('credit.request',{storeId:'s1',orderId:delivered.id,subtotalCents:100,taxCents:0,reason:'Invoice correction'},'buyer');
  const lines=[{id:'mix',productId:'p1',variant:'',quantity:5,unit:'case',selectionMode:'mix',allowedVariants:['Orange','Lime'],excludedVariants:['Grape'],note:'No substitutes'}];
  const saved=await f.command('order.save',{id:'roundtrip',storeId:'s1',creditRequestIds:[credit.id],lines},'buyer');
  const detail=await f.request('/api/orders/roundtrip','buyer'),refresh=await f.request('/api/drafts?storeId=s1','buyer');
  assert.equal(detail.status,200);assert.equal(refresh.status,200);
  for(const order of [saved,detail.data.order,refresh.data.orders.find(row=>row.id==='roundtrip')]){
    assert.deepEqual(order.creditRequestIds,[credit.id]);assert.equal(order.lines[0].selectionMode,'mix');assert.deepEqual(order.lines[0].allowedVariants,['Orange','Lime']);assert.deepEqual(order.lines[0].excludedVariants,['Grape']);assert.equal(order.lines[0].quantity,5);assert.equal(order.lines[0].unit,'case');
  }
});
test('placed pick-list renders frozen Mail lines, notes and credit attachments after the draft changes',async t=>{
  const rendered=[];
  const f=await fixture(t,{}, {documents:async(order,store,kind)=>{rendered.push({order:structuredClone(order),store,kind});return Buffer.from('%PDF-test');}});
  const credit=await f.command('credit.request',{storeId:'s1',orderId:delivered.id,subtotalCents:100,taxCents:0,reason:'Include this correction'},'buyer');
  let draft=await f.command('order.save',{id:'placed-print',storeId:'s1',notes:'Original delivery note',creditRequestIds:[credit.id],lines:[{id:'line',productId:'p1',variant:'Orange',quantity:2,unit:'each'}]},'buyer');
  const handoff=await f.command('order.handoff',{id:draft.id,expectedVersion:draft.version},'buyer'),placed=await f.command('order.place',{handoffId:handoff.id},'buyer');
  draft=await f.repo.get('orders',draft.id);
  await f.command('order.save',{id:draft.id,storeId:'s1',expectedVersion:draft.version,notes:'Changed unsent draft',creditRequestIds:[],lines:[{id:'changed',productId:'p1',variant:'Lime',quantity:99,unit:'each'}]},'buyer');
  const response=await f.request('/api/documents/placed-print/pick-list','buyer');assert.equal(response.status,200,JSON.stringify(response.data));
  assert.equal(rendered.length,1);assert.equal(rendered[0].kind,'pick-list');assert.equal(rendered[0].order.lines[0].variant,'Orange');assert.equal(rendered[0].order.lines[0].quantity,2);assert.equal(rendered[0].order.notes,'Original delivery note');assert.equal(rendered[0].order.placedAt,placed.placedAt);assert.equal(rendered[0].order.provenance,'mail-confirmed');
  assert.deepEqual(rendered[0].order.creditRequestIds,[credit.id]);assert.deepEqual(rendered[0].order.creditRequests.map(row=>row.id),[credit.id]);
});
test('active placed pick-list uses confirmed Mix allocations before delivery while placement stays frozen',async t=>{
  const rendered=[];
  const f=await fixture(t,{}, {documents:async(order,store,kind)=>{rendered.push({order:structuredClone(order),store,kind});return Buffer.from('%PDF-test');}});
  let order=await f.command('order.save',{id:'confirmed-pick-print',storeId:'s1',lines:[{id:'mix',productId:'p1',variant:'',quantity:6,unit:'each',selectionMode:'mix',allowedVariants:['Orange','Lime'],excludedVariants:['Grape']}]},'buyer');
  order=await f.command('order.submit',{id:order.id,expectedVersion:order.version},'buyer');
  const placed=await f.repo.get('orderPlacements',order.placementId),frozenLines=structuredClone(placed.lines);
  order=await f.command('order.transition',{id:order.id,status:'approved',expectedVersion:order.version},'rep');
  order=await f.command('order.pick',{id:order.id,expectedVersion:order.version,allocations:[{lineId:'mix',variants:[{variant:'Orange',quantity:5},{variant:'Lime',quantity:1}]}]},'rep');
  assert.notDeepEqual(order.lines[0].allocations,frozenLines[0].allocations);
  const response=await f.request('/api/documents/'+order.id+'/pick-list','rep');assert.equal(response.status,200,JSON.stringify(response.data));
  assert.deepEqual(rendered[0].order.lines.map(({warehouseBin,warehouseLocations,bin,...line})=>line),order.lines);assert.deepEqual(rendered[0].order.lines[0].allocations.map(({variant,quantity})=>({variant,quantity})),[{variant:'Orange',quantity:5},{variant:'Lime',quantity:1}]);
  assert.equal(rendered[0].order.placedAt,placed.placedAt);assert.equal(rendered[0].order.provenance,placed.provenance);assert.deepEqual((await f.repo.get('orderPlacements',placed.id)).lines,frozenLines);
});
test('pick-list route reads only relevant configured bins and never mutates confirmed Mix lines or exposes inventory totals',async t=>{
  let printed;
  const f=await fixture(t,{}, {documents:async order=>{printed=structuredClone(order);return Buffer.from('%PDF-test');}});
  for(const [variant,warehouseBin] of [['Orange','A-01'],['Lime','B-02'],['Grape','PRIVATE-UNRELATED-BIN']])await f.command('inventory.configure',{productId:'p1',variant,warehouseBin,expectedVersion:1},'rep');
  let order=await f.command('order.save',{id:'bin-print',storeId:'s1',lines:[{id:'manual',productId:'p1',variant:'Orange',quantity:1,unit:'each'},{id:'mix',productId:'p1',variant:'',quantity:6,unit:'each',selectionMode:'mix',allowedVariants:['Orange','Lime'],excludedVariants:['Grape']}]},'buyer');
  order=await f.command('order.submit',{id:order.id,expectedVersion:order.version},'buyer');
  order=await f.command('order.transition',{id:order.id,status:'approved',expectedVersion:order.version},'rep');
  order=await f.command('order.pick',{id:order.id,expectedVersion:order.version,allocations:[{lineId:'mix',variants:[{variant:'Orange',quantity:5},{variant:'Lime',quantity:1}]}]},'rep');
  const before=await f.repo.get('orders',order.id),reads=[],get=f.repo.get.bind(f.repo);
  f.repo.get=async(collection,id)=>{if(collection==='inventory')reads.push(id);return get(collection,id);};
  const response=await f.request('/api/documents/'+order.id+'/pick-list','rep');assert.equal(response.status,200,JSON.stringify(response.data));
  assert.deepEqual(reads.sort(),[inventoryId('p1','Orange'),inventoryId('p1','Lime')].sort());
  assert.equal(printed.lines[0].warehouseBin,'A-01');assert.equal(printed.lines[1].warehouseBin,'Multiple locations');
  assert.deepEqual(printed.lines[1].warehouseLocations,[{variant:'Orange',bin:'A-01'},{variant:'Lime',bin:'B-02'}]);
  assert.deepEqual(printed.lines[1].allocations,before.lines[1].allocations);assert.deepEqual(await f.repo.get('orders',order.id),before);
  for(const value of ['PRIVATE-UNRELATED-BIN','onHand','unitCostCents','targetEach'])assert.equal(JSON.stringify(printed.lines).includes(value),false,value);
});
