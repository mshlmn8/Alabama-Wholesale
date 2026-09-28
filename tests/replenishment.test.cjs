'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {analyze}=require('../lib/replenishment.cjs');
const DAY=86400000,now=Date.UTC(2026,8,28);
const products=[{id:'p1',name:'Drink',variants:['Orange','Lime'],packSize:12}];
const line=(quantity=12,variant='Orange',extra={})=>({id:'l1',productId:'p1',variant,quantity,unit:'each',eachQuantity:quantity,...extra});
const placement=(id,age,lines=[line()],extra={})=>({id,storeId:'s1',orderId:'order-'+id,placedAt:now-age,lines,provenance:'mail-confirmed',...extra});
const input=(extra={})=>({storeId:'s1',products,orders:[],placements:[],counts:[],movements:[],draft:{lines:[]},now,...extra});
test('reference uses strict older-than-96-hour boundary and excludes draft/canceled/cross-store history',()=>{
  const analysis=analyze(input({placements:[placement('boundary',4*DAY),placement('old',4*DAY+1),placement('other',4*DAY+2,[line()],{storeId:'s2'})],orders:[{id:'draft',storeId:'s1',status:'draft',createdAt:now-5*DAY,lines:[line()]},{id:'cancel',storeId:'s1',status:'cancelled',submittedAt:now-5*DAY,lines:[line()]}]}));
  assert.equal(analysis.reference.id,'old');assert.equal(analysis.candidates[0].priorEach,12);assert.equal(analysis.candidates[0].status,'ordered-recently');
  assert.equal(analyze(input({placements:[placement('boundary',4*DAY)]})).reference,null);
});
test('newer placed products are ordered recently while a different flavor is a review',()=>{
  let result=analyze(input({placements:[placement('old',8*DAY),placement('recent',DAY)]}));assert.equal(result.candidates[0].status,'ordered-recently');assert.equal(result.candidates[0].recentOrderAt,now-DAY);
  result=analyze(input({placements:[placement('old',8*DAY)],draft:{lines:[line(12,'Lime')]}}));assert.equal(result.candidates[0].status,'check-flavors');
});
test('additions merge into one family without becoming a newer purchasing cycle',()=>{
  const result=analyze(input({placements:[placement('root',10*DAY),placement('add',6*DAY,[line(5)],{rootPlacementId:'root',parentPlacementId:'root'})]}));
  assert.equal(result.reference.id,'root');assert.equal(result.candidates[0].priorEach,17);assert.equal(result.metrics[0].purchases.cycles,1);
});
test('purchase cadence excludes opening quantity and counts four root cycles over 28 days',()=>{
  const placements=[placement('a',40*DAY,[line(999)]),placement('b',30*DAY,[line(10)]),placement('c',20*DAY,[line(10)]),placement('d',10*DAY,[line(10)]),placement('addition',15*DAY,[line(6)],{rootPlacementId:'a',parentPlacementId:'a'})];
  const result=analyze(input({placements}));const metric=result.metrics[0];assert.equal(metric.purchases.cycles,4);assert.equal(metric.purchases.observedDays,30);assert.equal(metric.purchases.weeklyEach,36/30*7);assert.equal(metric.depletion.eligible,false);assert.equal(metric.depletion.weeklyEach,null);
});
function counts(values=[24,10,8,6]) {return values.map((value,i)=>({id:'c'+i,storeId:'s1',productId:'p1',variant:'Orange',countEach:value,measuredAt:now-(30-i*10)*DAY,recordedAt:now-(30-i*10)*DAY}));}
test('three non-overlapping count intervals incorporate actual receipt and damage without inventing sales',()=>{
  const movements=[{id:'r',storeId:'s1',productId:'p1',variant:'Orange',kind:'receipt',quantityEach:12,effectiveAt:now-25*DAY},{id:'d',storeId:'s1',productId:'p1',variant:'Orange',kind:'damage',quantityEach:-2,effectiveAt:now-22*DAY}];
  const result=analyze(input({counts:counts(),movements}));const rate=result.metrics[0].depletion;assert.equal(rate.intervals[0].depletionEach,24);assert.equal(rate.validIntervals,3);assert.equal(rate.observedDays,30);assert.equal(rate.weeklyEach,28/30*7);assert.equal(rate.eligible,true);
});
test('signed documented non-sale losses reduce depletion and unexplained changes invalidate intervals',()=>{
  const base={id:'m',storeId:'s1',productId:'p1',variant:'Orange',quantityEach:-2,effectiveAt:now-25*DAY,reason:'Recorded loss'};
  let result=analyze(input({counts:counts(),movements:[{...base,kind:'correction'}]}));assert.equal(result.metrics[0].depletion.intervals[0].depletionEach,12);
  result=analyze(input({counts:counts(),movements:[{...base,kind:'unclassified'}]}));assert.equal(result.metrics[0].depletion.validIntervals,2);assert.equal(result.metrics[0].depletion.eligible,false);
  result=analyze(input({counts:counts([2,9,8,6])}));assert.equal(result.metrics[0].depletion.intervals[0].valid,false);assert.equal(result.metrics[0].depletion.intervals[0].depletionEach,-7);
});
test('corrected observations replace originals and late-recorded movements use effective time',()=>{
  const original=counts();const correction={...original[1],id:'replacement',countEach:12,correctionOf:'c1',recordedAt:now};
  const result=analyze(input({counts:[...original,correction],movements:[{id:'late',storeId:'s1',productId:'p1',variant:'Orange',kind:'receipt',quantityEach:12,effectiveAt:now-25*DAY,recordedAt:now}]}));
  assert.equal(result.metrics[0].depletion.validIntervals,3);assert.equal(result.metrics[0].depletion.intervals[0].depletionEach,24);assert.equal(result.metrics[0].depletion.intervals[1].depletionEach,4);
});
test('a Mix request never becomes guaranteed purchases of each allowed flavor',()=>{
  const mix=line(1,'',{selectionMode:'mix',allowedVariants:['Orange','Lime'],excludedVariants:[]});
  let result=analyze(input({placements:[placement('old',8*DAY)],draft:{lines:[mix]}}));assert.equal(result.candidates[0].status,'check-flavors');assert.equal(result.candidates[0].allowedInMix,true);assert.equal(result.candidates[0].currentEach,0);
  result=analyze(input({placements:[placement('old',8*DAY,[mix])]}));assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].priorEach,1);assert.equal(result.candidates[0].selectionMode,'mix');
});
test('unknown units, unavailable variants and incomplete history remain explicit',()=>{
  const result=analyze(input({products:[{...products[0],variants:['Lime']}],placements:[placement('old',8*DAY,[line(2,'Orange',{unit:'case',eachQuantity:undefined,packSize:null})])],history:{complete:false,truncatedCollections:['orders']}}));
  assert.equal(result.candidates[0].priorEach,null);assert.equal(result.candidates[0].status,'unavailable');assert.equal(result.candidates[0].suggestedEach,null);assert.equal(result.history.complete,false);
});
test('migrated legacy rows with reliable dates can compare but inferred units never become confirmed purchases',()=>{
  const result=analyze(input({orders:[{id:'legacy',storeId:'s1',status:'legacy',createdAt:now-10*DAY,legacy:{fulfillmentUnknown:true},lines:[line(12,'Orange',{eachQuantity:undefined,legacy:{unitInferred:true}})]}]}));
  assert.equal(result.reference.provenance,'historical-unverified');assert.equal(result.candidates[0].priorEach,null);assert.equal(result.metrics[0].purchases.eligible,false);assert.equal(result.metrics[0].purchases.cycles,0);
});
test('incomplete history cannot claim a qualified estimate even when loaded samples pass minimum thresholds',()=>{
  const result=analyze(input({counts:counts(),history:{complete:false,truncatedCollections:['storeInventoryMovements']}}));
  assert.equal(result.metrics[0].depletion.eligible,false);assert.equal(result.metrics[0].depletion.weeklyEach,null);assert.ok(result.metrics[0].depletion.warnings.includes('INCOMPLETE_HISTORY'));
});
test('stale last count cannot suppress omission or generate unsupported replenishment quantity',()=>{
  const older=counts().map(count=>({...count,measuredAt:count.measuredAt-8*DAY}));
  const result=analyze(input({placements:[placement('old',5*DAY)],counts:older}));assert.equal(result.candidates[0].latestCount.stale,true);assert.equal(result.candidates[0].status,'missing');assert.equal(result.candidates[0].suggestedEach,null);
});
test('AI explanation validates candidate identities and cannot introduce quantity mutations',async()=>{
  const {explain}=require('../lib/replenishment-ai.cjs');const analysis=analyze(input({placements:[placement('old',8*DAY)]}));
  const context={identity:{uid:'buyer'},headers:{authorization:'Bearer token','x-firebase-appcheck':'token'},config:{firebaseConfig:{projectId:'demo',apiKey:'public',appId:'app'}}};
  let sent;
  const result=await explain(analysis,context,{chat:async(request,ctx)=>{sent={request,ctx};return {text:JSON.stringify({explanations:[{candidateId:analysis.candidates[0].id,text:'Compare this prior item with the draft.'}]}),model:'gemini-test'};}});
  assert.equal(result.available,true);assert.deepEqual(sent.ctx.products,[]);assert.equal(sent.request.text.includes('Drink'),false);
  const invalid=await explain(analysis,context,{chat:async()=>({text:JSON.stringify({explanations:[{candidateId:'not-candidate',text:'Invented',quantity:200}]})})});assert.equal(invalid.available,false);assert.equal(invalid.status,'unavailable');
  const disabled=await explain(analysis,{config:{}},{chat:async()=>{throw Error('Should not run');}});assert.equal(disabled.available,false);
});
test('scoped HTTP history routes page records, deny foreign cursors and flag truncated analysis',async t=>{
  const express=require('express'),{MemoryRepository}=require('../lib/repository.cjs'),{registerStoreRoutes}=require('../lib/store-operation-routes.cjs');
  const repo=new MemoryRepository({stores:[{id:'s1',name:'Store'},{id:'s2',name:'Private'}],products,orders:[],orderPlacements:[placement('old',8*DAY),placement('older',9*DAY),placement('other',10*DAY,[line()],{storeId:'s2'})],storeInventoryCounts:[...counts(),{...counts()[0],id:'foreign',storeId:'s2'}]});
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.actor={uid:'buyer',role:'customer',storeIds:['s1']};req.identity={uid:'buyer'};next();});registerStoreRoutes(app,{repo,now:()=>now,config:{},analysisLimit:1});app.use((error,req,res,next)=>res.status(error.status||500).json({code:error.code}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const url=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url+'/api/stores/s2/inventory')).status,403);
  assert.equal((await fetch(url+'/api/stores/s1/inventory?countsCursor=foreign')).status,403);
  const page=await(await fetch(url+'/api/stores/s1/inventory?limit=2')).json();assert.equal(page.counts.length,2);assert.equal(page.history.complete,false);assert.ok(page.history.nextCountsCursor);
  const response=await fetch(url+'/api/stores/s1/replenishment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({draft:{lines:[]}})});assert.equal(response.status,200);const result=await response.json();assert.equal(result.analysis.history.complete,false);assert.ok(result.analysis.history.truncatedCollections.includes('orderPlacements'));assert.equal(result.ai.available,false);
  assert.equal((await fetch(url+'/api/stores/s1/replenishment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({draft:{lines:[]},storeId:'s2'})})).status,400);
  const metricsOnly=await fetch(url+'/api/stores/s1/replenishment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({draft:{lines:[]},explain:false})});assert.equal(metricsOnly.status,200);assert.equal((await metricsOnly.json()).ai.status,'not-requested');
});
