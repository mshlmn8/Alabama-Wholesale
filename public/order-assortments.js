export function assortmentLines(product, {mode,quantity,unit='each',excludedVariants=[],note=''}) {
  const variants=product.variants?.length ? [...(product.standardVariantEnabled?['']:[]),...product.variants] : [''];
  if(!['mix','each'].includes(mode)||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000)throw new Error('Enter a whole quantity from 1 to 1,000,000.');
  if(!['each','case'].includes(unit)||(unit==='case'&&(!Number.isSafeInteger(product.packSize)||product.packSize<1)))throw new Error('Cases need a configured pack size.');
  if(!Array.isArray(excludedVariants)||new Set(excludedVariants).size!==excludedVariants.length||excludedVariants.some(v=>!variants.includes(v)))throw new Error('Choose existing flavors for exceptions.');
  const allowedVariants=variants.filter(v=>!excludedVariants.includes(v));
  if(!allowedVariants.length)throw new Error('Keep at least one flavor available.');
  const base={productId:product.id,quantity,unit,note:note.trim()};
  return mode==='each'?allowedVariants.map(variant=>({...base,variant})):[{...base,variant:'',selectionMode:'mix',allowedVariants,excludedVariants:[...excludedVariants]}];
}

export function assortmentLabel(line) {
  if(line.selectionMode!=='mix')return line.variant||'Standard';
  return `Mix${line.excludedVariants?.length?' · NO '+line.excludedVariants.map(v=>v||'Standard').join(', '):''}`;
}

export function createAssortmentPanel({product,el,input,button,field,onAdd,getNote=()=>'',priceFor=()=>null}) {
  const variants=product.variants?.length?[...(product.standardVariantEnabled?['']:[]),...product.variants]:[''];
  const exclusions=new Set();let mode='mix';
  const root=el('section',{class:'assortment-panel',hidden:true,'aria-label':'Mix or each ordering'});
  const quantity=input('number',1,{min:1,max:1000000,step:1,inputmode:'numeric','aria-label':'Mix or each quantity'});
  const unit=el('select',{'aria-label':'Mix or each order unit'},el('option',{value:'each'},'Item'),Number.isSafeInteger(product.packSize)&&product.packSize>0?el('option',{value:'case'},`Case (${product.packSize} items)`):null);
  const preview=el('p',{class:'assortment-preview',role:'status','aria-live':'polite'});
  const warning=el('p',{class:'small',hidden:true});
  const mixButton=button('Mix',()=>setMode('mix'),'primary');
  const eachButton=button('Each',()=>setMode('each'));
  function setMode(next){mode=next;mixButton.classList.toggle('primary',next==='mix');eachButton.classList.toggle('primary',next==='each');mixButton.setAttribute('aria-pressed',String(next==='mix'));eachButton.setAttribute('aria-pressed',String(next==='each'));update();}
  const add=button('Add mix',()=>onAdd(assortmentLines(product,{mode,quantity:Number(quantity.value),unit:unit.value,excludedVariants:[...exclusions],note:getNote()})),'primary');
  function update(){
    const count=variants.length-exclusions.size,q=Number(quantity.value),valid=Number.isSafeInteger(q)&&q>0&&q<=1000000&&count>0;
    const unitName=unit.value==='case'?'cases':'items';
    preview.textContent=!count?'Keep at least one flavor available.':mode==='mix'?`Mix ${valid?q:'…'} ${unitName} total across ${count} allowed flavors. The picker chooses the split.`:`${valid?q:'…'} ${unitName} of each of ${count} flavors = ${valid?q*count:'…'} ${unitName}.`;
    const prices=variants.filter(v=>!exclusions.has(v)).map(v=>priceFor({productId:product.id,variant:v,unit:unit.value}));
    const varied=mode==='mix'&&new Set(prices).size>1;
    warning.hidden=!varied;warning.textContent='These flavors have different prices. Choose an exact flavor split in Choose flavors before submitting.';
    add.disabled=!valid||varied;add.textContent=mode==='mix'?'Add mix':'Add each flavor';
  }
  const search=input('search','',{placeholder:'Find a flavor to exclude','aria-label':'Search flavor exceptions'});
  const list=el('div',{class:'assortment-exceptions',role:'group','aria-label':'Excluded flavors'});
  const rows=variants.map(variant=>{
    const checkbox=input('checkbox','',{ 'aria-label':`Exclude ${variant||'Standard'}` });
    checkbox.addEventListener('change',()=>{if(checkbox.checked)exclusions.add(variant);else exclusions.delete(variant);update();});
    const row=el('label',{class:'check-field'},checkbox,variant||'Standard');list.append(row);return {variant,row};
  });
  search.addEventListener('input',()=>rows.forEach(({variant,row})=>row.hidden=!(variant||'Standard').toLowerCase().includes(search.value.toLowerCase())));
  quantity.addEventListener('input',update);unit.addEventListener('change',update);
  root.append(el('div',{class:'actions'},mixButton,eachButton),el('div',{class:'form-grid'},field('Quantity',quantity),field('Order unit',unit)),el('h3',{},'Exclude flavors'),el('p',{class:'small'},'Checked flavors will not be included.'),search,list,preview,warning,add);
  setMode('mix');return root;
}

export function showPicking({order,el,input,button,modal,command,onSaved,isCurrent=()=>true}) {
  const m=modal('Confirm picked flavors','Enter actual flavor quantities. Their total must equal each mixed item’s requested quantity.');
  const entries=order.lines.filter(l=>l.selectionMode==='mix').map(line=>{
    const rows=line.allowedVariants.map(variant=>({variant,control:input('number',line.allocations?.find(a=>a.variant===variant)?.quantity||0,{min:0,step:1,'aria-label':`${line.name}: ${variant||'Standard'} picked`})}));
    m.content.append(el('section',{class:'panel'},el('h3',{},`${line.name}: ${line.quantity} ${line.unit}`),el('p',{},assortmentLabel(line)),...rows.map(row=>el('label',{class:'split'},row.variant||'Standard',row.control))));
    return {line,rows};
  });
  m.footer.append(button('Cancel',m.close),button('Confirm picked flavors',async()=>{
    if(!isCurrent())throw new Error('The account or store changed. Reopen this order.');
    const allocations=entries.map(({line,rows})=>({lineId:line.id,variants:rows.map(({variant,control})=>({variant,quantity:Number(control.value)})).filter(a=>a.quantity!==0)}));
    const result=await command('order.pick',{id:order.id,expectedVersion:order.version,allocations});m.close();if(isCurrent())onSaved?.(result);
  },'primary'));
}
