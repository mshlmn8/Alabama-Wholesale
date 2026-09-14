'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {executeCommand, calculateOrder, authorizeStore, inventoryId, storeBalance} = require('../lib/domain.cjs');
const master = {uid:'owner',role:'master',storeIds:[]};
const salesman = {uid:'rep',role:'salesman',storeIds:['s1']};
const customer = {uid:'buyer',role:'customer',storeIds:['s1']};
function fixture(extra={}) {
  const db = new Map();
  const initial = {
    products:[{id:'p1',name:'Example drink',categoryIds:['c1'],variants:['Orange','Lime'],priceCents:1000,variantPricesCents:{Orange:1200},packSize:12,taxable:true,version:1}],
    categories:[{id:'c1',name:'Drinks',version:1}],
    stores:[{id:'s1',name:'Store one',taxRateBps:0,creditLimitCents:null,priceOverrides:{},version:1},{id:'s2',name:'Store two',taxRateBps:0,creditLimitCents:null,version:1}],
    inventory:[{id:inventoryId('p1','Orange'),productId:'p1',variant:'Orange',onHand:100,reserved:0,reorderPoint:10,version:1}],
    ...extra
  };
  for (const [c,records] of Object.entries(initial)) for (const r of records) db.set(c+'/'+r.id, structuredClone(r));
  let n=0;
  return {
    db,
    get(c,id) {return structuredClone(db.get(c+'/'+id));},
    list(c) {return [...db].filter(([k])=>k.startsWith(c+'/')).map(([,v])=>structuredClone(v));},
    async run(type,payload={},actor=master,commandId='cmd-'+(++n)) {
      const working = new Map(structuredClone([...db]));
      const tx={
        async get(c,id){return structuredClone(working.get(c+'/'+id));},
        async list(c){return [...working].filter(([k])=>k.startsWith(c+'/')).map(([,v])=>structuredClone(v));},
        async set(c,id,v){working.set(c+'/'+id,structuredClone(v));},
        async delete(c,id){working.delete(c+'/'+id);}
      };
      const result=await executeCommand(tx,actor,{id:commandId,type,payload},{now:1789372800000,id:()=> 'generated-'+(++n)});
      db.clear(); for(const [key,value] of working) db.set(key,value);
      return result;
    }
  };
}
const lines=(quantity=1,unit='each')=>[{id:'line1',productId:'p1',variant:'Orange',quantity,unit,note:''}];
async function draft(f,{quantity=1,unit='each',actor=customer,id='o1'}={}) {return f.run('order.save',{id,storeId:'s1',lines:lines(quantity,unit),notes:'Please deliver'},actor);}
async function submitted(f,opts={}) {const order=await draft(f,opts);return f.run('order.submit',{id:order.id,expectedVersion:order.version},opts.actor||customer);}
async function delivered(f,opts={}) {let o=await submitted(f,opts);for(const status of ['approved','picking','delivered'])o=await f.run('order.transition',{id:o.id,status,expectedVersion:o.version});return o;}
const rejectsCode = (fn,code) => assert.rejects(fn,e=>e.code===code);

test('a verified $20 payment reduces a $100 debt to $80; reporting does not',async()=>{
  const f=fixture({ledger:[{id:'opening',storeId:'s1',deltaCents:10000,type:'opening'}]});
  const p=await f.run('payment.report',{storeId:'s1',amountCents:2000,method:'cash'},customer);
  assert.equal(p.status,'pending');assert.equal(storeBalance(f.list('ledger'),'s1'),10000);
  await f.run('payment.verify',{paymentId:p.id},salesman);
  assert.equal(storeBalance(f.list('ledger'),'s1'),8000);
  await f.run('payment.verify',{paymentId:p.id},salesman);
  assert.equal(storeBalance(f.list('ledger'),'s1'),8000);
});
test('duplicate submit command returns the exact original and posts one invoice charge',async()=>{
  const f=fixture();const d=await draft(f);const p={id:d.id,expectedVersion:d.version};
  const a=await f.run('order.submit',p,customer,'submit-once');
  const b=await f.run('order.submit',p,customer,'submit-once');
  assert.deepEqual(a,b);assert.equal(f.list('ledger').length,1);assert.equal(f.list('orders').length,1);
  const c=await f.run('order.submit',{id:d.id,expectedVersion:a.version},customer,'different-command');
  assert.equal(c.invoiceNumber,a.invoiceNumber);assert.equal(f.list('ledger').length,1);
});
test('a command ID reused for different input fails instead of silently accepting stale content',async()=>{
  const f=fixture();await f.run('payment.report',{storeId:'s1',amountCents:10},customer,'fixed');
  await rejectsCode(()=>f.run('payment.report',{storeId:'s1',amountCents:20},customer,'fixed'),'COMMAND_CONFLICT');
});
test('cross-store customer writes are denied and staff roles cannot be supplied in payload',async()=>{
  const f=fixture();assert.throws(()=>authorizeStore(customer,'s2'),{code:'FORBIDDEN'});
  await rejectsCode(()=>f.run('payment.report',{storeId:'s2',amountCents:100,role:'master'},customer),'FORBIDDEN');
  await rejectsCode(()=>f.run('product.save',{id:'hacked',name:'Hacked',role:'master'},customer),'FORBIDDEN');
  await rejectsCode(()=>f.run('payment.verify',{paymentId:'missing'},customer),'FORBIDDEN');
  assert.equal(f.list('payments').length,0);
});
test('optimistic versions preserve the first writer rather than overwriting it',async()=>{
  const f=fixture();const d=await draft(f);await f.run('order.save',{...d,notes:'First edit',expectedVersion:1},customer);
  await rejectsCode(()=>f.run('order.save',{...d,notes:'Stale edit',expectedVersion:1},customer),'VERSION_CONFLICT');
  assert.equal(f.get('orders','o1').notes,'First edit');
});
test('submitted prices and dates remain frozen after product pricing changes',async()=>{
  const f=fixture();const o=await submitted(f,{quantity:2});
  await f.run('product.save',{...f.get('products','p1'),priceCents:9999,variantPricesCents:{Orange:7777},expectedVersion:1});
  const saved=f.get('orders',o.id);assert.equal(saved.totalCents,2400);assert.equal(saved.lines[0].unitPriceCents,1200);assert.equal(saved.submittedAt,1789372800000);
});
test('quantities reject malformed, negative, fractional, nonfinite and unsafe numeric input',()=>{
  const f=fixture();for(const quantity of ['2abc','2',0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER]){
    assert.throws(()=>calculateOrder(lines(quantity),f.list('products'),f.get('stores','s1')));
  }
});
test('unknown products, variants and prices cannot become a charge',()=>{
  const f=fixture();assert.throws(()=>calculateOrder([{...lines()[0],productId:'unknown'}],f.list('products'),f.get('stores','s1')),{code:'INVALID_PRODUCT'});
  assert.throws(()=>calculateOrder([{...lines()[0],variant:'fake'}],f.list('products'),f.get('stores','s1')),{code:'INVALID_VARIANT'});
  const ps=f.list('products');ps[0].priceCents=null;ps[0].variantPricesCents={};assert.throws(()=>calculateOrder(lines(),ps,f.get('stores','s1')),{code:'PRICE_REQUIRED'});
});
test('case quantities use explicit pack sizes and store prices override catalog prices, including zero',()=>{
  const f=fixture();const store={...f.get('stores','s1'),taxRateBps:825,priceOverrides:{p1:{priceCents:900,variantPricesCents:{Orange:500}}}};
  const out=calculateOrder(lines(2,'case'),f.list('products'),store);
  assert.equal(out.lines[0].eachQuantity,24);assert.equal(out.lines[0].unitPriceCents,6000);assert.equal(out.subtotalCents,12000);assert.equal(out.taxCents,990);assert.equal(out.totalCents,12990);
  store.priceOverrides.p1=0;assert.equal(calculateOrder(lines(),f.list('products'),store).totalCents,0);
});
test('case lines require a known positive pack size and duplicate line IDs are rejected',()=>{
  const f=fixture();const p=f.list('products');p[0].packSize=null;
  assert.throws(()=>calculateOrder(lines(1,'case'),p,f.get('stores','s1')),{code:'PACK_SIZE_REQUIRED'});
  assert.throws(()=>calculateOrder([...lines(),...lines()],f.list('products'),f.get('stores','s1')),{code:'INVALID_INPUT'});
});
test('known stock is reserved once, cannot be oversold, and is consumed on delivery',async()=>{
  const f=fixture();let o=await submitted(f,{quantity:60});assert.equal(f.get('inventory',inventoryId('p1','Orange')).reserved,60);
  const d=await draft(f,{quantity:50,id:'o2'});
  await rejectsCode(()=>f.run('order.submit',{id:d.id,expectedVersion:d.version},customer),'INSUFFICIENT_STOCK');
  assert.equal(f.list('ledger').length,1);assert.equal(f.get('orders','o2').status,'draft');
  for(const status of ['approved','picking','delivered'])o=await f.run('order.transition',{id:o.id,status,expectedVersion:o.version},salesman);
  const stock=f.get('inventory',inventoryId('p1','Orange'));assert.equal(stock.onHand,40);assert.equal(stock.reserved,0);
});
test('multiple lines of the same SKU aggregate stock reservations',async()=>{
  const f=fixture();const d=await f.run('order.save',{id:'dup',storeId:'s1',lines:[...lines(60),{...lines(60)[0],id:'line2'}]},customer);
  await rejectsCode(()=>f.run('order.submit',{id:d.id,expectedVersion:d.version},customer),'INSUFFICIENT_STOCK');
  assert.equal(f.get('inventory',inventoryId('p1','Orange')).reserved,0);
});
test('unknown stock stays unknown and is flagged, not invented',async()=>{
  const f=fixture({inventory:[]});const o=await submitted(f);
  assert.equal(o.inventoryWarnings.length,1);assert.equal(f.list('inventory').length,0);
});
test('cancellation releases stock and reverses the invoice once',async()=>{
  const f=fixture();let o=await submitted(f,{quantity:2});o=await f.run('order.transition',{id:o.id,status:'cancelled',expectedVersion:o.version},customer);
  assert.equal(f.get('inventory',inventoryId('p1','Orange')).reserved,0);assert.equal(storeBalance(f.list('ledger'),'s1'),0);
  await f.run('order.transition',{id:o.id,status:'cancelled',expectedVersion:o.version},customer);
  assert.equal(f.list('ledger').length,2);
});
test('customer cannot approve orders, cancel after approval, or edit another buyer draft',async()=>{
  const f=fixture();let o=await submitted(f);await rejectsCode(()=>f.run('order.transition',{id:o.id,status:'approved',expectedVersion:o.version},customer),'FORBIDDEN');
  o=await f.run('order.transition',{id:o.id,status:'approved',expectedVersion:o.version});
  await rejectsCode(()=>f.run('order.transition',{id:o.id,status:'cancelled',expectedVersion:o.version},customer),'FORBIDDEN');
  const d=await draft(f,{id:'other'});await rejectsCode(()=>f.run('order.save',{...d,notes:'not mine',expectedVersion:d.version},{...customer,uid:'another'}),'FORBIDDEN');
});
test('workflow cannot skip picking and delivered orders cannot be cancelled',async()=>{
  const f=fixture();const o=await submitted(f);await rejectsCode(()=>f.run('order.transition',{id:o.id,status:'delivered',expectedVersion:o.version}),'INVALID_TRANSITION');
  const d=await delivered(f,{id:'delivered'});await rejectsCode(()=>f.run('order.transition',{id:d.id,status:'cancelled',expectedVersion:d.version}),'INVALID_TRANSITION');
});
test('zero credit limit is respected; pending payments do not create buying power',async()=>{
  const f=fixture();await f.run('store.save',{...f.get('stores','s1'),creditLimitCents:0,expectedVersion:1});
  await f.run('payment.report',{storeId:'s1',amountCents:10000},customer);
  const d=await draft(f);await rejectsCode(()=>f.run('order.submit',{id:d.id,expectedVersion:d.version},customer),'CREDIT_LIMIT');
});
test('payment amount cannot be zero, negative, malformed, nonfinite or an unsafe integer',async()=>{
  for(const amountCents of [-2000,0,1.1,'2000',Infinity,Number.MAX_SAFE_INTEGER]){
    const f=fixture();await rejectsCode(()=>f.run('payment.report',{storeId:'s1',amountCents},customer),'INVALID_INPUT');
  }
});
test('return credits frozen prices only after approval and restocking is explicit',async()=>{
  const f=fixture();const o=await delivered(f,{quantity:3});const r=await f.run('return.create',{orderId:o.id,lines:[{lineId:'line1',quantity:2}],reason:'Damaged package'},customer);
  assert.equal(storeBalance(f.list('ledger'),'s1'),3600);assert.equal(r.status,'pending');
  const approved=await f.run('return.approve',{returnId:r.id,restock:false},salesman);assert.equal(approved.totalCents,2400);assert.equal(storeBalance(f.list('ledger'),'s1'),1200);assert.equal(f.get('inventory',inventoryId('p1','Orange')).onHand,97);
  await f.run('return.approve',{returnId:r.id,restock:false},salesman);assert.equal(storeBalance(f.list('ledger'),'s1'),1200);
  const r2=await f.run('return.create',{orderId:o.id,lines:[{lineId:'line1',quantity:1}],reason:'Wrong flavor'},customer);
  await f.run('return.approve',{returnId:r2.id,restock:true},salesman);assert.equal(f.get('inventory',inventoryId('p1','Orange')).onHand,98);
});
test('return requests reserve refundable quantities; pending plus approved cannot exceed delivery',async()=>{
  const f=fixture();const o=await delivered(f,{quantity:2});await f.run('return.create',{orderId:o.id,lines:[{lineId:'line1',quantity:2}],reason:'Return'},customer);
  await rejectsCode(()=>f.run('return.create',{orderId:o.id,lines:[{lineId:'line1',quantity:1}],reason:'Again'},customer),'RETURN_QUANTITY');
  await rejectsCode(()=>f.run('return.create',{orderId:o.id,lines:[{lineId:'line1',quantity:1},{lineId:'line1',quantity:1}],reason:'Duplicate'},customer),'INVALID_INPUT');
});
test('return tax rounding across partial returns never overcredits the original tax',async()=>{
  const f=fixture({products:[{id:'p1',name:'Tiny',variants:['Orange'],priceCents:1,packSize:1,taxable:true,version:1}],stores:[{id:'s1',name:'Tax store',taxRateBps:2500,creditLimitCents:null,version:1}]});
  const o=await delivered(f,{quantity:3});assert.equal(o.totalCents,4);
  for(let i=0;i<3;i++){const r=await f.run('return.create',{orderId:o.id,lines:[{lineId:'line1',quantity:1}],reason:'Partial'},customer);await f.run('return.approve',{returnId:r.id,restock:false});}
  assert.equal(storeBalance(f.list('ledger'),'s1'),0);
});
test('inventory adjustments require a reason, current version, and cannot dip below reservations',async()=>{
  const f=fixture();await submitted(f,{quantity:10});const inv=f.get('inventory',inventoryId('p1','Orange'));
  await rejectsCode(()=>f.run('inventory.adjust',{productId:'p1',variant:'Orange',onHand:5,reorderPoint:1,reason:'Count',expectedVersion:inv.version}),'RESERVED_STOCK');
  await rejectsCode(()=>f.run('inventory.adjust',{productId:'p1',variant:'Orange',onHand:100,reorderPoint:1,reason:'',expectedVersion:inv.version}),'INVALID_INPUT');
  const next=await f.run('inventory.adjust',{productId:'p1',variant:'Orange',onHand:80,reorderPoint:15,reason:'Physical count',expectedVersion:inv.version},salesman);assert.equal(next.onHand,80);assert.equal(next.reserved,10);
});
test('store edits match record ID and preserve explicit zero terms without touching peers',async()=>{
  const f=fixture();const s=await f.run('store.save',{...f.get('stores','s1'),phone:'123',creditLimitCents:0,terms:'Due on receipt',expectedVersion:1});
  assert.equal(s.creditLimitCents,0);assert.equal(f.get('stores','s2').phone,undefined);
});
test('preferences are scoped to the authenticated user and favorites only authorized stores',async()=>{
  const f=fixture();const p=await f.run('preferences.save',{uid:'owner',theme:'dark',favorites:{s1:['p1']},notificationPreferences:{inApp:true,email:false}},customer);
  assert.equal(p.id,'buyer');assert.equal(f.get('preferences','owner'),undefined);
  await rejectsCode(()=>f.run('preferences.save',{favorites:{s2:['p1']},expectedVersion:p.version},customer),'FORBIDDEN');
});
test('notifications cannot be read on behalf of other users or other stores',async()=>{
  const f=fixture({notifications:[{id:'secret',storeId:'s2',message:'private',readBy:[]},{id:'own',storeId:'s1',message:'own',readBy:[]}]});
  await rejectsCode(()=>f.run('notification.read',{id:'secret'},customer),'FORBIDDEN');
  const n=await f.run('notification.read',{id:'own',uid:'owner'},customer);assert.deepEqual(n.readBy,['buyer']);
});
test('catalog and category writes validate structured fields and omit privilege injection',async()=>{
  const f=fixture();const category=await f.run('category.save',{id:'new',name:'New category'});assert.equal(category.version,1);
  const p=await f.run('product.save',{id:'newp',name:'New product',categoryIds:['new'],variants:[],priceCents:0,packSize:1,role:'master'});
  assert.equal(p.role,undefined);assert.equal(p.priceCents,0);
  await rejectsCode(()=>f.run('product.save',{id:'bad',name:'Bad',priceCents:-1}),'INVALID_INPUT');
  await rejectsCode(()=>f.run('category.save',{id:'new',name:'Overwrite without version'}),'VERSION_CONFLICT');
});
test('all successful mutations have durable receipts and audit events with authenticated actor',async()=>{
  const f=fixture();await draft(f);assert.equal(f.list('commandReceipts').length,1);assert.equal(f.list('audit').length,1);assert.equal(f.list('audit')[0].actorUid,'buyer');
});
test('invalid actors and unsupported command types are rejected',async()=>{
  const f=fixture();await rejectsCode(()=>f.run('order.save',{}, {uid:'anon',role:'anonymous',storeIds:[]}),'UNAUTHENTICATED');
  await rejectsCode(()=>f.run('unknown',{}),'INVALID_COMMAND');
});
test('migration-blocked stores cannot post finances until explicit owner reconciliation',async()=>{
  const f=fixture({stores:[{id:'s1',name:'Review needed',taxRateBps:0,creditLimitCents:null,migrationBlocked:true,version:1}],ledger:[{id:'opening',storeId:'s1',type:'opening',deltaCents:10000}]});
  const d=await draft(f);await rejectsCode(()=>f.run('order.submit',{id:d.id,expectedVersion:d.version},customer),'RECONCILIATION_REQUIRED');
  const p=await f.run('payment.report',{storeId:'s1',amountCents:2000},customer);await rejectsCode(()=>f.run('payment.verify',{paymentId:p.id}),'RECONCILIATION_REQUIRED');
  await rejectsCode(()=>f.run('migration.reconcile',{storeId:'s1',openingBalanceCents:8000,reason:'Verified paper ledger',expectedVersion:1},salesman),'FORBIDDEN');
  const result=await f.run('migration.reconcile',{storeId:'s1',openingBalanceCents:8000,reason:'Verified paper ledger',expectedVersion:1});
  assert.equal(result.migrationBlocked,false);assert.equal(storeBalance(f.list('ledger'),'s1'),8000);assert.equal(f.get('ledger','opening').deltaCents,10000);
  await f.run('payment.verify',{paymentId:p.id});assert.equal(storeBalance(f.list('ledger'),'s1'),6000);
});
test('recovered drafts require a conscious review before they can create invoices',async()=>{
  const f=fixture({orders:[{id:'recovered',storeId:'s1',lines:lines(),status:'draft',createdBy:'buyer',version:1,legacy:{requiresReview:true},migrationBlocked:true}]});
  await rejectsCode(()=>f.run('order.submit',{id:'recovered',expectedVersion:1},customer),'LEGACY_REVIEW_REQUIRED');
  const d=await f.run('order.save',{id:'recovered',storeId:'s1',lines:lines(),acknowledgeLegacyReview:true,expectedVersion:1},customer);
  assert.equal(d.legacy.requiresReview,false);assert.equal(d.migrationBlocked,false);
  const o=await f.run('order.submit',{id:d.id,expectedVersion:d.version},customer);assert.equal(o.status,'submitted');
});
test('draft legacy flags cannot be bypassed by client-supplied legacy objects',async()=>{
  const f=fixture({orders:[{id:'recovered',storeId:'s1',lines:lines(),status:'draft',createdBy:'buyer',version:1,legacy:{requiresReview:true}}]});
  const d=await f.run('order.save',{id:'recovered',lines:lines(),legacy:{requiresReview:false},expectedVersion:1},customer);
  await rejectsCode(()=>f.run('order.submit',{id:d.id,expectedVersion:d.version},customer),'LEGACY_REVIEW_REQUIRED');
});
