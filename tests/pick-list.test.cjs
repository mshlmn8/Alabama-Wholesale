'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{inflateSync}=require('node:zlib');
const {renderDocument}=require('../lib/documents.cjs');
const store={id:'s1',name:'Example store',address:'101 Warehouse Road'};
function order(extra={}) {return {id:'o1',storeId:'s1',orderNumber:42,status:'draft',createdAt:Date.UTC(2026,8,28),notes:'Deliver at rear entrance.',lines:[{id:'l1',productId:'p1',name:'Orange drink',sku:'DRINK-001',categoryNames:['Beverages'],variant:'Orange',quantity:2,unit:'case',packSize:12,eachQuantity:24,note:'Keep upright',unitPriceCents:10000,lineTotalCents:20000,taxCents:0}],...extra};}
function pages(pdf) {
  const raw=pdf.toString('latin1'),result=[];
  for(const match of raw.matchAll(/<<(.*?)>>\s*stream\r?\n/gs)){
    const length=[...match[1].matchAll(/\/Length\s+(\d+)/g)].at(-1);if(!length)continue;const start=match.index+match[0].length;let data=Buffer.from(raw.slice(start,start+Number(length[1])),'latin1');if(match[1].includes('/FlateDecode'))try{data=inflateSync(data);}catch{continue;}
    const text=[...data.toString('latin1').matchAll(/<([a-f\d]+)>/gi)].map(row=>Buffer.from(row[1],'hex').toString('latin1')).join('');if(text)result.push(text.replace(/\s/g,''));
  }
  return result;
}
test('picker PDF shows structured category, large need, picked and short blanks without prices',async()=>{
  const pdf=await renderDocument(order(),store,'pick-list'),text=pages(pdf).join('');
  for(const phrase of ['PICKLIST','BEVERAGES','NEED','PICKED','SHORT','DRINK-001','24each','Picker','Checker','DRAFT-NOTSUBMITTED'])assert.ok(text.includes(phrase),phrase);
  assert.equal(text.includes('$200.00'),false);assert.equal(text.includes('UNITPRICE'),false);
});
test('Mail placement and addition pick list identify confirmed snapshot and original parent',async()=>{
  const pdf=await renderDocument(order({placementId:'placement',placedAt:Date.UTC(2026,8,27),parentOrderId:'parent',parentReference:'12',additionReference:'12-A1',additionDelivery:'follow-up'}),store,'pick-list'),text=pages(pdf).join('');
  assert.ok(text.includes('ADDITIONTO12'));assert.ok(text.includes('NEWITEMSONLY'));assert.ok(text.includes('12-A1'));assert.ok(text.includes('FOLLOW-UPDELIVERY'));assert.ok(text.includes('PLACEDTHROUGHMAIL'));assert.ok(!text.includes('DRAFT-NOTSUBMITTED'));
});
test('unresolved Mix prints total, allowed and excluded flavors without fake per-flavor quantities',async()=>{
  const mixed={...order().lines[0],variant:'',selectionMode:'mix',allowedVariants:['Orange','Lemon'],excludedVariants:['Grape'],quantity:6,eachQuantity:72};
  const pdf=await renderDocument(order({lines:[mixed]}),store,'pick-list'),text=pages(pdf).join('');
  assert.ok(text.includes('MIX'));assert.ok(text.includes('6case'));assert.ok(text.includes('Allowed:Orange,Lemon'));assert.ok(text.includes('DONOTINCLUDE:Grape'));assert.ok(text.includes('Actualflavors'));assert.ok(!text.includes('Orange:6'));
});
test('return pickups are visibly separated and never expose requested or approved credit amounts',async()=>{
  const creditRequests=[{id:'r1',pickupRequested:true,invoiceNumber:'INV-12',reason:'Leaking bottle',status:'pending',totalCents:123456,lines:[{productId:'p2',name:'Returned bottle',variant:'Grape',quantity:3,unit:'each'}]},{id:'adjustment',kind:'adjustment',pickupRequested:false,reason:'Price issue',lines:[{name:'Price correction',quantity:0,unit:'each'}]}];
  const text=pages(await renderDocument(order({creditRequests}),store,'pick-list')).join('');assert.ok(text.includes('RETURNPICKUPS-DONOTPICKFROMSTOCK'));assert.ok(text.includes('Returnedbottle'));assert.ok(text.includes('INV-12'));assert.ok(!text.includes('Pricecorrection'));assert.ok(!text.includes('$1,234.56'));
});
test('canceled orders cannot generate active pick tickets',async()=>{
  await assert.rejects(()=>renderDocument(order({status:'cancelled'}),store,'pick-list'),{code:'DOCUMENT_CANCELLED'});
});
test('1201-row pick list keeps all lines and repeats store/reference/table headings on each page',async()=>{
  const lines=Array.from({length:1201},(_,i)=>({...order().lines[0],id:'l'+i,sku:'PICK-SKU-'+String(i).padStart(4,'0'),variant:'Flavor '+i}));
  const pdf=await renderDocument(order({lines,status:'submitted',invoiceNumber:'AW-REFERENCE'}),store,'pick-list'),output=pages(pdf),text=output.join('');
  for(let i=0;i<1201;i++)assert.ok(text.includes('PICK-SKU-'+String(i).padStart(4,'0')),'line '+i);
  assert.ok(output.length>20);for(const page of output){assert.ok(page.includes('Examplestore'));assert.ok(page.includes('AW-REFERENCE'));assert.ok(page.includes('PICKED'));assert.ok(page.includes('SHORT'));}
});
test('very long notes wrap without unreadable font shrinking or lost trailing text',async()=>{
  const long='Handling instruction '.repeat(350)+'END-NOTE';const pdf=await renderDocument(order({lines:[{...order().lines[0],note:long}]}),store,'pick-list');const output=pages(pdf);
  assert.ok(output.length>1);assert.ok(output.join('').includes('END-NOTE'));assert.ok(output.at(-1).includes('Orange'));
});
test('approved financial adjustments render as one adjustment, keeping frozen subtotal and tax',async()=>{
  const adjustment={id:'credit1',kind:'adjustment',storeId:'s1',status:'approved',invoiceNumber:'INV-1',creditMemoNumber:'CM-1',subtotalCents:125,taxCents:11,totalCents:136,reason:'Price correction',lines:[{lineId:'l1',productId:'p1',name:'Orange drink',variant:'Orange',quantity:0,eachQuantity:0,unit:'each',unitPriceCents:10000,subtotalCents:125,taxCents:11,totalCents:136}]};
  const text=pages(await renderDocument(adjustment,store,'credit-memo')).join('');assert.ok(text.includes('$1.36'));assert.ok(text.includes('$1.25'));assert.ok(text.includes('Adjustment'));assert.ok(!text.includes('$100.00'));
});
test('pickup list excludes legacy goods already restocked and deduplicates shared request identities',()=>{
  const {pickupsFor}=require('../lib/pick-list.cjs');
  const request={id:'r1',status:'approved',pickupRequested:true,lines:[{lineId:'l1',name:'Bottle',quantity:3,unit:'each'}]};
  assert.equal(pickupsFor({creditRequests:[{...request,restock:true}]}).length,0);
  assert.equal(pickupsFor({creditRequests:[request],returnPickups:[request]}).length,1);
});
test('partial case return pickup prints only the remaining individual units',()=>{
 const {pickupsFor}=require('../lib/pick-list.cjs');
 const rows=pickupsFor({creditRequests:[{id:'partial',status:'approved',pickupRequested:true,lines:[{lineId:'l',variant:'Orange',quantity:2,unit:'case',packSize:12,eachQuantity:24}],physical:{lines:[{lineId:'l',variant:'Orange',pickedQuantity:1}]}}]});
 assert.equal(rows[0].quantity,1);assert.equal(rows[0].eachQuantity,12);
});
test('picker PDF identifies configured bins for manual rows and each actual or allowed Mix flavor',async()=>{
  const {withWarehouseLocations}=require('../lib/pick-list.cjs'),{inventoryId}=require('../lib/domain.cjs');
  const inventory=new Map([[inventoryId('p1','Orange'),{warehouseBin:'A-01',onHand:999,costCents:888}],[inventoryId('p1','Lemon'),{warehouseBin:'B-02'}]]),reads=[];
  const mixed={...order().lines[0],id:'mix',variant:'',selectionMode:'mix',allowedVariants:['Orange','Lemon'],excludedVariants:['Grape'],quantity:6,eachQuantity:72,pickedAt:1,allocations:[{variant:'Orange',quantity:5,eachQuantity:60},{variant:'Lemon',quantity:1,eachQuantity:12}]};
  const source=order({lines:[order().lines[0],mixed]});
  const enriched=await withWarehouseLocations(source,{get:async(collection,id)=>{assert.equal(collection,'inventory');reads.push(id);return inventory.get(id);}});
  assert.equal(reads.length,2);assert.deepEqual(source.lines[1].allocations,enriched.lines[1].allocations);assert.equal(source.lines[0].warehouseBin,undefined);
  const text=pages(await renderDocument(enriched,store,'pick-list')).join('');
  for(const phrase of ['A-01','B-02','MULTIPLELOCATIONS','Confirmedactual:Orange:5case;Lemon:1case','Pickedflavorlocations:Orange:A-01;Lemon:B-02'])assert.ok(text.includes(phrase),phrase);
  const unconfirmed=await withWarehouseLocations(order({lines:[{...mixed,pickedAt:null,allocations:[{variant:'Orange',quantity:6}]}]}),{get:async(collection,id)=>inventory.get(id)});
  const pending=pages(await renderDocument(unconfirmed,store,'pick-list')).join('');assert.ok(pending.includes('Allowedflavorlocations:Orange:A-01;Lemon:B-02'));assert.ok(!pending.includes('Confirmedactual'));assert.ok(!pending.includes('Orange:6'));
});
