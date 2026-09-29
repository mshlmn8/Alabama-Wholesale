'use strict';
const PDFDocument=require('pdfkit');
const {AppError,inventoryId}=require('./domain.cjs');
const clean=value=>String(value??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/[\u2010-\u2015]/g,'-');
const date=value=>value==null||!Number.isFinite(new Date(value).getTime())?'Unknown':new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
async function withWarehouseLocations(record,repo) {
  if(!Array.isArray(record.lines))throw new AppError('INVALID_DOCUMENT','The pick list has no valid item rows.');
  const variantsFor=line=>line.selectionMode==='mix'
    ? [...new Set((line.pickedAt&&line.allocations?.length?line.allocations.map(part=>part.variant):line.allowedVariants||[]).filter(variant=>typeof variant==='string'))]
    : [line.variant||''];
  const keys=new Set(record.lines.flatMap(line=>line.productId?variantsFor(line).map(variant=>inventoryId(line.productId,variant)):[]));
  const bins=new Map(await Promise.all([...keys].map(async key=>{
    const inventory=await repo.get('inventory',key),value=inventory?.warehouseBin??inventory?.bin;
    return [key,typeof value==='string'?value.trim():''];
  })));
  return {...record,lines:record.lines.map(line=>{
    const warehouseLocations=variantsFor(line).map(variant=>({variant,bin:bins.get(inventoryId(line.productId,variant))||''}));
    const unique=[...new Set(warehouseLocations.map(location=>location.bin))];
    const warehouseBin=unique.length>1?'Multiple locations':unique[0]||'';
    return {...line,bin:'',warehouseBin,warehouseLocations};
  })};
}
function groupsFor(lines) {
  const groups=new Map();
  for(const line of lines) {
    const category=clean(line.warehouseBin||line.bin||line.categoryNames?.at(-1)||'Uncategorized'),name=clean(line.name||line.productName||line.productId||'Unidentified item');
    const key=JSON.stringify([category,line.productId||name,name]);const group=groups.get(key)||{category,name,lines:[]};group.lines.push(line);groups.set(key,group);
  }
  return [...groups.values()].sort((a,b)=>a.category.localeCompare(b.category)||a.name.localeCompare(b.name));
}
function pickupsFor(record) {
  const seen=new Set();
  return [...(record.creditRequests||[]),...(record.returnPickups||[])].filter(request=>{
    if(request.id&&seen.has(request.id))return false;if(request.id)seen.add(request.id);
    return request.pickupRequested!==false&&request.kind!=='adjustment'&&!['rejected','cancelled'].includes(request.status)&&!(request.status==='approved'&&request.restock===true&&!request.physical);
  }).flatMap(request=>(request.lines||[]).map(line=>{
    const physical=request.physical?.lines?.find(value=>value.lineId===line.lineId&&(value.variant||'')===(line.variant||'')),quantity=line.quantity-(physical?.pickedQuantity||0);
    const pack=line.unit==='case'?line.packSize:1;
    return {...line,quantity,eachQuantity:Number.isSafeInteger(pack)&&pack>0?quantity*pack:null,returnId:request.id,originalReference:request.invoiceNumber||request.originalReference||request.orderId||'Unverified original',reason:request.reason,pickupInstructions:request.pickupInstructions,unverified:request.kind==='unverified'};
  }).filter(line=>Number.isInteger(line.quantity)&&line.quantity>0));
}
async function renderPickList(record,store) {
  if(!record||!store||record.storeId!==store.id)throw new AppError('FORBIDDEN','This pick list belongs to a different store.',403);
  if(!Array.isArray(record.lines))throw new AppError('INVALID_DOCUMENT','The pick list has no valid item rows.');
  if(record.deleted||record.status==='cancelled')throw new AppError('DOCUMENT_CANCELLED','Canceled orders cannot generate active pick tickets.',409);
  const reference=clean(record.additionReference||record.invoiceNumber||record.orderNumber||record.id),recipient=record.storeSnapshot||store;
  return new Promise((resolve,reject)=>{
    const pdf=new PDFDocument({size:'LETTER',margin:36,bufferPages:true,compress:true,info:{Title:`${clean(recipient.name)} - ${reference} - PICK LIST`,Author:'Alabama Wholesale',Subject:'Fulfillment quantities and return pickups',Creator:'Alabama Wholesale'}}),chunks=[];
    pdf.on('data',chunk=>chunks.push(chunk));pdf.on('end',()=>resolve(Buffer.concat(chunks)));pdf.on('error',reject);
    try {draw(pdf,record,recipient,reference);pdf.end();}catch(error){pdf.destroy();reject(error);}
  });
}
function draw(pdf,record,recipient,reference) {
  const LEFT=36,WIDTH=540,BOTTOM=726,ITEM_X=60,ITEM_WIDTH=277,NEED_X=343,PICKED_X=419,SHORT_X=499;
  let y=36,currentGroup=null,section='pick',pageNumber=0;
  function text(value,x,at,width=WIDTH,size=10,bold=false,align='left') {pdf.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor('#111111').text(clean(value),x,at,{width,lineBreak:false,align});}
  function wrap(value,width,size=10,bold=false) {
    pdf.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size);const output=[];
    for(const paragraph of clean(value).split('\n')) {
      let pending='';if(!paragraph){output.push('');continue;}
      for(const word of paragraph.split(/\s+/)) {
        if(pdf.widthOfString(word)>width){if(pending){output.push(pending);pending='';}for(const char of word){if(pending&&pdf.widthOfString(pending+char)>width){output.push(pending);pending='';}pending+=char;}}
        else if(!pending||pdf.widthOfString(pending+' '+word)<=width)pending+=(pending?' ':'')+word;
        else {output.push(pending);pending=word;}
      }
      if(pending)output.push(pending);
    }
    return output.length?output:[''];
  }
  function fixedParagraph(value,{width=WIDTH,size=10,bold=false,lineHeight=14,x=LEFT}={}) {
    for(const line of wrap(value,width,size,bold)){text(line,x,y,width,size,bold);y+=lineHeight;}
  }
  function tableHead() {
    pdf.rect(LEFT,y,WIDTH,25).fill('#EEEEEE');text('CHECK',LEFT+2,y+8,32,7,true);text(section==='pick'?'PRODUCT / FLAVOR':'RETURN ITEM',ITEM_X+16,y+7,260,10,true);text('NEED',NEED_X,y+7,68,10,true,'center');text('PICKED',PICKED_X,y+7,73,10,true,'center');text('SHORT',SHORT_X,y+7,71,10,true,'center');y+=25;
    pdf.moveTo(LEFT,y).lineTo(LEFT+WIDTH,y).lineWidth(1).strokeColor('#222222').stroke();
  }
  function groupHeading(continued=false) {
    if(!currentGroup)return;
    y+=8;fixedParagraph(currentGroup.category.toUpperCase(),{size:9,bold:true,lineHeight:12});fixedParagraph(currentGroup.name+(continued?' (continued)':''),{size:12,bold:true,lineHeight:16});y+=4;
  }
  function header(continued=false) {
    pageNumber++;y=34;text('ALABAMA WHOLESALE',LEFT,y,WIDTH,10,true);text('PICK LIST',401,y-3,175,18,true,'right');y+=24;
    fixedParagraph(recipient.name||'Store',{size:14,bold:true,lineHeight:18});
    fixedParagraph(`Order ${reference}${continued?' / CONTINUED':''}`,{size:11,bold:true,lineHeight:15});
    const mail=record.status==='draft'&&Boolean(record.placementId||record.provenance==='mail-confirmed');
    const status=record.legacy||['legacy','historical'].includes(record.status)?'HISTORICAL / UNVERIFIED - REVIEW BEFORE FULFILLMENT':record.status==='draft'&&!mail?'DRAFT - NOT SUBMITTED':mail?'PLACED THROUGH MAIL - receipt not implied':clean(record.status||'Unknown').toUpperCase();
    fixedParagraph(`${status} | Order date: ${date(record.placedAt??record.submittedAt??record.createdAt)}`,{size:9,lineHeight:13});
    if(record.parentOrderId||record.parentPlacementId)fixedParagraph(`ADDITION TO ${record.parentReference||record.parentOrderId||record.parentPlacementId} - NEW ITEMS ONLY${record.additionDelivery==='follow-up'?' - FOLLOW-UP DELIVERY':''}`,{size:10,bold:true,lineHeight:14});
    y+=6;pdf.moveTo(LEFT,y).lineTo(LEFT+WIDTH,y).lineWidth(1.4).strokeColor('#111111').stroke();y+=10;
    if(section==='returns'){fixedParagraph('RETURN PICKUPS - DO NOT PICK FROM STOCK',{size:12,bold:true,lineHeight:16});y+=4;}
    if(continued){tableHead();groupHeading(true);}
  }
  function page(){pdf.addPage();header(true);}
  function space(height){if(y+height>BOTTOM)page();}
  function paragraph(value,{size=10,bold=false,lineHeight=14}={}) {for(const line of wrap(value,WIDTH,size,bold)){space(lineHeight);text(line,LEFT,y,WIDTH,size,bold);y+=lineHeight;}y+=4;}
  function row(line,isReturn=false) {
    const parts=[];const add=(value,bold=false,size=10)=>{for(const content of wrap(value,ITEM_WIDTH,size,bold))parts.push({content,bold,size});};
    add(isReturn?`${line.name||line.productId}${line.variant?' / '+line.variant:''}`:line.selectionMode==='mix'?'MIX - total across allowed flavors':line.variant||'Standard',true,11);
    add(`SKU: ${line.sku||line.productId||'Not recorded'}`,false,9);
    if(line.unit==='case')add(`${line.packSize??'Unknown'} per case / ${line.eachQuantity??(Number.isInteger(line.packSize)?line.quantity*line.packSize:'Unknown')} each`,false,9);
    if(line.selectionMode==='mix') {
      add('Allowed: '+(line.allowedVariants||[]).join(', '));if(line.excludedVariants?.length)add('DO NOT INCLUDE: '+line.excludedVariants.join(', '),true);
      if(line.pickedAt&&line.allocations?.length)add('Confirmed actual: '+line.allocations.map(part=>`${part.variant||'Standard'}: ${part.quantity} ${line.unit}`).join('; '));
      else add('Actual flavors / quantities: __________________');
      if(line.warehouseLocations?.length)add((line.pickedAt&&line.allocations?.length?'Picked flavor locations: ':'Allowed flavor locations: ')+line.warehouseLocations.map(location=>`${location.variant||'Standard'}: ${location.bin||'Location not set'}`).join('; '),false,9);
    }
    if(line.note)add('Note: '+line.note);
    if(isReturn){add('Original: '+line.originalReference,false,9);if(line.unverified)add('UNVERIFIED REQUEST - confirm before pickup',true,9);if(line.reason)add('Reason: '+line.reason);if(line.pickupInstructions)add('Pickup: '+line.pickupInstructions);}
    const fullHeight=Math.max(48,parts.length*14+16);if(fullHeight<420&&y+fullHeight>BOTTOM)page();
    let offset=0,first=true;
    while(offset<parts.length) {
      if(y+48>BOTTOM)page();
      const count=Math.max(1,Math.floor((BOTTOM-y-16)/14)),chunk=parts.slice(offset,offset+count),height=Math.max(48,chunk.length*14+16);
      pdf.rect(LEFT+4,y+10,12,12).lineWidth(1).strokeColor('#111111').stroke();
      for(let i=0;i<chunk.length;i++)text(chunk[i].content,ITEM_X,y+8+i*14,ITEM_WIDTH,chunk[i].size,chunk[i].bold);
      if(first) {
        text(Number.isInteger(line.quantity)?line.quantity:'?',NEED_X,y+8,68,16,true,'center');text(line.unit==='case'?'case':'each',NEED_X,y+28,68,10,false,'center');
        for(const start of [PICKED_X,SHORT_X])pdf.moveTo(start+9,y+29).lineTo(start+63,y+29).lineWidth(0.8).strokeColor('#555555').stroke();
      } else text('continued',NEED_X,y+10,68,8,false,'center');
      y+=height;pdf.moveTo(LEFT,y).lineTo(LEFT+WIDTH,y).lineWidth(0.6).strokeColor('#999999').stroke();offset+=chunk.length;first=false;
      if(offset<parts.length)page();
    }
  }
  header();
  if(record.notes){paragraph('DELIVERY INSTRUCTIONS',{bold:true,size:9});paragraph(record.notes);}
  y+=6;tableHead();
  const grouped=groupsFor(record.lines);
  for(const group of grouped){currentGroup=null;space(100);currentGroup=group;groupHeading();for(const line of group.lines)row(line);}
  const totals=new Map();for(const line of record.lines)if(Number.isInteger(line.quantity))totals.set(line.unit==='case'?'case':'each',(totals.get(line.unit==='case'?'case':'each')||0)+line.quantity);
  y+=12;space(48);paragraph(`Total pick rows: ${record.lines.length}`,{bold:true});paragraph('Totals by unit: '+[...totals].map(([unit,total])=>`${total} ${unit}`).join(' / '));
  const pickups=pickupsFor(record);
  if(pickups.length){currentGroup=null;section='returns';if(y+140>BOTTOM)page();else{y+=18;paragraph('RETURN PICKUPS - DO NOT PICK FROM STOCK',{size:12,bold:true});tableHead();}for(const line of pickups)row(line,true);}
  currentGroup=null;y+=8;space(64);paragraph('Shortage / substitution notes: __________________________________________',{lineHeight:12});paragraph('____________________________________________________________________',{lineHeight:12});paragraph('Picker / date: ____________________    Checker / initials: ____________________',{lineHeight:12});paragraph('Paper marks do not change order status or inventory. Confirm actual quantities in the app.',{size:9,lineHeight:12});
  const range=pdf.bufferedPageRange();
  for(let i=range.start;i<range.start+range.count;i++){pdf.switchToPage(i);pdf.page.margins.bottom=12;pdf.moveTo(LEFT,745).lineTo(LEFT+WIDTH,745).lineWidth(0.6).strokeColor('#777777').stroke();text(`Order ${reference}`,LEFT,754,390,8);text(`Page ${i+1} of ${range.count}`,431,754,145,8,false,'right');}
}
module.exports={renderPickList,groupsFor,pickupsFor,withWarehouseLocations};
