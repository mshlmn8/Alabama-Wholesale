'use strict';
// Synthetic in-memory preview data only; never imported by production().
const {executeCommand}=require('../lib/domain.cjs');
const {randomUUID}=require('node:crypto');
module.exports=async function seedExpansionDemo(repo,actor){
 const day=86400000,now=Date.now();
 const run=(type,payload,at)=>repo.transaction(tx=>executeCommand(tx,actor,{id:randomUUID(),type,payload},{now:at,id:randomUUID}));
 for(const ago of [35,28,21,14,7]){
  const at=now-ago*day;
  let order=await run('order.save',{id:'demo-history-'+ago,storeId:'store-one',lines:[{id:'orange-line',productId:'orange',variant:'Orange',quantity:4,unit:'each'},{id:'chips-line',productId:'chips',variant:'',quantity:2,unit:'each'}],notes:'Synthetic weekly order for preview'},at);
  order=await run('order.submit',{id:order.id,expectedVersion:order.version},at);
  for(const status of ['approved','picking','delivered'])order=await run('order.transition',{id:order.id,expectedVersion:order.version,status},at+1000);
 }
 let version=0;
 for(const [i,ago] of [36,29,22,15,8,1].entries()){
  const row=await run('storeInventory.count',{storeId:'store-one',productId:'orange',variant:'Orange',quantity:24-i*2,unit:'each',measuredAt:now-ago*day,targetEach:24,expectedVersion:version,note:'Synthetic shelf count'},now);
  version=row.version;
 }
 // A partially received supplier order demonstrates shared warehouse stock.
 const supplier=await run('supplier.save',{id:'demo-supplier',name:'Example Beverage Supplier',email:'supplier@example.com',terms:'Synthetic preview only',notes:'Demonstration records; no supplier is contacted.'},now);
 const mapping=await run('supplierProduct.save',{id:'demo-supplier-lime',supplierId:supplier.id,productId:'orange',variant:'Lime',supplierSku:'DEMO-LIME-12',unit:'case',packSize:12,orderMultiple:1,unitCostCents:1500,leadTimeDays:3},now);
 let po=await run('purchase.save',{id:'demo-purchase',supplierId:supplier.id,expectedDeliveryAt:now+day,notes:'Synthetic partial receipt: 4 accepted, 2 damaged awaiting replacement, 6 outstanding.',lines:[{id:'demo-purchase-line',supplierProductId:mapping.id,quantity:10}]},now);
 po=await run('purchase.order',{id:po.id,expectedVersion:po.version},now);
 await run('purchase.receive',{id:po.id,expectedVersion:po.version,lines:[{lineId:'demo-purchase-line',acceptedQuantity:4,rejectedQuantity:2,rejectedDisposition:'replacement'}],note:'Synthetic preview delivery'},now);
};
