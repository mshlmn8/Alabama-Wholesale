'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const file=path.join(__dirname,'../public/order-credits.js');
const modulePromise=fs.existsSync(file)?import('data:text/javascript;base64,'+fs.readFileSync(file).toString('base64')):Promise.resolve({});

test('credit amount entry converts decimal dollars exactly and rejects ambiguous values',async()=>{
  const {creditCents}=await modulePromise; assert.equal(typeof creditCents,'function');
  assert.equal(creditCents('0.29'),29); assert.equal(creditCents('12.3'),1230); assert.equal(creditCents('10000000000.00'),1_000_000_000_000);
  for(const value of ['',' ','-1','0.001','1e2','1,000.00','$2','10000000000.01'])assert.throws(()=>creditCents(value),/amount|decimal/i);
});
test('credit summary keeps pending and issued amounts separate and excludes other stores and resolved claims',async()=>{
  const {creditSummary}=await modulePromise; assert.equal(typeof creditSummary,'function');
  const records=[{storeId:'s1',status:'pending',kind:'adjustment',totalCents:108},{storeId:'s1',status:'approved',totalCents:240},{storeId:'s1',status:'pending',kind:'unverified',totalCents:0,requestedSubtotalCents:50,requestedTaxCents:4},{storeId:'s1',status:'rejected',totalCents:1000},{storeId:'s2',status:'approved',totalCents:9999}];
  assert.deepEqual(creditSummary(records,'s1'),{requestedCents:162,approvedCents:240,unverifiedCount:1});
});
test('physical controls show selected-unit remaining counts and hide legacy restocked quantities',async()=>{
  const {physicalReturnLines}=await modulePromise; assert.equal(typeof physicalReturnLines,'function');
  const r={status:'approved',lines:[{lineId:'line',variant:'Orange',quantity:4,unit:'case',packSize:12}],physical:{lines:[{lineId:'line',variant:'Orange',pickedQuantity:3,receivedQuantity:1,resalableQuantity:1,nonresalableQuantity:0}]}};
  const [line]=physicalReturnLines(r); assert.equal(line.remainingPickup,1); assert.equal(line.remainingReceipt,2); assert.equal(line.unit,'case');
  const [old]=physicalReturnLines({...r,physical:undefined,restock:true}); assert.equal(old.remainingPickup,0); assert.equal(old.remainingReceipt,0);
  assert.deepEqual(physicalReturnLines({...r,kind:'adjustment'}),[]);
});
function harness(actor={uid:'buyer',role:'customer'}){
  const dialogs=[],sent=[],errors=[];let activeStore={id:'s1',name:'Shop'},draft={id:'draft',storeId:'s1',creditRequestIds:[]},generation=1,records=[];
  function node(tag,attrs={},...children){return {tag,...attrs,attrs,children:children.flat().filter(child=>child!=null),events:{},isConnected:true,append(...items){this.children.push(...items.flat().filter(item=>item!=null));},replaceChildren(...items){this.children=items.flat().filter(item=>item!=null);},addEventListener(type,fn){this.events[type]=fn;},setAttribute(name,value){this.attrs[name]=value;},focus(){},textContent:''};}
  const ctx={el:node,input:(type,value='',attrs={})=>node('input',{type,value:String(value),...attrs}),select:(options,value,attrs={})=>node('select',{value,...attrs},options.map(([value,label])=>node('option',{value},label))),button:(label,action,kind='')=>node('button',{action,class:kind},label),field:(label,control,help)=>node('label',{},label,control,help),notice:text=>node('notice',{},text),table:(headers,rows)=>node('table',{},...rows),td:(...children)=>node('td',{},...children),cash:cents=>'$'+(cents/100).toFixed(2),date:()=> 'Today',toast:message=>errors.push(message),modal:(title)=>{const result={title,content:node('content'),footer:node('footer'),dialog:{open:true},close(){this.dialog.open=false;}};dialogs.push(result);return result;},getStore:()=>activeStore,getDraft:()=>draft,getReturns:()=>records,getActor:()=>actor,editDraft:change=>change(draft),scope:()=>generation,isCurrent:value=>value===generation,command:async(type,payload)=>{sent.push({type,payload});return {...records.find(row=>row.id===(payload.creditId||payload.returnId)),...payload,status:'approved',version:2};},api:async url=>url.startsWith('/api/orders?')?{orders:[{id:'o1',storeId:'s1',invoiceNumber:'AW-1',status:'delivered'}],nextCursor:null}:{order:{id:'o1',storeId:'s1',invoiceNumber:'AW-1',status:'delivered',lines:[]}},showReturn:()=>{}};
  const all=root=>[root,...(root.children||[]).filter(child=>typeof child==='object').flatMap(all)];
  return {ctx,dialogs,sent,errors,all,setRecords:value=>records=value,getDraft:()=>draft,changeStore:()=>{generation++;activeStore={id:'s2',name:'Other'};draft={id:'other',storeId:'s2',creditRequestIds:[]};},button:(root,label)=>all(root).find(item=>item.tag==='button'&&item.children.includes(label))};
}
test('builder attachment changes only the active draft and never reduces its order lines',async()=>{
  const {createOrderCredits}=await modulePromise; assert.equal(typeof createOrderCredits,'function');
  const f=harness(); f.setRecords([{id:'r1',storeId:'s1',kind:'adjustment',status:'pending',totalCents:108,reason:'Price correction',createdBy:'buyer',version:1}]);
  const ui=createOrderCredits(f.ctx),section=ui.renderBuilderSection();
  const toggle=f.all(section).find(item=>item.tag==='input'&&item.type==='checkbox'); assert.ok(toggle);
  toggle.checked=true; toggle.events.change(); assert.deepEqual(f.getDraft().creditRequestIds,['r1']);
  f.changeStore(); toggle.checked=false; assert.throws(()=>toggle.events.change(),/changed|store|draft/i);
  assert.deepEqual(f.getDraft().creditRequestIds,[]);
});
test('owner approval posts the reviewed record and customer detail has no approve action',async()=>{
  const {createOrderCredits}=await modulePromise; assert.equal(typeof createOrderCredits,'function');
  const record={id:'r1',storeId:'s1',kind:'adjustment',status:'pending',subtotalCents:100,taxCents:8,totalCents:108,reason:'Price correction',lines:[],createdBy:'buyer',version:3};
  const owner=harness({uid:'owner',role:'master'}); owner.setRecords([record]);
  createOrderCredits(owner.ctx).showCreditDetails(record); const approve=owner.button(owner.dialogs[0].footer,'Approve account credit'); assert.ok(approve); await approve.action();
  assert.equal(owner.sent[0].type,'credit.approve'); assert.deepEqual(owner.sent[0].payload,{storeId:'s1',creditId:'r1',expectedVersion:3});
  const customer=harness(); customer.setRecords([record]); createOrderCredits(customer.ctx).showCreditDetails(record);
  assert.equal(customer.button(customer.dialogs[0].footer,'Approve account credit'),undefined); assert.ok(customer.button(customer.dialogs[0].footer,'Cancel request'));
});
test('adjustment form sends exact cents for the chosen verified invoice and attaches the new request',async()=>{
  const {createOrderCredits}=await modulePromise,f=harness();
  f.ctx.command=async(type,payload)=>{f.sent.push({type,payload});return {id:'new-credit',storeId:'s1',...payload,status:'pending',kind:'adjustment',version:1};};
  await createOrderCredits(f.ctx).showRequest();const m=f.dialogs[0],nodes=f.all(m.content);
  const requestType=nodes.find(node=>node.tag==='select'&&!node.attrs['aria-label']);requestType.value='adjustment';requestType.events.change();
  const invoice=nodes.find(node=>node.tag==='select'&&node.attrs['aria-label']==='Original delivered invoice');invoice.value='o1';
  const amounts=nodes.filter(node=>node.tag==='input'&&node.placeholder==='0.00');amounts[0].value='0.29';amounts[1].value='0.03';
  nodes.find(node=>node.tag==='textarea').value='Supported correction';
  await f.all(m.footer).find(node=>node.textContent==='Request credit').action();
  assert.deepEqual(f.sent[0],{type:'credit.request',payload:{storeId:'s1',orderId:'o1',reason:'Supported correction',subtotalCents:29,taxCents:3}});
  assert.deepEqual(f.getDraft().creditRequestIds,['new-credit']);
});
test('unverified form preserves item quantity and reference without inventing a price',async()=>{
  const {createOrderCredits}=await modulePromise,f=harness();
  f.ctx.command=async(type,payload)=>{f.sent.push({type,payload});return {id:'new-credit',storeId:'s1',...payload,status:'pending',kind:'unverified',version:1};};
  await createOrderCredits(f.ctx).showRequest();const m=f.dialogs[0],nodes=f.all(m.content);
  const requestType=nodes.find(node=>node.tag==='select'&&!node.attrs['aria-label']);requestType.value='unverified';requestType.events.change();
  nodes.find(node=>node.placeholder==='Paper invoice number, Mail order reference or date').value='Paper 123';
  nodes.find(node=>node.placeholder==='Product and flavor or the original sale').value='Orange drink';
  nodes.find(node=>node.type==='number').value='3';nodes.find(node=>node.tag==='textarea').value='Wrong delivery';
  await f.all(m.footer).find(node=>node.textContent==='Request credit').action();
  assert.deepEqual(f.sent[0].payload,{storeId:'s1',reason:'Wrong delivery',originalReference:'Paper 123',lines:[{name:'Orange drink',quantity:3,unit:'each'}]});
});
test('staff receipt form defaults to nonresalable and sends selected-unit partial quantities',async()=>{
  const {createOrderCredits}=await modulePromise,f=harness({uid:'rep',role:'salesman'});
  const r={id:'r1',storeId:'s1',status:'approved',version:2,totalCents:400,reason:'Goods returned',lines:[{lineId:'l1',name:'Orange drink',variant:'Orange',quantity:4,unit:'case',packSize:12}],physical:{lines:[{lineId:'l1',variant:'Orange',pickedQuantity:3,receivedQuantity:1}]}};f.setRecords([r]);
  createOrderCredits(f.ctx).showCreditDetails(r);await f.button(f.dialogs[0].footer,'Receive & inspect').action();
  const receipt=f.dialogs[1],nodes=f.all(receipt.content);nodes.find(node=>node.type==='number').value='1';
  await f.button(receipt.footer,'Record receipt & inspection').action();
  assert.deepEqual(f.sent[0],{type:'return.receive',payload:{storeId:'s1',returnId:'r1',expectedVersion:2,lines:[{lineId:'l1',variant:'Orange',quantity:1,disposition:'nonresalable'}],note:''}});
});
test('a stale invoice response cannot populate another store request dialog',async()=>{
  const {createOrderCredits}=await modulePromise,f=harness();let resolve;
  f.ctx.api=()=>new Promise(done=>{resolve=done;});
  const loading=createOrderCredits(f.ctx).showRequest();f.changeStore();resolve({orders:[{id:'private',storeId:'s1',invoiceNumber:'PRIVATE',status:'delivered'}]});await loading;
  const invoice=f.all(f.dialogs[0].content).find(node=>node.tag==='select'&&node.attrs['aria-label']==='Original delivered invoice');
  assert.equal(invoice.children.some(node=>node.value==='private'),false);assert.equal(f.sent.length,0);
});
