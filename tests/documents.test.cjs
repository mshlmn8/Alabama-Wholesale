'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {inflateSync}=require('node:zlib');
const {renderDocument}=require('../lib/documents.cjs');
function fixture(overrides={}) {
  return {id:'order-original',storeId:'store1',status:'submitted',invoiceNumber:'AW-2026-000042',createdAt:Date.UTC(2025,0,2,15),submittedAt:Date.UTC(2025,0,3,15),storeSnapshot:{id:'store1',name:'Original store name',address:'123 Original Road\nBirmingham, AL 35203',terms:'Due on receipt'},lines:[{id:'line1',productId:'p1',name:'Orange beverage',sku:'SKU-ORANGE',variant:'Orange',quantity:2,unit:'case',packSize:12,eachQuantity:24,unitPriceCents:1200,lineTotalCents:2400,taxCents:198,taxable:true,note:'Keep cartons upright'}],subtotalCents:2400,taxCents:198,totalCents:2598,notes:'Deliver to receiving.',...overrides};
}
const currentStore={id:'store1',name:'New current store name',address:'999 New address',terms:'Net 90'};
function pdfPages(pdf) {
  const binary=pdf.toString('latin1');const pages=[];
  for(const match of binary.matchAll(/<<(.*?)>>\s*stream\r?\n/gs)) {
    const length=[...match[1].matchAll(/\/Length\s+(\d+)/g)].at(-1);if(!length)continue;
    const start=match.index+match[0].length;
    let content=Buffer.from(binary.slice(start,start+Number(length[1])),'latin1');const pieces=[];
    if(match[1].includes('/FlateDecode'))try{content=inflateSync(content);}catch{continue;}
    for(const text of content.toString('latin1').matchAll(/<([0-9a-fA-F]+)>/g))pieces.push(Buffer.from(text[1],'hex').toString('latin1'));
    pages.push(pieces.join(' '));
  }
  return pages;
}
function pdfText(pdf) {return pdfPages(pdf).join(' ');}
function normalized(pdf) {return pdfText(pdf).replace(/\s+/g,'').toLowerCase();}

test('real invoice PDF uses saved prices, customer snapshot and original order date',async()=>{
  const pdf=await renderDocument(fixture(),currentStore,'invoice');
  assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.match(pdf.toString('latin1'),/%%EOF/);
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,1,'A short invoice should not create footer-only pages.');
  const content=normalized(pdf);
  assert.ok(content.includes('originalstorename'));assert.ok(!content.includes('newcurrentstorename'));
  assert.ok(content.includes('01/03/2025'));assert.ok(content.includes('$25.98'));assert.ok(content.includes('aw-2026-000042'));assert.ok(content.includes('sku-orange'));
});
test('invoice rejects drafts, missing frozen prices, and inconsistent recorded totals',async()=>{
  await assert.rejects(()=>renderDocument(fixture({status:'draft'}),currentStore,'invoice'),{code:'DOCUMENT_NOT_FINAL'});
  await assert.rejects(()=>renderDocument(fixture({lines:[{...fixture().lines[0],unitPriceCents:null}]}),currentStore,'invoice'),{code:'SNAPSHOT_REQUIRED'});
  await assert.rejects(()=>renderDocument(fixture({totalCents:999999}),currentStore,'invoice'),{code:'DOCUMENT_TOTAL_MISMATCH'});
});
test('legacy history cannot masquerade as a finalized invoice and historical copy keeps saved totals',async()=>{
  const legacy=fixture({status:'legacy',createdAt:Date.UTC(2020,4,6,15),submittedAt:null,totalCents:12345,subtotalCents:null,taxCents:null,legacy:{needsPriceReview:true},lines:[{id:'line1',productId:'p1',name:'Saved product',quantity:3,unit:'each'}],billText:'Saved bill: $123.45'});
  await assert.rejects(()=>renderDocument(legacy,currentStore,'invoice'),{code:'SNAPSHOT_REQUIRED'});
  const pdf=await renderDocument(legacy,currentStore,'historical-copy'),content=normalized(pdf);
  assert.ok(content.includes('historicalcopy'));assert.ok(content.includes('$123.45'));assert.ok(content.includes('05/06/2020'));assert.ok(content.includes('pricescannotbereconstructed'));assert.ok(content.includes('savedbill:$123.45'));
});
test('unknown historical date and total stay unknown',async()=>{
  const pdf=await renderDocument(fixture({status:'legacy',createdAt:null,submittedAt:null,totalCents:null,subtotalCents:null,taxCents:null,legacy:{needsPriceReview:true}}),currentStore,'historical-copy');
  assert.ok(normalized(pdf).includes('daterecorded:unknown'));assert.ok(normalized(pdf).includes('recordedtotalunknown'));
});
test('historical text preserves horizontal separators as printable PDF rules',async()=>{
  const billText='Saved total: $25.98\n────────────────────\nOriginal items';
  const pdf=await renderDocument(fixture({status:'legacy',legacy:{needsPriceReview:true},billText}),currentStore,'historical-copy');
  const text=pdfText(pdf);
  assert.ok(normalized(pdf).includes('--------------------'));
  assert.ok(!text.includes('\u0000'),'Unsupported line glyphs must not turn into percent/NUL characters.');
  assert.ok(normalized(pdf).includes('savedtotal:$25.98'));
});
test('pick list and delivery note use explicit case and each quantities without selling prices',async()=>{
  for(const kind of ['pick-list','delivery-note']) {
    const pdf=await renderDocument(fixture(),currentStore,kind),content=normalized(pdf);
    assert.ok(content.includes('2case'));assert.ok(content.includes('24each'));assert.ok(!content.includes('$25.98'));assert.ok(content.includes('sku-orange'));
    if(kind==='delivery-note')assert.ok(content.includes('receivedby'));
  }
});
test('draft pick lists are visibly marked draft and cannot claim delivery',async()=>{
  const pdf=await renderDocument(fixture({status:'draft',invoiceNumber:null}),currentStore,'pick-list');assert.ok(normalized(pdf).includes('draft'));
  await assert.rejects(()=>renderDocument(fixture({status:'draft'}),currentStore,'delivery-note'),{code:'DOCUMENT_NOT_FINAL'});
});
test('multi-page line tables keep every SKU and footer page numbering',async()=>{
  const lines=Array.from({length:120},(_,i)=>({...fixture().lines[0],id:'l'+i,sku:'UNIQUE-'+String(i).padStart(3,'0'),name:'Product '+i+' with a longer description and delicate packaging',note:'Special receiving instruction '.repeat(9)}));
  const pdf=await renderDocument(fixture({lines,subtotalCents:120*2400,taxCents:120*198,totalCents:120*2598}),currentStore,'invoice');
  const content=normalized(pdf);assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g)||[]).length>4);
  for(let i=0;i<120;i++)assert.ok(content.includes(('UNIQUE-'+String(i).padStart(3,'0')).toLowerCase()),'missing line '+i);
  assert.ok(content.includes('page1of'));assert.ok(content.includes('page2of'));
});
test('a long unbroken note flows across pages without dropping its tail',async()=>{
  const note='Longword'.repeat(150)+'END-OF-NOTE';
  const pdf=await renderDocument(fixture({lines:[{...fixture().lines[0],note}]}),currentStore,'invoice');assert.ok(normalized(pdf).includes('end-of-note'));
});
test('approved returns render credit memos with the exact frozen credited amount',async()=>{
  const returned={id:'return1',storeId:'store1',status:'approved',invoiceNumber:'AW-2026-000042',creditMemoNumber:'CM-AW-2026-000042-return1',createdAt:Date.UTC(2026,8,14),approvedAt:Date.UTC(2026,8,15),reason:'Damaged package',lines:[{lineId:'l1',productId:'p1',name:'Orange beverage',sku:'SKU-ORANGE',variant:'Orange',quantity:1,unit:'case',packSize:12,eachQuantity:12,unitPriceCents:1200,subtotalCents:1200,taxCents:99,totalCents:1299}],subtotalCents:1200,taxCents:99,totalCents:1299};
  const pdf=await renderDocument(returned,currentStore,'credit-memo');assert.ok(normalized(pdf).includes('creditmemo'));assert.ok(normalized(pdf).includes('$12.99'));assert.ok(normalized(pdf).includes('damagedpackage'));
  await assert.rejects(()=>renderDocument({...returned,status:'pending'},currentStore,'credit-memo'),{code:'DOCUMENT_NOT_FINAL'});
});
test('unsupported kinds and mismatched store IDs fail before PDF rendering',async()=>{
  await assert.rejects(()=>renderDocument(fixture(),currentStore,'arbitrary'),{code:'INVALID_DOCUMENT'});
  await assert.rejects(()=>renderDocument(fixture(),{...currentStore,id:'another'},'invoice'),{code:'FORBIDDEN'});
});
test('a historical date-only value retains its recorded day across timezones',async()=>{
  const pdf=await renderDocument(fixture({status:'legacy',createdAt:Date.UTC(2020,4,6),submittedAt:null,legacy:{needsPriceReview:true,date:'2020-05-06'}}),currentStore,'historical-copy');
  assert.ok(normalized(pdf).includes('daterecorded:05/06/2020'));
});

test('ordinary item rows stay together across page boundaries',async()=>{
  const lines=Array.from({length:30},(_,i)=>({...fixture().lines[0],id:'l'+i,sku:'ROW-SKU-'+i,name:'A packaged product',note:'End-of-row-'+i}));
  const pdf=await renderDocument(fixture({lines,subtotalCents:30*2400,taxCents:30*198,totalCents:30*2598}),currentStore,'invoice');
  const pages=pdfPages(pdf).map(page=>page.replace(/\s+/g,''));
  for(let i=0;i<30;i++)assert.ok(pages.some(page=>page.includes('ROW-SKU-'+i)&&page.includes('End-of-row-'+i)),'Row split: '+i);
});
