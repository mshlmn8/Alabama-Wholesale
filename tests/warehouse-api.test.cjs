'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{inflateSync}=require('node:zlib');
const {createApp}=require('../server.js');
const {MemoryRepository}=require('../lib/repository.cjs');
const {createAuthService}=require('../lib/auth.cjs');
const {inventoryId}=require('../lib/domain.cjs');
const now=Date.UTC(2026,8,28,12);
const po={id:'po1',purchaseNumber:'PO-2026-00001',supplierId:'supplier1',supplierSnapshot:{id:'supplier1',name:'Synthetic Supplier',email:'private-supplier@example.com',terms:'PRIVATE-TERMS',notes:'PRIVATE-NOTES'},status:'ordered',version:1,createdAt:now-1000,orderedAt:now-1000,expectedAt:now+86400000,totalCostCents:40000,notes:'PRIVATE-PO-NOTE',createdBy:'owner',receiptIds:[],lines:[{id:'pl1',supplierProductId:'mapping1',productId:'p1',variant:'Orange',name:'Orange drink',supplierSku:'SUP-1',quantity:10,originalQuantity:10,unit:'case',packSize:12,eachQuantity:120,orderMultiple:1,unitCostCents:4000,lineCostCents:40000,acceptedQuantity:0,closedQuantity:0,rejectedQuantity:0,outstandingQuantity:10}]};
async function fixture(t,extra={}){
 const repo=new MemoryRepository({users:['owner','rep','buyer'].map((id,index)=>({id,uid:id,role:['master','salesman','customer'][index],email:id+'@example.com',active:true,storeIds:index?['s1']:[]})),stores:[{id:'s1',name:'Shop',taxRateBps:0,version:1}],products:[{id:'p1',name:'Drink',sku:'DRINK',variants:['Orange','Lime'],packSize:12,priceCents:100,active:true,version:1}],inventory:[{id:inventoryId('p1','Orange'),productId:'p1',variant:'Orange',onHand:100,reserved:10,reorderPoint:100,targetEach:240,bin:'A-1',version:1},{id:inventoryId('p1','Lime'),productId:'p1',variant:'Lime',onHand:null,reserved:0,targetEach:48,version:1}],suppliers:[{id:'supplier1',name:'Synthetic Supplier',email:'private-supplier@example.com',terms:'PRIVATE-TERMS',active:true,version:1}],supplierProducts:[{id:'mapping1',supplierId:'supplier1',productId:'p1',variant:'Orange',supplierSku:'SUP-1',unit:'case',packSize:12,orderMultiple:1,unitCostCents:4000,leadTimeDays:3,active:true,version:1}],purchaseOrders:[po],...extra});
 const tokens=Object.fromEntries(['owner','rep','buyer'].map(uid=>[uid,{uid,email:uid+'@example.com',email_verified:true,firebase:{sign_in_provider:uid==='owner'?'google.com':'password'}}]));
 const auth=createAuthService({repo,ownerEmail:'owner@example.com',verifyIdToken:async token=>{if(!tokens[token])throw Error('Invalid identity');return tokens[token];},verifyAppCheckToken:async token=>{if(token!=='valid')throw Error('Invalid app');},requireAppCheck:true});
 const app=createApp({repo,auth,config:{firebaseConfig:{projectId:'test'}},now:()=>now});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const request=async(route,actor='owner',body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${actor}`,'X-Firebase-AppCheck':'valid','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const bytes=Buffer.from(await response.arrayBuffer());let data;try{data=JSON.parse(bytes.toString());}catch{data={};}return {status:response.status,data,bytes,headers:response.headers};};
 let n=0;const send=(type,payload,actor='owner',id='cmd-'+(++n))=>request('/api/commands',actor,{id,type,payload});
 return {repo,request,send};
}
function extracted(pdf){const pages=[];const text=pdf.toString('latin1');for(const match of text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)){let body;try{body=inflateSync(Buffer.from(match[1],'latin1')).toString('latin1');}catch{continue;}const words=[...body.matchAll(/<([0-9a-f]+)>/gi)].map(value=>Buffer.from(value[1],'hex').toString('latin1')).join('').replace(/\s+/g,'');if(words)pages.push(words);}return pages;}

test('warehouse routes deny customers before reading stock, suppliers, POs or receipts',async t=>{
 const f=await fixture(t);let reads=0;const get=f.repo.get.bind(f.repo),list=f.repo.list.bind(f.repo),privateCollections=new Set(['inventory','products','suppliers','supplierProducts','purchaseOrders','purchaseReceipts','warehouseMovements']);
 f.repo.get=async(c,id)=>{if(privateCollections.has(c))reads++;return get(c,id);};f.repo.list=async(c,options)=>{if(privateCollections.has(c))reads++;return list(c,options);};
 for(const route of ['/api/warehouse/state','/api/warehouse/purchase-orders/po1','/api/warehouse/purchase-orders/po1/document'])assert.equal((await f.request(route,'buyer')).status,403);
 assert.equal(reads,0);
});
test('staff warehouse state shows shared stock and inbound suggestions without supplier business data',async t=>{
 const f=await fixture(t),response=await f.request('/api/warehouse/state','rep');assert.equal(response.status,200,JSON.stringify(response.data));assert.match(response.headers.get('cache-control'),/no-store/);
 const stock=response.data.stock.find(row=>row.productId==='p1'&&row.variant==='Orange');assert.equal(stock.onHand,100);assert.equal(stock.reserved,10);assert.equal(stock.availableEach,90);assert.equal(stock.confirmedInboundEach,120);assert.equal(stock.suggestedEach,36);assert.equal(stock.bin,'A-1');
 assert.deepEqual(response.data.suppliers,[]);assert.deepEqual(response.data.supplierProducts,[]);
 const encoded=JSON.stringify(response.data);for(const forbidden of ['unitCostCents','totalCostCents','lineCostCents','PRIVATE-','private-supplier@example.com'])assert.equal(encoded.includes(forbidden),false,forbidden);
 const ordering=await f.request('/api/state','rep');assert.equal(ordering.data.inventory.find(row=>row.variant==='Orange').onHand,stock.onHand);
});
test('owner warehouse state includes confirmed supplier cost and terms while unknown stock stays unknown',async t=>{
 const f=await fixture(t),response=await f.request('/api/warehouse/state');assert.equal(response.status,200,JSON.stringify(response.data));
 assert.equal(response.data.suppliers[0].terms,'PRIVATE-TERMS');assert.equal(response.data.supplierProducts[0].unitCostCents,4000);assert.equal(response.data.purchaseOrders[0].totalCostCents,40000);
 const unknown=response.data.stock.find(row=>row.variant==='Lime');assert.equal(unknown.onHand,null);assert.equal(unknown.availableEach,null);assert.equal(unknown.suggestedEach,null);assert.ok(unknown.warnings.includes('UNKNOWN_STOCK'));
});
test('warehouse bin configuration supersedes a legacy bin value in shared stock',async t=>{
 const f=await fixture(t),saved=await f.send('inventory.configure',{productId:'p1',variant:'Orange',expectedVersion:1,warehouseBin:'B-2'},'rep');assert.equal(saved.status,200,JSON.stringify(saved.data));
 const response=await f.request('/api/warehouse/state','rep');assert.equal(response.data.stock.find(row=>row.variant==='Orange').bin,'B-2');
});
test('staff PO detail and immutable receipt history use nested allowlists',async t=>{
 const receipt={id:'receipt1',purchaseOrderId:'po1',receivedAt:now,createdAt:now,createdBy:'owner',actor:{email:'PRIVATE-ACTOR'},note:'PRIVATE-RECEIPT-NOTE',totalCostCents:12345,lines:[{lineId:'pl1',productId:'p1',variant:'Orange',acceptedQuantity:1,rejectedQuantity:1,rejectedDisposition:'replacement',unitCostCents:4000,nested:{terms:'PRIVATE-NESTED'}}]};
 const f=await fixture(t,{purchaseReceipts:[receipt]}),response=await f.request('/api/warehouse/purchase-orders/po1','rep');assert.equal(response.status,200,JSON.stringify(response.data));
 assert.equal(response.data.purchaseOrder.supplierSnapshot.name,'Synthetic Supplier');assert.equal(response.data.purchaseOrder.lines[0].outstandingQuantity,10);assert.equal(response.data.receipts[0].lines[0].acceptedQuantity,1);
 const encoded=JSON.stringify(response.data);for(const forbidden of ['unitCostCents','totalCostCents','lineCostCents','PRIVATE-','private-supplier@example.com','createdBy'])assert.equal(encoded.includes(forbidden),false,forbidden);
});
test('warehouse movements order by recordedAt and expose physical balances without actor data',async t=>{
 const movement={id:'return-receipt-1',productId:'p1',variant:'Orange',kind:'return-receipt',quantityEach:3,beforeEach:100,afterEach:103,recordedAt:now,createdBy:'owner',actor:{email:'PRIVATE-ACTOR'},note:'PRIVATE-NOTE'};
 const f=await fixture(t,{warehouseMovements:[movement]}),list=f.repo.list.bind(f.repo);let options;
 f.repo.list=async(collection,query)=>{if(collection==='warehouseMovements')options=query;return list(collection,query);};
 const response=await f.request('/api/warehouse/state','rep');assert.equal(response.status,200,JSON.stringify(response.data));assert.deepEqual(options.orderBy,[['recordedAt','desc']]);
 assert.equal(response.data.movements[0].beforeEach,100);assert.equal(response.data.movements[0].afterEach,103);assert.equal(response.data.movements[0].recordedAt,now);assert.equal(JSON.stringify(response.data.movements).includes('PRIVATE-'),false);assert.equal(response.data.movements[0].createdBy,undefined);
});
test('purchase document is owner-only, private, safely named and based on frozen supplier snapshots',async t=>{
 const f=await fixture(t);let reads=0;const get=f.repo.get.bind(f.repo);f.repo.get=async(c,id)=>{if(c==='purchaseOrders')reads++;return get(c,id);};
 assert.equal((await f.request('/api/warehouse/purchase-orders/po1/document','rep')).status,403);assert.equal(reads,0);
 await f.repo.put('suppliers','supplier1',{id:'supplier1',name:'Renamed supplier',terms:'New terms'});
 const response=await f.request('/api/warehouse/purchase-orders/po1/document');assert.equal(response.status,200,JSON.stringify(response.data));assert.match(response.headers.get('content-type'),/application\/pdf/);assert.match(response.headers.get('content-disposition'),/^attachment; filename="[A-Za-z0-9._-]+\.pdf"$/);assert.match(response.headers.get('cache-control'),/no-store/);assert.match(response.bytes.toString('ascii',0,8),/^%PDF-/);
 const text=extracted(response.bytes).join('');assert.ok(text.includes('SyntheticSupplier'));assert.ok(text.includes('PRIVATE-TERMS'));assert.ok(!text.includes('Renamedsupplier'));assert.ok(text.includes('$400.00'));
});
test('bounded PO history warns before purchase suggestions could omit confirmed inbound',async t=>{
 const f=await fixture(t,{purchaseOrders:[po,{...po,id:'po2',createdAt:now+1}]}),response=await f.request('/api/warehouse/state?limit=1');assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.history.complete,false);assert.ok(response.data.history.truncatedCollections.includes('purchaseOrders'));assert.equal(response.data.stock.find(row=>row.variant==='Orange').suggestedEach,null);
});
test('staff receiving response and replay never expose costs and update shared stock once',async t=>{
 const f=await fixture(t),payload={id:'po1',expectedVersion:1,lines:[{lineId:'pl1',acceptedQuantity:1,rejectedQuantity:0,rejectedDisposition:'replacement'}]};
 const first=await f.send('purchase.receive',payload,'rep','receive-once');assert.equal(first.status,200,JSON.stringify(first.data));const again=await f.send('purchase.receive',payload,'rep','receive-once');assert.equal(again.status,200);assert.deepEqual(first.data,again.data);
 for(const forbidden of ['unitCostCents','lineCostCents','totalCostCents','PRIVATE-','private-supplier@example.com'])assert.equal(JSON.stringify(first.data).includes(forbidden),false,forbidden);
 assert.equal((await f.repo.get('inventory',inventoryId('p1','Orange'))).onHand,112);assert.equal((await f.repo.list('purchaseReceipts')).length,1);
 const state=await f.request('/api/state','rep');assert.equal(state.data.inventory.find(row=>row.variant==='Orange').onHand,112);
 await f.repo.put('users','rep',{...(await f.repo.get('users','rep')),role:'customer'});assert.equal((await f.send('purchase.receive',payload,'rep','receive-once')).status,403);
});
test('PO PDF repeats identity and column headings across long documents without losing final rows',async()=>{
 let renderPurchaseOrder;try{({renderPurchaseOrder}=require('../lib/purchase-document.cjs'));}catch{}
 assert.equal(typeof renderPurchaseOrder,'function');
 const lines=Array.from({length:121},(_,i)=>({...po.lines[0],id:'l'+i,supplierSku:'FINAL-SKU-'+String(i).padStart(3,'0'),name:'Product '+i}));
 const pages=extracted(await renderPurchaseOrder({...po,status:'draft',lines,totalCostCents:4840000}));assert.ok(pages.length>3);assert.ok(pages.join('').includes('FINAL-SKU-120'));
 for(const page of pages){assert.ok(page.includes('PO-2026-00001'));assert.ok(page.includes('SyntheticSupplier'));assert.ok(page.includes('QUANTITY'));assert.ok(page.includes('DRAFT'));}
});
test('PO PDF prints an amended zero-quantity line and places metadata before the item headings',async()=>{
 const {renderPurchaseOrder}=require('../lib/purchase-document.cjs');
 const bytes=await renderPurchaseOrder({...po,status:'cancelled',lines:[{...po.lines[0],quantity:0,lineCostCents:0,outstandingQuantity:0}],totalCostCents:0});
 const content=extracted(bytes).join('');assert.ok(content.includes('CANCELLED'));assert.ok(content.includes('0case'));assert.ok(content.indexOf('Supplierterms:')<content.indexOf('ITEM/SUPPLIERSKU'));
});
