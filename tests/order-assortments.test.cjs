'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryRepository}=require('../lib/repository.cjs');
const {executeCommand,inventoryId,calculateOrder}=require('../lib/domain.cjs');
const owner={uid:'owner',role:'master',storeIds:[]};
const buyer={uid:'buyer',role:'customer',storeIds:['s1']};
const product={id:'faygo',name:'Faygo cans',variants:['Orange','Grape','Cola'],priceCents:100,packSize:12,taxable:false,version:1};
const store={id:'s1',name:'One store',taxRateBps:0,priceOverrides:{},version:1};
const mix=(quantity=6,unit='each')=>({id:'l1',productId:'faygo',variant:'',quantity,unit,note:'Top shelf',selectionMode:'mix',allowedVariants:['Orange','Cola'],excludedVariants:['Grape']});
function fixture(stock=100){
 const repo=new MemoryRepository({products:[product],stores:[store],inventory:product.variants.map(variant=>({id:inventoryId(product.id,variant),productId:product.id,variant,onHand:stock,reserved:0,reorderPoint:0,version:1}))});let n=0;
 return {repo,run:(type,payload,actor=owner,key)=>repo.transaction(tx=>executeCommand(tx,actor,{id:key||`c${++n}`,type,payload},{now:1800000000000,id:()=>`r${++n}`}))};
}
async function submit(f,line=mix()){const d=await f.run('order.save',{id:'order',storeId:'s1',lines:[line]},buyer);return f.run('order.submit',{id:d.id,expectedVersion:d.version},buyer);}
test('mix is one priced logical line with preserved exceptions',()=>{
 const order=calculateOrder([mix()], [product], store);
 assert.equal(order.lines.length,1);assert.equal(order.totalCents,600);
 assert.equal(order.lines[0].selectionMode,'mix');assert.deepEqual(order.lines[0].excludedVariants,['Grape']);
});
test('mix differing effective flavor prices requires an exact reviewed split',()=>{
 assert.throws(()=>calculateOrder([mix()], [{...product,variantPricesCents:{Cola:110}}],store),{code:'MIX_PRICE_REVIEW'});
});
test('empty, overlapping and invented assortment flavor sets are rejected',()=>{
 for(const line of [{...mix(),allowedVariants:[]},{...mix(),excludedVariants:['Cola']},{...mix(),allowedVariants:['Made up']}])assert.throws(()=>calculateOrder([line],[product],store));
});
test('submission reserves only the total quantity across allowed flavors',async()=>{
 const f=fixture();const order=await submit(f);assert.equal(order.totalCents,600);
 assert.equal(order.lines[0].allocations.reduce((s,a)=>s+a.quantity,0),6);
 assert.equal((await f.repo.get('inventory',inventoryId('faygo','Grape'))).reserved,0);
 assert.equal((await f.repo.list('inventory')).reduce((s,x)=>s+x.reserved,0),6);
});
test('mix stock allocation accounts for exact lines competing for the same flavor',async()=>{
 const f=fixture(3);const d=await f.run('order.save',{id:'order',storeId:'s1',lines:[{...mix(),quantity:4},{id:'l2',productId:'faygo',variant:'Orange',quantity:3,unit:'each'}]},buyer);
 await assert.rejects(f.run('order.submit',{id:d.id,expectedVersion:d.version},buyer),{code:'INSUFFICIENT_STOCK'});
 assert.equal((await f.repo.list('inventory')).reduce((s,x)=>s+x.reserved,0),0);
});
test('mixed delivery requires actual pick confirmation and preserves frozen invoice',async()=>{
 const f=fixture();let o=await submit(f);
 for(const status of ['approved','picking'])o=await f.run('order.transition',{id:o.id,status,expectedVersion:o.version});
 await assert.rejects(f.run('order.transition',{id:o.id,status:'delivered',expectedVersion:o.version}),{code:'MIX_PICK_REQUIRED'});
 await assert.rejects(f.run('order.pick',{id:o.id,expectedVersion:o.version,allocations:[{lineId:'l1',variants:[{variant:'Grape',quantity:6}]}]}),{code:'INVALID_MIX_ALLOCATION'});
 o=await f.run('order.pick',{id:o.id,expectedVersion:o.version,allocations:[{lineId:'l1',variants:[{variant:'Cola',quantity:5},{variant:'Orange',quantity:1}]}]});
 const total=o.totalCents; o=await f.run('order.transition',{id:o.id,status:'delivered',expectedVersion:o.version});
 assert.equal(o.totalCents,total);assert.equal((await f.repo.get('inventory',inventoryId('faygo','Cola'))).onHand,95);
 assert.equal((await f.repo.get('inventory',inventoryId('faygo','Orange'))).onHand,99);
});
test('cancelled mixed orders release all per-flavor reservations once',async()=>{
 const f=fixture();const o=await submit(f,mix(2,'case'));
 assert.equal((await f.repo.list('inventory')).reduce((s,x)=>s+x.reserved,0),24);
 await f.run('order.transition',{id:o.id,status:'cancelled',expectedVersion:o.version},buyer,'cancel');
 await f.run('order.transition',{id:o.id,status:'cancelled',expectedVersion:o.version},buyer,'cancel');
 assert.equal((await f.repo.list('inventory')).reduce((s,x)=>s+x.reserved,0),0);
});
