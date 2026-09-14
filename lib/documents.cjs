'use strict';
const PDFDocument=require('pdfkit');
const {AppError,MONEY_LIMIT}=require('./domain.cjs');
const KINDS=new Set(['invoice','pick-list','delivery-note','historical-copy','credit-memo']);
const FINAL_STATUSES=new Set(['submitted','approved','picking','delivered','cancelled']);
const TITLES={'invoice':'INVOICE','pick-list':'PICK LIST','delivery-note':'DELIVERY NOTE','historical-copy':'HISTORICAL COPY','credit-memo':'CREDIT MEMO'};
const COLORS={ink:'#17142E',muted:'#5B6072',navy:'#29205E',orange:'#F27722',border:'#DEE1E8',pale:'#F5F4FA',white:'#FFFFFF'};
const clean=value=>String(value??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/[\u2010-\u2015\u2500\u2501\u254C\u254D\u2550]/g,'-');
const amount=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=MONEY_LIMIT;
const currency=value=>amount(value)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value/100):'Unknown';
function displayDate(value) {
  if(value===undefined||value===null||value==='')return 'Unknown';
  const dateOnly=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if(dateOnly)return `${dateOnly[2]}/${dateOnly[3]}/${dateOnly[1]}`;
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return 'Unknown';
  return new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
function issue(code,message,status=400){throw new AppError(code,message,status);}
function prepare(record,store,kind) {
  if(!KINDS.has(kind))issue('INVALID_DOCUMENT','Unsupported document type.');
  if(!record||!store||record.storeId!==store.id)issue('FORBIDDEN','This document does not belong to the selected store.',403);
  const historic=kind==='historical-copy',credit=kind==='credit-memo',financial=kind==='invoice'||credit;
  if(!Array.isArray(record.lines)||record.lines.length>1000)issue('INVALID_DOCUMENT','The document does not have valid line items.');
  if(kind==='invoice'&&(record.legacy?.needsPriceReview||record.status==='legacy'))issue('SNAPSHOT_REQUIRED','Historical orders do not have verified original price snapshots. Use a historical copy.');
  if((kind==='invoice'||kind==='delivery-note')&&!FINAL_STATUSES.has(record.status))issue('DOCUMENT_NOT_FINAL','Submit the order before producing this document.');
  if(credit&&record.status!=='approved')issue('DOCUMENT_NOT_FINAL','A credit memo requires an approved return.');
  const lines=record.lines.map((line,index)=>{
    const quantity=line.quantity;
    const subtotalCents=credit?line.subtotalCents:line.lineTotalCents;
    if(financial) {
      if(!line.name||!Number.isInteger(quantity)||quantity<1||!['each','case'].includes(line.unit)||!amount(line.unitPriceCents)||!amount(subtotalCents)||!amount(line.taxCents))issue('SNAPSHOT_REQUIRED','Every invoice line requires a frozen product, quantity, price and tax.');
      if(line.unit==='case'&&(!Number.isInteger(line.packSize)||line.packSize<1))issue('SNAPSHOT_REQUIRED','The original case size is missing.');
      if(line.unitPriceCents*quantity!==subtotalCents)issue('DOCUMENT_TOTAL_MISMATCH','The recorded line totals do not match the frozen quantities and prices.');
    }
    return {index:index+1,name:clean(line.name||line.productName||line.productId||'Unidentified item'),sku:clean(line.sku||line.productId||''),variant:clean(line.variant),note:clean(line.note),quantity,unit:line.unit==='case'?'case':'each',packSize:line.packSize??null,eachQuantity:line.eachQuantity??(Number.isInteger(quantity)?quantity*(line.unit==='case'&&Number.isInteger(line.packSize)?line.packSize:1):null),unitPriceCents:line.unitPriceCents,subtotalCents,taxCents:line.taxCents};
  });
  if(financial) {
    if(!lines.length||![record.subtotalCents,record.taxCents,record.totalCents].every(amount))issue('SNAPSHOT_REQUIRED','The recorded invoice totals are incomplete.');
    const subtotal=lines.reduce((sum,line)=>sum+line.subtotalCents,0),tax=lines.reduce((sum,line)=>sum+line.taxCents,0);
    if(subtotal!==record.subtotalCents||tax!==record.taxCents||subtotal+tax!==record.totalCents)issue('DOCUMENT_TOTAL_MISMATCH','The recorded document totals do not match its frozen line items.');
    if(!(credit?record.creditMemoNumber:record.invoiceNumber))issue('SNAPSHOT_REQUIRED','The issued document number is missing.');
  }
  const recipient=record.storeSnapshot||(!historic?store:{name:record.storeName||store.name,address:''});
  return {record,store,kind,historic,credit,financial,lines,recipient,title:TITLES[kind],number:clean(credit?record.creditMemoNumber:record.invoiceNumber||record.id),date:displayDate(historic?record.legacy?.date??record.createdAt:credit?record.approvedAt??record.createdAt:record.submittedAt??record.createdAt),status:clean(record.status||'Unknown').toUpperCase()};
}

async function renderDocument(record,store,kind) {
  const model=prepare(record,store,kind);
  return new Promise((resolve,reject)=>{
    const pdf=new PDFDocument({size:'LETTER',margin:42,bufferPages:true,compress:true,info:{Title:`${model.title} ${model.number}`,Author:'Alabama Wholesale',Subject:'Wholesale order document',Creator:'Alabama Wholesale'}});
    const chunks=[];pdf.on('data',chunk=>chunks.push(chunk));pdf.on('end',()=>resolve(Buffer.concat(chunks)));pdf.on('error',reject);
    try {render(pdf,model);pdf.end();}catch(error){pdf.destroy();reject(error);}
  });
}
function render(pdf,model) {
  const LEFT=42,WIDTH=528,BOTTOM=712;
  let y=112;
  function label(value,x,yValue,width,fontSize=10,{bold=false,color=COLORS.ink,align='left'}={}) {
    const content=clean(value);pdf.font(bold?'Helvetica-Bold':'Helvetica').fontSize(fontSize);
    const measured=pdf.widthOfString(content);if(measured>width)pdf.fontSize(Math.max(6,fontSize*width/measured));
    pdf.fillColor(color).text(content,x,yValue,{width,align,lineBreak:false});
  }
  function wrap(value,width,fontSize=10,bold=false) {
    pdf.font(bold?'Helvetica-Bold':'Helvetica').fontSize(fontSize);
    const output=[];
    for(const paragraph of clean(value).split('\n')) {
      if(!paragraph){output.push('');continue;}
      let current='';
      for(const word of paragraph.split(/\s+/)) {
        if(pdf.widthOfString(word)>width) {
          if(current){output.push(current);current='';}
          let fragment='';
          for(const character of word) {
            if(fragment&&pdf.widthOfString(fragment+character)>width){output.push(fragment);fragment='';}
            fragment+=character;
          }
          current=fragment;
        } else if(!current||pdf.widthOfString(current+' '+word)<=width)current+=(current?' ':'')+word;
        else {output.push(current);current=word;}
      }
      if(current)output.push(current);
    }
    return output.length?output:[''];
  }
  function header(continued=false) {
    pdf.rect(LEFT,36,39,39).fill(COLORS.navy);label('AW',LEFT+4,48,31,15,{bold:true,color:COLORS.white,align:'center'});
    label('Alabama Wholesale',92,39,240,18,{bold:true,color:COLORS.navy});label('Ordering and fulfillment',93,64,230,9,{color:COLORS.muted});
    label(model.title,338,39,232,model.title.length>15?15:18,{bold:true,color:COLORS.navy,align:'right'});
    label(model.number,310,65,260,10,{align:'right'});
    pdf.moveTo(LEFT,91).lineTo(LEFT+WIDTH,91).lineWidth(2).strokeColor(COLORS.orange).stroke();
    if(continued){label(`${clean(model.recipient.name||'Store')} / Continued`,LEFT,104,WIDTH,10,{color:COLORS.muted});y=128;}else y=112;
  }
  function page(){pdf.addPage();header(true);}
  function space(height){if(y+height>BOTTOM)page();}
  function paragraph(value,{fontSize=10,bold=false,color=COLORS.ink,width=WIDTH,lineHeight=14}={}) {
    for(const line of wrap(value,width,fontSize,bold)){space(lineHeight);label(line,LEFT,y,width,fontSize,{bold,color});y+=lineHeight;}
    y+=5;
  }
  function tableHeader() {
    space(30);pdf.rect(LEFT,y,WIDTH,25).fill(COLORS.navy);
    label(model.kind==='pick-list'?'PICK / ITEM':'ITEM',LEFT+8,y+8,model.financial?260:335,9,{bold:true,color:COLORS.white});
    label('QUANTITY',model.financial?322:410,y+8,75,9,{bold:true,color:COLORS.white,align:'right'});
    if(model.financial){label('UNIT PRICE',401,y+8,76,9,{bold:true,color:COLORS.white,align:'right'});label('AMOUNT',483,y+8,79,9,{bold:true,color:COLORS.white,align:'right'});}
    else label(model.kind==='pick-list'?'CHECK':'RECEIVED',497,y+8,64,9,{bold:true,color:COLORS.white,align:'right'});
    y+=25;
  }
  function row(line) {
    const descriptionWidth=model.financial?262:348;
    const parts=[...wrap(`${line.index}. ${line.name}${line.variant?' / '+line.variant:''}`,descriptionWidth,10,true).map(text=>({text,bold:true})),...wrap(`SKU: ${line.sku||'Not recorded'}`,descriptionWidth,9).map(text=>({text,color:COLORS.muted}))];
    if(line.unit==='case')parts.push(...wrap(`${line.packSize??'Unknown'} per case / ${line.eachQuantity??'Unknown'} each`,descriptionWidth,9).map(text=>({text,color:COLORS.muted})));
    if(line.note)parts.push(...wrap(`Note: ${line.note}`,descriptionWidth,9).map(text=>({text,color:COLORS.muted})));
    const wholeHeight=Math.max(40,parts.length*13+16);
    if(wholeHeight<=BOTTOM-153&&y+wholeHeight>BOTTOM){page();tableHeader();}
    let offset=0,first=true;
    while(offset<parts.length) {
      if(y+40>BOTTOM){page();tableHeader();}
      const fit=Math.max(1,Math.floor((BOTTOM-y-16)/13));const part=parts.slice(offset,offset+fit);const height=Math.max(40,part.length*13+16);
      if(line.index%2===0)pdf.rect(LEFT,y,WIDTH,height).fill(COLORS.pale);
      for(let i=0;i<part.length;i++)label(part[i].text,LEFT+8,y+8+i*13,descriptionWidth,part[i].bold?10:9,{bold:part[i].bold,color:part[i].color||COLORS.ink});
      if(first) {
        label(`${Number.isInteger(line.quantity)?line.quantity:'?'} ${line.unit}`,model.financial?322:410,y+8,75,10,{align:'right'});
        if(model.financial){label(currency(line.unitPriceCents),401,y+8,76,10,{align:'right'});label(currency(line.subtotalCents),483,y+8,79,10,{align:'right',bold:true});}
        else pdf.rect(542,y+9,12,12).lineWidth(0.8).strokeColor(COLORS.muted).stroke();
      } else label('(continued)',model.financial?322:410,y+8,75,8,{align:'right',color:COLORS.muted});
      y+=height;pdf.moveTo(LEFT,y).lineTo(LEFT+WIDTH,y).lineWidth(0.5).strokeColor(COLORS.border).stroke();offset+=part.length;first=false;
      if(offset<parts.length){page();tableHeader();}
    }
  }
  header();
  label(model.credit?'CREDIT TO':model.kind==='delivery-note'?'DELIVER TO':'CUSTOMER',LEFT,y,WIDTH,9,{bold:true,color:COLORS.muted});y+=18;
  paragraph(clean(model.recipient.name||'Store name not recorded'),{fontSize:14,bold:true,lineHeight:18});
  if(model.recipient.address)paragraph(model.recipient.address,{color:COLORS.muted});
  if(model.recipient.contact||model.recipient.phone)paragraph([model.recipient.contact,model.recipient.phone].filter(Boolean).join(' / '),{color:COLORS.muted});
  paragraph(`${model.historic?'Date recorded':model.credit?'Credit date':'Order date'}: ${model.date}    |    Status: ${model.status}`,{fontSize:9,color:COLORS.muted});
  if(model.recipient.terms&&model.financial)paragraph(`Terms: ${model.recipient.terms}`,{fontSize:9,color:COLORS.muted});
  if(model.credit)paragraph(`Original invoice: ${model.record.invoiceNumber||'Not recorded'}`,{fontSize:9,color:COLORS.muted});
  if(model.status==='CANCELLED')paragraph('CANCELLED - This invoice has been reversed. It is retained for the account record.',{bold:true,color:'#A33B0B'});
  if(model.status==='DRAFT')paragraph('DRAFT - Not submitted. Quantities remain subject to review.',{bold:true,color:'#A33B0B'});
  if(model.historic) {
    paragraph('Historical copy - Original prices cannot be reconstructed. Saved totals and text are reproduced below; this is not a newly finalized invoice.',{bold:true,color:'#A33B0B'});
    paragraph(`Recorded total ${currency(model.record.totalCents)}`,{fontSize:16,bold:true,lineHeight:22});
    if(amount(model.record.subtotalCents))paragraph(`Recorded subtotal ${currency(model.record.subtotalCents)}`,{color:COLORS.muted});
    if(amount(model.record.taxCents))paragraph(`Recorded tax ${currency(model.record.taxCents)}`,{color:COLORS.muted});
    const original=model.record.billText||model.record.orderText;
    if(original){y+=8;paragraph('SAVED ORIGINAL TEXT',{bold:true,fontSize:9,color:COLORS.muted});paragraph(original,{fontSize:10});}
  }
  if(model.lines.length){y+=8;tableHeader();for(const line of model.lines)row(line);}
  if(model.financial) {
    y+=18;space(108);
    const totalLine=(name,value,bold=false)=>{label(name,335,y,130,bold?13:10,{bold,align:'right'});label(currency(value),473,y,89,bold?14:11,{bold,align:'right',color:bold?COLORS.navy:COLORS.ink});y+=bold?28:22;};
    totalLine('Subtotal',model.record.subtotalCents);totalLine('Tax',model.record.taxCents);
    pdf.moveTo(336,y-2).lineTo(562,y-2).lineWidth(1).strokeColor(COLORS.border).stroke();y+=9;
    totalLine(model.credit?'Total credited':'Invoice total',model.record.totalCents,true);
    if(!model.credit)paragraph('Invoice total is the original charge. Payments and credits are shown separately on the account ledger.',{fontSize:8,color:COLORS.muted,lineHeight:11});
  }
  const note=model.credit?model.record.reason:model.record.notes;
  if(note){y+=10;paragraph(model.credit?'RETURN REASON':'ORDER NOTES',{bold:true,fontSize:9,color:COLORS.muted});paragraph(note);}
  if(model.kind==='delivery-note') {
    y+=24;space(96);
    for(const name of ['Received by','Signature','Date / time']){label(name,LEFT,y,110,10,{color:COLORS.muted});pdf.moveTo(150,y+13).lineTo(LEFT+WIDTH,y+13).lineWidth(0.7).strokeColor(COLORS.border).stroke();y+=28;}
  }
  if(model.kind==='pick-list'){y+=18;paragraph('Confirm each product, variant and quantity before changing this order to delivered.',{fontSize:9,color:COLORS.muted});}
  const range=pdf.bufferedPageRange();
  for(let i=range.start;i<range.start+range.count;i++) {
    pdf.switchToPage(i);pdf.page.margins.bottom=20;pdf.moveTo(LEFT,742).lineTo(LEFT+WIDTH,742).lineWidth(0.5).strokeColor(COLORS.border).stroke();
    label('Alabama Wholesale / '+model.title.toLowerCase(),LEFT,752,330,8,{color:COLORS.muted});label(`Page ${i+1} of ${range.count}`,420,752,150,8,{color:COLORS.muted,align:'right'});
  }
}
module.exports={renderDocument};
