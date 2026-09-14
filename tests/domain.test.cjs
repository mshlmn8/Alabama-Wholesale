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
test('a payment report can request an invoice allocation without verifying the payment',async()=>{
  const f=fixture();const o=await submitted(f,{quantity:2});
  const p=await f.run('payment.report',{storeId:'s1',amountCents:1000,orderId:o.id},customer);
  assert.equal(p.status,'pending');assert.equal(p.orderId,o.id);assert.equal(f.get('orders',o.id).paidCents,0);
  const verified=await f.run('payment.verify',{paymentId:p.id},salesman);
  assert.deepEqual(verified.allocations,[{orderId:o.id,amountCents:1000}]);assert.equal(verified.unallocatedCents,0);
  const order=f.get('orders',o.id);assert.equal(order.paidCents,1000);assert.equal(order.amountDueCents,1400);assert.equal(order.paymentStatus,'partial');
});
test('invoice targets are checked for store access and finalized snapshots before accepting reports',async()=>{
  const f=fixture();const d=await draft(f);
  await rejectsCode(()=>f.run('payment.report',{storeId:'s1',amountCents:100,orderId:d.id},customer),'INVOICE_NOT_ALLOCATABLE');
  const o=await f.run('order.submit',{id:d.id,expectedVersion:d.version},customer);
  await rejectsCode(()=>f.run('payment.report',{storeId:'s2',amountCents:100,orderId:o.id}),'FORBIDDEN');
  f.db.set('orders/legacy',{id:'legacy',storeId:'s1',status:'legacy',totalCents:1000,legacy:{needsPriceReview:true}});
  await rejectsCode(()=>f.run('payment.report',{storeId:'s1',amountCents:100,orderId:'legacy'},customer),'INVOICE_NOT_ALLOCATABLE');
});
test('verifying a reported overpayment leaves excess unallocated and does not double-charge the ledger',async()=>{
  const f=fixture();const o=await submitted(f);
  const p=await f.run('payment.report',{storeId:'s1',amountCents:2000,orderId:o.id},customer);
  const verified=await f.run('payment.verify',{paymentId:p.id});
  assert.equal(verified.allocatedCents,1200);assert.equal(verified.unallocatedCents,800);assert.equal(storeBalance(f.list('ledger'),'s1'),-800);
  const order=f.get('orders',o.id);assert.equal(order.paymentStatus,'paid');assert.equal(order.amountDueCents,0);assert.equal(order.paidCents,1200);
  await f.run('payment.verify',{paymentId:p.id});assert.equal(f.list('ledger').filter(r=>r.type==='payment').length,1);
});
test('an unbound verified payment credits the account without implicitly paying legacy debt or invoices',async()=>{
  const f=fixture({ledger:[{id:'opening',storeId:'s1',type:'opening',deltaCents:10000}]});const o=await submitted(f);
  const p=await f.run('payment.report',{storeId:'s1',amountCents:5000},customer);const verified=await f.run('payment.verify',{paymentId:p.id});
  assert.deepEqual(verified.allocations,[]);assert.equal(verified.unallocatedCents,5000);assert.equal(f.get('orders',o.id).paidCents,0);assert.equal(f.get('orders',o.id).paymentStatus,'unpaid');assert.equal(storeBalance(f.list('ledger'),'s1'),6200);
});
test('staff can explicitly assign and reassign a verified payment using one complete versioned allocation list',async()=>{
  const f=fixture();const first=await submitted(f),second=await submitted(f,{id:'o2'});
  const p=await f.run('payment.report',{storeId:'s1',amountCents:1500},customer);let verified=await f.run('payment.verify',{paymentId:p.id});
  verified=await f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:first.id,amountCents:1000},{orderId:second.id,amountCents:500}],expectedVersion:verified.version},salesman);
  assert.equal(verified.allocatedCents,1500);assert.equal(f.get('orders',first.id).paidCents,1000);
  verified=await f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:second.id,amountCents:1200}],expectedVersion:verified.version},salesman);
  assert.equal(verified.unallocatedCents,300);assert.equal(f.get('orders',first.id).paidCents,0);assert.equal(f.get('orders',second.id).paidCents,1200);assert.equal(f.list('ledger').filter(r=>r.type==='payment').length,1);
  const event=f.list('audit').filter(a=>a.type==='payment.allocate').at(-1);assert.deepEqual(event.details.before,[{orderId:first.id,amountCents:1000},{orderId:second.id,amountCents:500}]);assert.deepEqual(event.details.after,[{orderId:second.id,amountCents:1200}]);
});
test('allocation totals, repeated invoices and stale versions cannot bypass payment or invoice caps',async()=>{
  const f=fixture();const o=await submitted(f);
  const p=await f.run('payment.report',{storeId:'s1',amountCents:1500},customer);const v=await f.run('payment.verify',{paymentId:p.id});
  await rejectsCode(()=>f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:o.id,amountCents:1600}],expectedVersion:v.version}),'ALLOCATION_LIMIT');
  await rejectsCode(()=>f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:o.id,amountCents:1300}],expectedVersion:v.version}),'ALLOCATION_LIMIT');
  await rejectsCode(()=>f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:o.id,amountCents:500},{orderId:o.id,amountCents:500}],expectedVersion:v.version}),'INVALID_INPUT');
  const allocated=await f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:o.id,amountCents:1000}],expectedVersion:v.version});
  await rejectsCode(()=>f.run('payment.allocate',{paymentId:p.id,allocations:[],expectedVersion:v.version}),'VERSION_CONFLICT');
  assert.equal(f.get('payments',p.id).version,allocated.version);assert.equal(f.get('orders',o.id).paidCents,1000);
});
test('failed multi-invoice allocation rolls back every target and does not spend unallocated funds',async()=>{
  const f=fixture();const o=await submitted(f);const p=await f.run('payment.report',{storeId:'s1',amountCents:2000},customer);const v=await f.run('payment.verify',{paymentId:p.id});
  await rejectsCode(()=>f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:o.id,amountCents:500},{orderId:'missing',amountCents:500}],expectedVersion:v.version}),'NOT_FOUND');
  assert.equal(f.get('payments',p.id).unallocatedCents,2000);assert.equal(f.get('orders',o.id).paidCents,0);
});
test('separate payments cannot cumulatively allocate more than an invoice owes',async()=>{
  const f=fixture();const o=await submitted(f);const p1=await f.run('payment.report',{storeId:'s1',amountCents:800},customer),p2=await f.run('payment.report',{storeId:'s1',amountCents:800},customer);
  const v1=await f.run('payment.verify',{paymentId:p1.id}),v2=await f.run('payment.verify',{paymentId:p2.id});
  await f.run('payment.allocate',{paymentId:p1.id,allocations:[{orderId:o.id,amountCents:800}],expectedVersion:v1.version});
  await rejectsCode(()=>f.run('payment.allocate',{paymentId:p2.id,allocations:[{orderId:o.id,amountCents:800}],expectedVersion:v2.version}),'ALLOCATION_LIMIT');
  assert.equal(f.get('orders',o.id).paidCents,800);assert.equal(f.get('payments',p2.id).unallocatedCents,800);
});
test('customers cannot allocate or verify pending payments, and store assignment applies to allocation',async()=>{
  const f=fixture();const o=await submitted(f);const p=await f.run('payment.report',{storeId:'s1',amountCents:500},customer);
  await rejectsCode(()=>f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:o.id,amountCents:500}],expectedVersion:p.version},customer),'FORBIDDEN');
  await rejectsCode(()=>f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:o.id,amountCents:500}],expectedVersion:p.version},salesman),'INVALID_TRANSITION');
  const v=await f.run('payment.verify',{paymentId:p.id});await rejectsCode(()=>f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:o.id,amountCents:500}],expectedVersion:v.version},{uid:'other-rep',role:'salesman',storeIds:['s2']}),'FORBIDDEN');
});
test('approved returns lower invoice due and a paid invoice then returned exposes its account credit',async()=>{
  const f=fixture();const o=await delivered(f,{quantity:2});const p=await f.run('payment.report',{storeId:'s1',amountCents:2400,orderId:o.id},customer);await f.run('payment.verify',{paymentId:p.id});
  const r=await f.run('return.create',{orderId:o.id,lines:[{lineId:'line1',quantity:1}],reason:'Return'},customer);assert.deepEqual(r.storeSnapshot,o.storeSnapshot);
  await f.run('return.approve',{returnId:r.id,restock:false});
  const order=f.get('orders',o.id);assert.equal(order.paidCents,2400);assert.equal(order.creditedCents,1200);assert.equal(order.amountDueCents,0);assert.equal(order.creditBalanceCents,1200);assert.equal(order.paymentStatus,'credit');assert.equal(storeBalance(f.list('ledger'),'s1'),-1200);
});
test('an approved return limits all future invoice allocations to the remaining net charge',async()=>{
  const f=fixture();const o=await delivered(f,{quantity:2});const r=await f.run('return.create',{orderId:o.id,lines:[{lineId:'line1',quantity:1}],reason:'Return'},customer);await f.run('return.approve',{returnId:r.id,restock:false});
  const p=await f.run('payment.report',{storeId:'s1',amountCents:2000},customer),v=await f.run('payment.verify',{paymentId:p.id});
  await rejectsCode(()=>f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:o.id,amountCents:1500}],expectedVersion:v.version}),'ALLOCATION_LIMIT');
  const allocated=await f.run('payment.allocate',{paymentId:p.id,allocations:[{orderId:o.id,amountCents:1200}],expectedVersion:v.version});assert.equal(allocated.unallocatedCents,800);assert.equal(f.get('orders',o.id).paymentStatus,'paid');
});
test('cancelling a paid order preserves paid money as credit and pending reported money stays unallocated',async()=>{
  const f=fixture();let o=await submitted(f);const p=await f.run('payment.report',{storeId:'s1',amountCents:1200,orderId:o.id},customer);await f.run('payment.verify',{paymentId:p.id});o=f.get('orders',o.id);
  const cancelled=await f.run('order.transition',{id:o.id,status:'cancelled',expectedVersion:o.version});assert.equal(cancelled.paymentStatus,'credit');assert.equal(cancelled.creditBalanceCents,1200);
  let other=await submitted(f,{id:'other'});const pending=await f.run('payment.report',{storeId:'s1',amountCents:1200,orderId:other.id},customer);await f.run('order.transition',{id:other.id,status:'cancelled',expectedVersion:other.version});
  const v=await f.run('payment.verify',{paymentId:pending.id});assert.equal(v.unallocatedCents,1200);assert.deepEqual(v.allocations,[]);assert.equal(v.allocationWarning,'TARGET_CANCELLED');
});
test('notification email consent time is server-owned and survives edits only while enabled',async()=>{
  const f=fixture();let p=await f.run('preferences.save',{notificationPreferences:{email:true,emailEnabledAt:1}},customer);assert.equal(p.notificationPreferences.emailEnabledAt,1789372800000);
  p=await f.run('preferences.save',{theme:'dark',notificationPreferences:{email:true,emailEnabledAt:2},expectedVersion:p.version},customer);assert.equal(p.notificationPreferences.emailEnabledAt,1789372800000);
  p=await f.run('preferences.save',{notificationPreferences:{email:false},expectedVersion:p.version},customer);assert.equal(p.notificationPreferences.emailEnabledAt,null);
});
test('submission rejects a stale reviewed price before stock, invoice or ledger writes',async()=>{
  const f=fixture();const d=await draft(f);await f.run('product.save',{...f.get('products','p1'),variantPricesCents:{Orange:1300},expectedVersion:1});
  await rejectsCode(()=>f.run('order.submit',{id:d.id,expectedVersion:d.version,expectedTotalCents:1200},customer),'PRICE_CHANGED');
  assert.equal(f.get('orders',d.id).status,'draft');assert.equal(f.get('inventory',inventoryId('p1','Orange')).reserved,0);assert.equal(f.list('ledger').length,0);assert.equal(f.list('counters').length,0);
  const order=await f.run('order.submit',{id:d.id,expectedVersion:d.version,expectedTotalCents:1300},customer);assert.equal(order.totalCents,1300);
});
test('simultaneous allocation transactions cannot overspend invoice capacity or duplicate ledger payments',async()=>{
  const {MemoryRepository}=require('../lib/repository.cjs');const f=fixture();const o=await submitted(f);
  const p1=await f.run('payment.report',{storeId:'s1',amountCents:1000},customer),p2=await f.run('payment.report',{storeId:'s1',amountCents:1000},customer);
  const v1=await f.run('payment.verify',{paymentId:p1.id}),v2=await f.run('payment.verify',{paymentId:p2.id});
  const seed={};for(const [key,value] of f.db){const collection=key.slice(0,key.indexOf('/'));(seed[collection]??=[]).push(value);}
  const repo=new MemoryRepository(seed);let generated=0;
  const results=await Promise.allSettled([v1,v2].map((p,i)=>repo.transaction(tx=>executeCommand(tx,master,{id:'race-'+i,type:'payment.allocate',payload:{paymentId:p.id,allocations:[{orderId:o.id,amountCents:1000}],expectedVersion:p.version}},{now:1789372800001,id:()=> 'race-id-'+(++generated)}))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'ALLOCATION_LIMIT');
  assert.equal((await repo.get('orders',o.id)).paidCents,1000);assert.equal((await repo.list('ledger')).filter(l=>l.type==='payment').length,2);
  assert.equal((await repo.list('payments')).reduce((sum,p)=>sum+p.allocatedCents,0),1000);
});
test('retrying the same allocation command is durable and does not change invoice versions twice',async()=>{
  const f=fixture();const o=await submitted(f);const p=await f.run('payment.report',{storeId:'s1',amountCents:500},customer),v=await f.run('payment.verify',{paymentId:p.id});
  const payload={paymentId:p.id,allocations:[{orderId:o.id,amountCents:500}],expectedVersion:v.version};
  const first=await f.run('payment.allocate',payload,salesman,'same-allocation'),version=f.get('orders',o.id).version;
  const second=await f.run('payment.allocate',payload,salesman,'same-allocation');assert.deepEqual(first,second);assert.equal(f.get('orders',o.id).version,version);assert.equal(f.list('audit').filter(a=>a.type==='payment.allocate').length,1);
});
