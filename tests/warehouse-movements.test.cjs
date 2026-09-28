const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryRepository}=require('../lib/repository.cjs');
const {executeCommand,inventoryId}=require('../lib/domain.cjs');
const actor={uid:'owner',role:'master'};
test('physical counts and deliveries record shared warehouse movements exactly once',async()=>{
 const product={id:'p',name:'Drink',priceCents:100,variants:[],packSize:12,taxable:false};
 const repo=new MemoryRepository({products:[product],stores:[{id:'s',name:'Shop',taxRateBps:0,priceOverrides:{}}]});let n=0;
 const run=(type,payload,key)=>repo.transaction(tx=>executeCommand(tx,actor,{id:key||'command-'+(++n),type,payload},{now:1800000000000,id:()=> 'record-'+(++n)}));
 await run('inventory.adjust',{productId:'p',variant:'',onHand:30,expectedVersion:0,reason:'Opening count'},'count');
 await run('inventory.adjust',{productId:'p',variant:'',onHand:30,expectedVersion:0,reason:'Opening count'},'count');
 let order=await run('order.save',{id:'o',storeId:'s',lines:[{id:'l',productId:'p',variant:'',unit:'case',quantity:2}]});
 order=await run('order.submit',{id:order.id,expectedVersion:order.version});
 for(const status of ['approved','picking','delivered'])order=await run('order.transition',{id:order.id,expectedVersion:order.version,status});
 await run('order.transition',{id:order.id,expectedVersion:order.version,status:'delivered'});
 const movements=await repo.list('warehouseMovements');assert.equal(movements.length,2);
 assert.equal(movements.find(x=>x.kind==='physical-count').quantityEach,null);
 assert.equal(movements.find(x=>x.kind==='order-delivery').quantityEach,-24);
 assert.equal((await repo.get('inventory',inventoryId('p'))).onHand,6);
});

test('received Mail placements cannot be cancelled as editable drafts',async()=>{
 const repo=new MemoryRepository({products:[{id:'p',name:'Item',variants:[],priceCents:100,taxable:false}],stores:[{id:'s',name:'Shop',taxRateBps:0}]});let n=0;
 const run=(type,payload)=>repo.transaction(tx=>executeCommand(tx,actor,{id:'cmd-'+(++n),type,payload},{now:1800000000000,id:()=> 'r-'+(++n)}));
 const draft=await run('order.save',{id:'o',storeId:'s',lines:[{id:'l',productId:'p',variant:'',quantity:2,unit:'each'}]});
 const handoff=await run('order.handoff',{id:draft.id,expectedVersion:draft.version});
 const placed=await run('order.place',{handoffId:handoff.id});
 await run('placement.receive',{id:placed.id});
 const saved=await repo.get('orders','o');
 await assert.rejects(run('order.transition',{id:'o',expectedVersion:saved.version,status:'cancelled'}),{code:'INVALID_TRANSITION'});
 assert.equal((await repo.get('orderPlacements',placed.id)).receivedAt,1800000000000);
});

test('different staff can reuse a command ID without losing a stock movement',async()=>{
 const key=inventoryId('p');const repo=new MemoryRepository({products:[{id:'p',name:'Item',variants:[]}],inventory:[{id:key,productId:'p',variant:'',onHand:10,reserved:0,version:1}]});
 for(const [uid,onHand,expectedVersion] of [['staff-a',12,1],['staff-b',15,2]])await repo.transaction(tx=>executeCommand(tx,{uid,role:'salesman'},{id:'shared-command',type:'inventory.adjust',payload:{productId:'p',variant:'',onHand,expectedVersion,reason:'Physical count'}},{now:1800000000000}));
 assert.equal((await repo.get('inventory',key)).onHand,15);
 assert.deepEqual((await repo.list('warehouseMovements')).map(x=>x.quantityEach).sort(),[2,3]);
});
