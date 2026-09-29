'use strict';
const {createHash}=require('node:crypto');
// Call inside the stock transaction. A stable source key makes the physical event
// durable even if a caller repeats a completed state transition.
async function recordWarehouseMovement(tx,{sourceType,sourceId,productId,variant='',quantityEach,beforeEach=null,afterEach=null,appliedToInventory=true,reason='',storeId=null},{now,actor}) {
  const id='stock-'+createHash('sha256').update(JSON.stringify([sourceType,sourceId,productId,variant])).digest('hex');
  if(await tx.get('warehouseMovements',id))return;
  await tx.set('warehouseMovements',id,{id,kind:sourceType,sourceType,sourceId,productId,variant,quantityEach,beforeEach,afterEach,appliedToInventory,reason,storeId,effectiveAt:now,recordedAt:now,createdAt:now,createdBy:actor.uid,version:1});
}
module.exports={recordWarehouseMovement};
