'use strict';
const {helpers:h}=require('./domain.cjs');
const {analyze}=require('./replenishment.cjs');
const ai=require('./replenishment-ai.cjs');
function keysOnly(value,keys,label) {h.object(value,label);if(Object.keys(value).some(key=>!keys.includes(key)))h.fail('INVALID_INPUT',`${label} contains unsupported fields.`);}
function registerStoreRoutes(app,{repo,now=Date.now,config={},consumeAiBudget,chatAssistant,analysisLimit=5000}) {
  h.integer(analysisLimit,'Analysis history limit',{min:1,max:20000});
  async function storeFor(req) {
    const id=h.recordId(req.params.storeId,'Store ID');h.authorizeStore(req.actor,id);const store=await h.required(repo,'stores',id,'Store');if(store.active===false)h.fail('NOT_FOUND','Store was not found.',404);return store;
  }
  async function page(collection,storeId,{limit,cursor,orderField}) {
    if(cursor) {h.recordId(cursor,'History cursor');const anchor=await h.required(repo,collection,cursor,'History cursor');if(anchor.storeId!==storeId)h.fail('FORBIDDEN','This history cursor belongs to another store.',403);}
    const rows=await repo.list(collection,{where:[['storeId','==',storeId]],orderBy:[[orderField,'desc'],['id','desc']],limit:limit+1,...(cursor?{startAfter:cursor}:{})});
    return {rows:rows.slice(0,limit),next:rows.length>limit?rows[limit-1].id:null};
  }
  const limitFor=req=>req.query.limit===undefined?100:h.integer(/^[0-9]+$/.test(req.query.limit)?Number(req.query.limit):NaN,'Page size',{min:1,max:500});
  app.get('/api/stores/:storeId/inventory',async(req,res)=>{
    const store=await storeFor(req);keysOnly(req.query,['limit','countsCursor','movementsCursor','recordsCursor'],'History query');const limit=limitFor(req);
    const [records,counts,movements]=await Promise.all([page('storeInventory',store.id,{limit,cursor:req.query.recordsCursor,orderField:'updatedAt'}),page('storeInventoryCounts',store.id,{limit,cursor:req.query.countsCursor,orderField:'recordedAt'}),page('storeInventoryMovements',store.id,{limit,cursor:req.query.movementsCursor,orderField:'recordedAt'})]);
    res.json({records:records.rows,counts:counts.rows,movements:movements.rows,history:{complete:!records.next&&!counts.next&&!movements.next,nextRecordsCursor:records.next,nextCountsCursor:counts.next,nextMovementsCursor:movements.next}});
  });
  app.get('/api/stores/:storeId/placements',async(req,res)=>{
    const store=await storeFor(req);keysOnly(req.query,['limit','cursor'],'Placement query');const result=await page('orderPlacements',store.id,{limit:limitFor(req),cursor:req.query.cursor,orderField:'placedAt'});
    res.json({placements:result.rows,history:{complete:!result.next,nextCursor:result.next}});
  });
  app.post('/api/stores/:storeId/replenishment',async(req,res)=>{
    const store=await storeFor(req);keysOnly(req.body,['draft','explain'],'Replenishment request');keysOnly(req.body.draft,['lines'],'Draft');const requestedExplanation=h.bool(req.body.explain,'Gemini explanation',true);
    if(!Array.isArray(req.body.draft.lines)||req.body.draft.lines.length>10000)h.fail('INVALID_INPUT','Draft has too many lines.');
    const lines=h.draftLines(req.body.draft.lines),analyzedAt=now(),collections=['orders','orderPlacements','storeInventoryCounts','storeInventoryMovements','storeInventory'];
    const snapshots=await Promise.all(collections.map(collection=>repo.list(collection,{where:[['storeId','==',store.id]],limit:analysisLimit+1})));
    const truncatedCollections=collections.filter((name,index)=>snapshots[index].length>analysisLimit),[orders,placements,counts,movements,inventory]=snapshots.map(rows=>rows.slice(0,analysisLimit));
    const targetMap=new Map(inventory.map(row=>[JSON.stringify([row.productId,row.variant||'']),row.targetEach]));
    const productIds=[...new Set([...lines,...orders.flatMap(order=>order.lines||[]),...placements.flatMap(placement=>placement.lines||[]),...counts].map(row=>row.productId))];
    const products=(await Promise.all(productIds.map(id=>repo.get('products',h.recordId(id,'Product ID'))))).filter(Boolean).map(product=>({id:product.id,name:product.name,variants:product.variants,packSize:product.packSize,active:product.active,deleted:product.deleted,standardVariantEnabled:product.standardVariantEnabled}));
    const analysis=analyze({storeId:store.id,products,orders,placements,counts:counts.filter(row=>(row.recordedAt??0)<=analyzedAt).map(row=>({...row,targetEach:targetMap.get(JSON.stringify([row.productId,row.variant||'']))})),movements:movements.filter(row=>(row.recordedAt??0)<=analyzedAt),draft:{lines},now:analyzedAt,history:{complete:truncatedCollections.length===0,truncatedCollections}});
    let explanation;
    if(!requestedExplanation)explanation={available:false,status:'not-requested',explanations:[]};
    else if(ai.configured(config)&&analysis.candidates.length) {
      if(typeof consumeAiBudget!=='function')explanation={available:false,status:'unavailable',explanations:[],message:'Gemini explanation is unavailable.'};
      else {try {await consumeAiBudget(req);explanation=await ai.explain(analysis,{identity:req.identity,headers:req.headers,config},{...(chatAssistant?{chat:chatAssistant}:{})});}catch {explanation={available:false,status:'unavailable',explanations:[],message:'Gemini explanation is unavailable. The verified comparison remains usable.'};}}
    } else explanation=await ai.explain(analysis,{identity:req.identity,headers:req.headers,config});
    res.json({analysis,ai:explanation});
  });
}
module.exports={registerStoreRoutes};
