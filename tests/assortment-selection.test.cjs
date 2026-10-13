const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const load=path=>import('data:text/javascript;base64,'+fs.readFileSync(require('node:path').join(__dirname,'../public',path)).toString('base64'));
test('Each remains one logical selection and Mix retains one total with exclusions',async()=>{
 const {assortmentLines}=await load('order-assortments.js');const p={id:'p',variants:['Cola','Grape','Orange'],packSize:12};
 const each=assortmentLines(p,{mode:'each',quantity:2,unit:'case',excludedVariants:['Grape']});
 assert.equal(each.length,1);assert.equal(each[0].quantity,2);assert.equal(each[0].selectionMode,'each');assert.deepEqual(each[0].allowedVariants,['Cola','Orange']);assert.deepEqual(each[0].excludedVariants,['Grape']);
 const mix=assortmentLines(p,{mode:'mix',quantity:6,unit:'case',excludedVariants:['Grape']});
 assert.equal(mix.length,1);assert.equal(mix[0].quantity,6);assert.deepEqual(mix[0].allowedVariants,['Cola','Orange']);
 assert.throws(()=>assortmentLines(p,{mode:'mix',quantity:1,excludedVariants:p.variants}));
});
test('different exclusions never merge mixed requests',async()=>{
 const {addSelectedProductLines}=await load('order-selection.js');
 const base={productId:'p',variant:'',unit:'each',quantity:2,selectionMode:'mix',allowedVariants:['Cola'],excludedVariants:['Grape']};let n=0;
 const result=addSelectedProductLines([{...base,id:'one'}],[{...base,allowedVariants:['Grape'],excludedVariants:['Cola']}],()=>`id${++n}`);
 assert.equal(result.length,2);
});
test('formatted order carries mix exclusions and addition reference',async()=>{
 const {formatOrder}=await import('../public/order-format.mjs');
 const formatted=formatOrder({storeName:'Shop',additionReference:'Order 123',lines:[{productId:'p',name:'Faygo',quantity:6,unit:'case',selectionMode:'mix',allowedVariants:['Cola'],excludedVariants:['Grape']}]});
 assert.match(formatted.text,/Mix/i);assert.match(formatted.text,/Grape/);assert.match(formatted.text,/Order 123/);assert.match(formatted.html,/Grape/);
});

test('compiled Each remains one row with exclusions and never lists unselected flavors',async()=>{
 const {formatOrder}=await import('../public/order-format.mjs');
 const result=formatOrder({storeName:'Shop',lines:[{productId:'p',name:'Faygo',quantity:2,unit:'each',selectionMode:'each',allowedVariants:['Cola','Orange'],excludedVariants:['Grape']}]});
 assert.match(result.text,/2 each/);assert.match(result.text,/NO Grape/);assert.match(result.html,/2 each/);assert.doesNotMatch(result.text,/Cola|Orange/);assert.equal(result.groups[0].items.length,1);
});

function panelHarness(product, selection) {
 const nodes=[];
 const node=(tag,attrs={},...children)=>{const out={tag,...attrs,children:children.flat().filter(Boolean),events:{},append(...items){this.children.push(...items.flat().filter(Boolean));},setAttribute(name,value){this[name]=value;},addEventListener(name,fn){this.events[name]=fn;},classList:{toggle(){}}};nodes.push(out);return out;};
 const helpers={product,selection,el:node,input:(type,value,attrs)=>node('input',{type,value:String(value),...attrs}),button:(text,click,cls)=>node('button',{text,click,class:cls}),field:(label,input)=>node('label',{text:label},input),onAdd:()=>{}};
 return {nodes,helpers};
}
test('adding a catalog flavor preserves Each quantity, exclusions, and unfinished input across panel rebuilds',async()=>{
 const {createAssortmentPanel}=await load('order-assortments.js');
 const product={id:'p',variants:['Cola','Grape']};const original=panelHarness(product);
 const first=createAssortmentPanel(original.helpers);original.nodes.find(x=>x.text==='Each').click();
 const quantity=original.nodes.find(x=>x.type==='number');quantity.value='2';quantity.events.input();
 const exclude=original.nodes.find(x=>x['aria-label']==='Exclude Grape');exclude.checked=true;exclude.events.change();
 const saved=first.getSelection();assert.deepEqual(saved,{mode:'each',quantity:'2',excludedVariants:['Grape']});
 const next=panelHarness({...product,variants:['Cola','Grape','Orange']},saved);const second=createAssortmentPanel(next.helpers);assert.deepEqual(second.getSelection(),saved);assert.equal(next.nodes.find(x=>x['aria-label']==='Exclude Grape').checked,true);
 next.nodes.find(x=>x.type==='number').value='';assert.equal(second.getSelection().quantity,'');
 const cleared=panelHarness({...product,variants:['Cola','Orange']},second.getSelection());const third=createAssortmentPanel(cleared.helpers);assert.deepEqual(third.getSelection(),{mode:'each',quantity:'',excludedVariants:[]});assert.equal(cleared.nodes.find(x=>x.textContent==='Add each').disabled,true);
});
