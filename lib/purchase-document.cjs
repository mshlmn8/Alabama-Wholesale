'use strict';
const PDFDocument=require('pdfkit');
const {AppError}=require('./domain.cjs');
const clean=value=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\u2010-\u2015]/g,'-');
const validMoney=value=>Number.isSafeInteger(value)&&value>=0&&value<=1_000_000_000_000;
const cash=value=>validMoney(value)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100):'Unconfirmed';
const date=value=>value==null||!Number.isFinite(new Date(value).getTime())?'Not confirmed':new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));

async function renderPurchaseOrder(order){
  if(!order||order.deleted||!Array.isArray(order.lines)||order.lines.length>10000)throw new AppError('INVALID_DOCUMENT','This purchase order has no valid saved lines.');
  if(!order.supplierSnapshot?.name)throw new AppError('SNAPSHOT_REQUIRED','A saved supplier snapshot is required for this purchase order.',409);
  for(const line of order.lines){
    if(!Number.isSafeInteger(line.quantity)||line.quantity<0||!['case','each'].includes(line.unit)||(line.unit==='case'&&(!Number.isSafeInteger(line.packSize)||line.packSize<1)))throw new AppError('SNAPSHOT_REQUIRED','Every PO line requires its saved quantity, unit and pack conversion.',409);
    if(line.unitCostCents!=null&&!validMoney(line.unitCostCents))throw new AppError('SNAPSHOT_REQUIRED','A purchase cost snapshot is invalid.',409);
    if(line.unitCostCents!=null&&(!validMoney(line.unitCostCents*line.quantity)||(line.lineCostCents!=null&&line.lineCostCents!==line.unitCostCents*line.quantity)))throw new AppError('DOCUMENT_TOTAL_MISMATCH','Purchase line amounts do not match their frozen quantity and cost.',409);
  }
  const total=order.lines.every(line=>validMoney(line.unitCostCents))?order.lines.reduce((sum,line)=>sum+line.quantity*line.unitCostCents,0):null;
  if(total!==null&&(!validMoney(total)||(order.totalCostCents!=null&&order.totalCostCents!==total)))throw new AppError('DOCUMENT_TOTAL_MISMATCH','Purchase totals do not match the saved lines.',409);
  return new Promise((resolve,reject)=>{
    const reference=clean(order.purchaseNumber||order.number||order.poNumber||order.purchaseOrderNumber||order.id);
    const pdf=new PDFDocument({size:'LETTER',margin:36,bufferPages:true,compress:true,info:{Title:`${reference} - Purchase Order`,Author:'Alabama Wholesale',Subject:'Supplier purchase order'}}),chunks=[];
    pdf.on('data',chunk=>chunks.push(chunk));pdf.on('end',()=>resolve(Buffer.concat(chunks)));pdf.on('error',reject);
    try{draw(pdf,order,reference,total);pdf.end();}catch(error){pdf.destroy();reject(error);}
  });
}

function draw(pdf,order,reference,total){
  const LEFT=36,WIDTH=540,BOTTOM=722,ink='#172637',muted='#536170';let y=36,inTable=false;
  const supplier=order.supplierSnapshot;
  const status=order.status==='draft'?'DRAFT - NOT PLACED':String(order.status||'Unknown').toUpperCase();
  function text(value,x,at,width=WIDTH,size=10,bold=false,align='left'){
    pdf.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor(ink).text(clean(value),x,at,{width,lineBreak:false,align});
  }
  function wrap(value,width,size=10,bold=false){
    pdf.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size);const result=[];let current='';
    for(const word of clean(value).split(/\s+/)){
      if(pdf.widthOfString(word)>width){if(current){result.push(current);current='';}for(const character of word){if(current&&pdf.widthOfString(current+character)>width){result.push(current);current='';}current+=character;}}
      else if(!current||pdf.widthOfString(current+' '+word)<=width)current+=(current?' ':'')+word;
      else{result.push(current);current=word;}
    }
    if(current)result.push(current);return result.length?result:[''];
  }
  function tableHeader(){
    pdf.rect(LEFT,y,WIDTH,25).fill('#EDEBE4');
    text('ITEM / SUPPLIER SKU',LEFT+7,y+8,244,9,true);text('QUANTITY',294,y+8,80,9,true,'right');text('UNIT COST',385,y+8,85,9,true,'right');text('AMOUNT',477,y+8,92,9,true,'right');y+=25;
  }
  function header(){
    y=36;text('ALABAMA WHOLESALE',LEFT,y,310,12,true);text('PURCHASE ORDER',345,y,231,14,true,'right');y+=25;
    for(const line of wrap(reference,WIDTH,12,true)){text(line,LEFT,y,WIDTH,12,true);y+=16;}
    for(const line of wrap(supplier.name,WIDTH,11,true)){text(line,LEFT,y,WIDTH,11,true);y+=15;}
    text(status,LEFT,y,WIDTH,10,true);y+=19;
    pdf.moveTo(LEFT,y).lineTo(LEFT+WIDTH,y).strokeColor(ink).lineWidth(1).stroke();y+=10;if(inTable)tableHeader();
  }
  function page(){pdf.addPage();header();}
  function space(height){if(y+height>BOTTOM)page();}
  function paragraph(value,bold=false){for(const line of wrap(value,WIDTH,10,bold)){space(15);text(line,LEFT,y,WIDTH,10,bold);y+=15;}y+=5;}
  header();
  paragraph(`Created: ${date(order.createdAt)} | Expected delivery: ${date(order.expectedAt??order.expectedDeliveryAt)}`);
  if(supplier.address)paragraph(supplier.address);
  if(supplier.contact||supplier.email||supplier.phone)paragraph([supplier.contact,supplier.email,supplier.phone].filter(Boolean).join(' / '));
  if(supplier.terms)paragraph('Supplier terms: '+supplier.terms);
  if(order.status==='draft')paragraph('Internal draft. Creating this document does not place an order with the supplier.',true);
  if(order.status==='cancelled')paragraph('CANCELLED - Retained for reference. Do not place or fulfill this order.',true);
  space(25);tableHeader();inTable=true;
  for(let index=0;index<order.lines.length;index++){
    const line=order.lines[index],description=[...wrap(`${index+1}. ${line.name||line.productId}${line.variant?' / '+line.variant:''}`,243,10,true),...wrap('Supplier SKU: '+(line.supplierSku||'Not recorded'),243,9)];
    if(line.unit==='case')description.push(...wrap(`${line.packSize} items per case / ${line.quantity*line.packSize} items ordered`,243,9));
    const completeHeight=Math.max(43,description.length*14+16);if(completeHeight<420)space(completeHeight);
    let offset=0,first=true;
    while(offset<description.length){
      space(43);const count=Math.max(1,Math.floor((BOTTOM-y-16)/14)),part=description.slice(offset,offset+count),height=Math.max(43,part.length*14+16);
      if(index%2===1)pdf.rect(LEFT,y,WIDTH,height).fill('#F7F6F1');
      for(let j=0;j<part.length;j++)text(part[j],LEFT+7,y+8+j*14,243,j===0&&first?10:9,j===0&&first);
      if(first){text(`${line.quantity} ${line.unit}`,294,y+8,80,10,false,'right');text(cash(line.unitCostCents),385,y+8,85,10,false,'right');text(cash(line.unitCostCents==null?null:line.unitCostCents*line.quantity),477,y+8,92,10,true,'right');}
      else text('(continued)',294,y+8,80,9,false,'right');
      y+=height;pdf.moveTo(LEFT,y).lineTo(LEFT+WIDTH,y).strokeColor('#CFD4D7').lineWidth(.5).stroke();offset+=part.length;first=false;if(offset<description.length)page();
    }
  }
  y+=16;space(52);text('Purchase total',300,y,170,12,true,'right');text(cash(total),477,y,92,12,true,'right');y+=30;
  paragraph('This document records the saved purchase quantities and costs. It does not send a supplier order or make a payment.');
  if(order.notes)paragraph('Order notes: '+order.notes);
  const range=pdf.bufferedPageRange();
  for(let index=range.start;index<range.start+range.count;index++){
    pdf.switchToPage(index);pdf.page.margins.bottom=20;pdf.font('Helvetica').fontSize(8).fillColor(muted).text(`Alabama Wholesale Operations | ${reference}`,LEFT,749,{width:390,lineBreak:false});pdf.text(`Page ${index+1} of ${range.count}`,446,749,{width:130,align:'right',lineBreak:false});
  }
}
module.exports={renderPurchaseOrder};
