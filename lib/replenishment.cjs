'use strict';
const {createHash}=require('node:crypto');
const DAY=86400000,MINIMUM_AGE=4*DAY,COUNT_FRESHNESS=7*DAY;
const usableNumber=value=>Number.isSafeInteger(value)&&value>=0&&value<=1_000_000_000;
const keyFor=(productId,variant='')=>JSON.stringify([productId,variant]);
function eachQuantity(line,{draft=false,products}={}) {
  if(line.legacy?.unitInferred||line.unitsAmbiguous)return null;
  if(!draft&&usableNumber(line.eachQuantity))return line.eachQuantity;
  if(!usableNumber(line.quantity)||line.quantity===0)return null;
  if((line.unit??'each')==='each')return line.quantity;
  const pack=draft?products?.get(line.productId)?.packSize:line.packSize;
  if(line.unit!=='case'||!usableNumber(pack)||pack===0)return null;
  const each=line.quantity*pack;return usableNumber(each)?each:null;
}
function aggregate(lines,options={}) {
  const result=new Map();
  for(const line of Array.isArray(lines)?lines:[]) {
    if(!line||typeof line.productId!=='string')continue;
    const mix=line.selectionMode==='mix',variant=mix?'*':line.variant||'',key=keyFor(line.productId,variant),quantity=eachQuantity(line,options);
    const entry=result.get(key)||{productId:line.productId,variant:mix?'':variant,selectionMode:mix?'mix':'manual',each:0,unit:line.unit||'each',allowedVariants:mix?[...(line.allowedVariants||[])]:[],excludedVariants:mix?[...(line.excludedVariants||[])]:[]};
    entry.each=entry.each===null||quantity===null?null:entry.each+quantity;
    if(!usableNumber(entry.each))entry.each=null;
    if(entry.unit!==line.unit)entry.unit='each';result.set(key,entry);
  }
  return result;
}
function qualifyingHistory({storeId,orders,placements,now}) {
  const byOrder=new Map(orders.filter(row=>row.storeId===storeId).map(row=>[row.id,row])),found=new Map();
  for(const placement of placements) {
    const order=byOrder.get(placement.orderId);
    if(placement.storeId!==storeId||placement.deleted||placement.status==='cancelled'||order?.deleted||order?.status==='cancelled'||!Number.isSafeInteger(placement.placedAt)||placement.placedAt>now||!Array.isArray(placement.lines)||!['mail-confirmed','submitted','historical-unverified'].includes(placement.provenance))continue;
    found.set(placement.orderId||placement.id,{...placement,familyId:placement.rootOrderId||order?.rootOrderId||placement.rootPlacementId||placement.parentPlacementId||placement.parentOrderId||placement.id,confirmed:placement.provenance!=='historical-unverified'});
  }
  for(const order of byOrder.values()) {
    if(found.has(order.id)||order.deleted||!['submitted','approved','picking','delivered','historical','legacy'].includes(order.status)||!Array.isArray(order.lines))continue;
    const historical=Boolean(order.legacy)||['historical','legacy'].includes(order.status),placedAt=order.submittedAt??(historical?(order.legacy?.orderedAt??order.orderedAt??order.createdAt):undefined);
    if(!Number.isSafeInteger(placedAt)||placedAt>now)continue;
    found.set(order.id,{id:'order:'+order.id,orderId:order.id,storeId,orderNumber:order.orderNumber??null,placedAt,receivedAt:order.status==='delivered'?order.deliveredAt??null:null,lines:order.lines,provenance:historical?'historical-unverified':'submitted',familyId:order.rootOrderId||order.parentOrderId||order.id,confirmed:!historical});
  }
  const rows=[...found.values()].sort((a,b)=>a.placedAt-b.placedAt||a.id.localeCompare(b.id));
  const aliases=new Map();for(const row of rows){aliases.set(row.id,row);aliases.set(row.orderId,row);}
  for(const row of rows) {
    let root=row,seen=new Set();
    while(root.familyId&&root.familyId!==root.id&&root.familyId!==root.orderId&&aliases.has(root.familyId)&&!seen.has(root.familyId)){seen.add(root.familyId);root=aliases.get(root.familyId);}
    row.familyId=root.familyId===root.id||root.familyId===root.orderId?root.familyId:root.orderId||root.id;
  }
  return rows;
}
function validCounts(counts,storeId) {
  const rows=counts.filter(row=>row.storeId===storeId&&!row.deleted),byId=new Map(rows.map(row=>[row.id,row])),replaced=new Set(),invalidKeys=new Set();
  for(const row of rows)if(row.correctionOf) {
    const original=byId.get(row.correctionOf);
    if(!original||original.productId!==row.productId||original.variant!==row.variant||original.measuredAt!==row.measuredAt)invalidKeys.add(keyFor(row.productId,row.variant));
    else replaced.add(original.id);
  }
  return {rows:rows.filter(row=>!replaced.has(row.id)),invalidKeys};
}
function movementAmount(movement) {
  const amount=movement.quantityEach;
  if(!Number.isSafeInteger(amount)||Math.abs(amount)>1_000_000_000)return null;
  if(['receipt','transfer-in'].includes(movement.kind)&&amount>0)return amount;
  if(['return-out','damage','transfer-out'].includes(movement.kind)&&amount<0)return amount;
  if(movement.kind==='correction'&&typeof movement.reason==='string'&&movement.reason.trim())return amount;
  return null;
}
function depletionMetric(rows,movements,{invalid=false,now}) {
  const observations=rows.filter(row=>Number.isSafeInteger(row.measuredAt)&&row.measuredAt<=now).sort((a,b)=>a.measuredAt-b.measuredAt||a.id.localeCompare(b.id));
  const intervals=[];let totalDays=0,totalDepletion=0,validIntervals=0;
  for(let i=1;i<observations.length;i++) {
    const opening=observations[i-1],closing=observations[i],days=(closing.measuredAt-opening.measuredAt)/DAY;
    const changes=movements.filter(row=>row.effectiveAt>opening.measuredAt&&row.effectiveAt<=closing.measuredAt),amounts=changes.map(movementAmount);
    const warnings=[];if(invalid||opening.unresolved||closing.unresolved)warnings.push('UNRESOLVED_COUNT_CORRECTION');
    if(days<=0)warnings.push('OVERLAPPING_COUNTS');
    if(!usableNumber(opening.countEach)||!usableNumber(closing.countEach)||opening.unitsAmbiguous||closing.unitsAmbiguous)warnings.push('UNKNOWN_COUNT_UNITS');
    if(amounts.some(amount=>amount===null))warnings.push('UNCLASSIFIED_MOVEMENT');
    const depletionEach=usableNumber(opening.countEach)&&usableNumber(closing.countEach)&&!amounts.includes(null)?opening.countEach+amounts.reduce((a,b)=>a+b,0)-closing.countEach:null;
    if(depletionEach!==null&&depletionEach<0)warnings.push('NEGATIVE_DEPLETION');
    const valid=warnings.length===0;intervals.push({openingCountId:opening.id,closingCountId:closing.id,from:opening.measuredAt,to:closing.measuredAt,days,depletionEach,valid,warnings,movementIds:changes.map(row=>row.id)});
    if(valid){validIntervals++;totalDays+=days;totalDepletion+=depletionEach;}
  }
  const eligible=validIntervals>=3&&totalDays>=28;
  return {eligible,weeklyEach:eligible?totalDepletion/totalDays*7:null,validIntervals,observedDays:totalDays,intervals,warnings:['ESTIMATED_DEPLETION_NOT_POS_SALES','MISSING_EXTERNAL_RECEIPTS_OR_UNRECORDED_LOSSES_CAN_DISTORT_ESTIMATE',...(!eligible?['INSUFFICIENT_COUNT_HISTORY']:[])]};
}
function purchaseMetric(rows,key) {
  const relevant=rows.filter(row=>row.confirmed&&row.aggregate.has(key)),families=new Map();
  for(const row of relevant) {const time=families.get(row.familyId);if(time===undefined||row.familyStart<time)families.set(row.familyId,row.familyStart);}
  const boundaries=[...families.values()].sort((a,b)=>a-b),from=boundaries[0]??null,to=boundaries.at(-1)??null,observedDays=from!==null?(to-from)/DAY:0;
  const included=relevant.filter(row=>row.placedAt>from&&row.placedAt<=to),quantities=included.map(row=>row.aggregate.get(key).each);
  const eligible=families.size>=4&&observedDays>=28&&quantities.every(usableNumber),total=quantities.every(usableNumber)?quantities.reduce((a,b)=>a+b,0):null;
  return {eligible,weeklyEach:eligible?total/observedDays*7:null,cycles:families.size,observedDays,from,to,lastOrderAt:relevant.at(-1)?.placedAt??null,quantityEach:total,warnings:eligible?[]:['INSUFFICIENT_PURCHASE_HISTORY']};
}
function analyze({storeId,products=[],orders=[],placements=[],counts=[],movements=[],draft={lines:[]},now=Date.now(),history={complete:true,truncatedCollections:[]}}) {
  const byProduct=new Map(products.map(product=>[product.id,product])),rows=qualifyingHistory({storeId,orders,placements,now}),families=new Map();
  for(const row of rows){row.aggregate=aggregate(row.lines);const family=families.get(row.familyId)||[];family.push(row);families.set(row.familyId,family);}
  for(const family of families.values())for(const row of family)row.familyStart=family[0].placedAt;
  const roots=[...families.values()].map(family=>family[0]),reference=roots.filter(row=>now-row.placedAt>MINIMUM_AGE).sort((a,b)=>b.placedAt-a.placedAt||a.id.localeCompare(b.id))[0]||null;
  const {rows:observations,invalidKeys}=validCounts(counts,storeId),physical=movements.filter(row=>row.storeId===storeId&&row.effectiveAt<=now&&!row.deleted),keys=new Set(rows.flatMap(row=>[...row.aggregate.keys()]));
  for(const row of observations)keys.add(keyFor(row.productId,row.variant));
  const metrics=[...keys].map(key=>{
    const [productId,variant]=JSON.parse(key),same=row=>row.productId===productId&&(row.variant||'')===variant;
    return {productId,variant:variant==='*'?'':variant,selectionMode:variant==='*'?'mix':'manual',purchases:purchaseMetric(rows,key),depletion:depletionMetric(observations.filter(same),physical.filter(same),{invalid:invalidKeys.has(key),now})};
  });
  if(!history.complete)for(const metric of metrics)for(const kind of ['purchases','depletion']){metric[kind].eligible=false;metric[kind].weeklyEach=null;metric[kind].warnings.push('INCOMPLETE_HISTORY');}
  const metricMap=new Map(metrics.map(row=>[keyFor(row.productId,row.selectionMode==='mix'?'*':row.variant),row])),current=aggregate(draft.lines,{draft:true,products:byProduct}),candidates=[];
  if(reference) {
    const family=families.get(reference.familyId),prior=aggregate(family.flatMap(row=>row.lines));
    for(const [key,item] of prior) {
      const product=byProduct.get(item.productId),present=current.get(key),currentEach=present?.each??0;
      const sameProduct=[...current.values()].filter(row=>row.productId===item.productId),mix=sameProduct.find(row=>row.selectionMode==='mix'),allowedInMix=Boolean(mix?.allowedVariants.includes(item.variant));
      const unavailable=!product||product.active===false||product.deleted||(item.selectionMode!=='mix'&&item.variant&&!product.variants?.includes(item.variant));
      if(!unavailable&&present&&item.each!==null&&present.each!==null&&present.each>=item.each)continue;
      if(!unavailable&&item.selectionMode==='mix'&&sameProduct.some(row=>row.each>0))continue;
      const later=rows.filter(row=>row.familyId!==reference.familyId&&row.placedAt>reference.placedAt&&[...row.aggregate.values()].some(value=>value.productId===item.productId));
      const recentOrderAt=later.at(-1)?.placedAt??null;
      const matchingCounts=observations.filter(row=>row.productId===item.productId&&(row.variant||'')===item.variant&&row.measuredAt<=now).sort((a,b)=>b.measuredAt-a.measuredAt||b.recordedAt-a.recordedAt),last=matchingCounts[0];
      const latestCount=last?{countEach:last.countEach,measuredAt:last.measuredAt,stale:now-last.measuredAt>COUNT_FRESHNESS}:null;
      const matchingMoves=physical.filter(row=>row.productId===item.productId&&(row.variant||'')===item.variant),laterReceiptsEach=matchingMoves.filter(row=>row.kind==='receipt'&&row.effectiveAt>(last?.measuredAt??reference.placedAt)).reduce((sum,row)=>sum+(movementAmount(row)??0),0);
      const warnings=[];if(!latestCount)warnings.push('NOT_COUNTED');else if(latestCount.stale)warnings.push('STALE_COUNT');if(item.each===null)warnings.push('UNKNOWN_PRIOR_UNITS');if(allowedInMix)warnings.push('ALLOWED_IN_MIX_NOT_GUARANTEED');if(item.selectionMode==='mix')warnings.push('MIX_FLAVORS_NOT_CONFIRMED');if(!history.complete)warnings.push('INCOMPLETE_HISTORY');
      const metric=metricMap.get(key),rate=metric?.depletion;let suggestion=null;
      if(!unavailable&&history.complete&&latestCount&&!latestCount.stale&&usableNumber(last.countEach)&&rate?.eligible&&item.selectionMode!=='mix') {
        const after=matchingMoves.filter(row=>row.effectiveAt>last.measuredAt),amounts=after.map(movementAmount);
        if(!amounts.includes(null)) {
          const pending=rows.filter(row=>row.confirmed&&!row.receivedAt&&row.aggregate.has(key)).map(row=>row.aggregate.get(key).each);
          if(pending.every(usableNumber)) {
            const availableEach=Math.max(0,last.countEach+amounts.reduce((a,b)=>a+b,0)-rate.weeklyEach*(now-last.measuredAt)/DAY/7),pendingEach=pending.reduce((a,b)=>a+b,0),targetEach=usableNumber(last.targetEach)?last.targetEach:Math.ceil(rate.weeklyEach),gap=Math.max(0,targetEach-availableEach-pendingEach);
            const unit=item.unit==='case'?'case':'each',multiple=unit==='case'?product.packSize:1;
            if(usableNumber(multiple)&&multiple>0)suggestion={quantity:Math.ceil(gap/multiple),unit,planningDays:7,targetEach,availableEach,pendingEach,orderMultipleEach:multiple,arithmetic:'max(0, target - estimated available - confirmed pending receipts), rounded up to the order unit'};
          }
        }
      }
      const status=unavailable?'unavailable':recentOrderAt?'ordered-recently':sameProduct.length&&!present?'check-flavors':present?'quantity-review':'missing';
      candidates.push({id:createHash('sha256').update(key).digest('hex').slice(0,24),productId:item.productId,variant:item.variant,selectionMode:item.selectionMode,name:product?.name||item.productId,status,priorEach:item.each,currentEach:present?.each===null?null:currentEach,latestCount,recentOrderAt,laterReceiptsEach,allowedInMix,allowedVariants:item.allowedVariants,excludedVariants:item.excludedVariants,suggestedEach:suggestion?suggestion.quantity*suggestion.orderMultipleEach:null,suggestion,warnings});
    }
  }
  return {storeId,analyzedAt:now,reference:reference?{id:reference.id,placedAt:reference.placedAt,orderId:reference.orderId,orderNumber:reference.orderNumber??null,provenance:reference.provenance}:null,candidates,metrics,history,evidence:{planningDays:7,referenceMinimumAgeHours:96,countFreshnessDays:7,placementCount:rows.length,cycleCount:families.size,limitations:['Purchases are not retail sales.','Count-based depletion is an estimate without retail POS transactions.'],message:reference?null:'No prior order older than four days.'}};
}
module.exports={analyze,eachQuantity,aggregate,qualifyingHistory,MINIMUM_AGE,COUNT_FRESHNESS};
