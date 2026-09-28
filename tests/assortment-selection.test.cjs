const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const load=path=>import('data:text/javascript;base64,'+fs.readFileSync(require('node:path').join(__dirname,'../public',path)).toString('base64'));
test('Each expands quantities per flavor and Mix retains one total with exclusions',async()=>{
 const {assortmentLines}=await load('order-assortments.js');const p={id:'p',variants:['Cola','Grape','Orange'],packSize:12};
 const each=assortmentLines(p,{mode:'each',quantity:2,unit:'case',excludedVariants:['Grape']});
 assert.equal(each.length,2);assert.equal(each.reduce((s,l)=>s+l.quantity,0),4);
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
