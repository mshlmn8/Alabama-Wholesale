export function assortmentLines(product, {mode,quantity,unit='each',excludedVariants=[],note=''}) {
  const variants=product.variants?.length ? [...product.variants] : [''];
  if(!['mix','each'].includes(mode)||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000)throw new Error('Enter a whole quantity from 1 to 1,000,000.');
  if(!['each','case'].includes(unit)||(unit==='case'&&(!Number.isSafeInteger(product.packSize)||product.packSize<1)))throw new Error('Cases need a configured pack size.');
  if(!Array.isArray(excludedVariants)||new Set(excludedVariants).size!==excludedVariants.length||excludedVariants.some(v=>!variants.includes(v)))throw new Error('Choose existing flavors for exceptions.');
  const allowedVariants=variants.filter(v=>!excludedVariants.includes(v));
  if(!allowedVariants.length)throw new Error('Keep at least one flavor available.');
  const base={productId:product.id,quantity,unit,note:note.trim()};
  return [{...base,variant:'',selectionMode:mode,allowedVariants,excludedVariants:[...excludedVariants]}];
}

export function assortmentLabel(line) {
  if(!['mix','each'].includes(line.selectionMode))return line.variant||'';
  return `${line.selectionMode==='each'?'Each':'Mix'}${line.excludedVariants?.length?' · NO '+line.excludedVariants.map(v=>v||'Standard').join(', '):''}`;
}

export function createAssortmentPanel({product,el,input,button,field,onAdd,getNote=()=>'',priceFor=()=>null,selection={}}) {
  const variants=product.variants?.length?[...product.variants]:[''];
  const exclusions=new Set(Array.isArray(selection.excludedVariants)?selection.excludedVariants.filter(variant=>variants.includes(variant)):[]);let mode=selection.mode==='each'?'each':'mix';
  const root=el('section',{class:'assortment-panel',hidden:true,'aria-label':'Mix or each ordering'});
  const quantity=input('number',selection.quantity??1,{min:1,max:1000000,step:1,inputmode:'numeric','aria-label':'Mix or each quantity'});
  const warning=el('p',{class:'small',hidden:true});
  const mixButton=button('Mix',()=>setMode('mix'),'primary');
  const eachButton=button('Each',()=>setMode('each'));
  function setMode(next){mode=next;mixButton.classList.toggle('primary',next==='mix');eachButton.classList.toggle('primary',next==='each');mixButton.setAttribute('aria-pressed',String(next==='mix'));eachButton.setAttribute('aria-pressed',String(next==='each'));update();}
  const add=button('Add mix',()=>onAdd(assortmentLines(product,{mode,quantity:Number(quantity.value),unit:'each',excludedVariants:[...exclusions],note:getNote()})),'primary');
  function update(){
    const count=variants.length-exclusions.size,q=Number(quantity.value),valid=Number.isSafeInteger(q)&&q>0&&q<=1000000&&count>0;
    quantity.setAttribute('aria-label',mode==='each'?'Quantity per flavor':'Mix quantity');
    const prices=variants.filter(v=>!exclusions.has(v)).map(v=>priceFor({productId:product.id,variant:v,unit:'each'}));
    const varied=mode==='mix'&&new Set(prices).size>1;
    warning.hidden=!varied;warning.textContent='These flavors have different prices. Choose an exact flavor split in Choose flavors before submitting.';
    add.disabled=!valid||varied;add.textContent=mode==='mix'?'Add mix':'Add each';
  }
  const list=el('div',{class:'assortment-exceptions',role:'group','aria-label':'Excluded flavors'});
  variants.forEach(variant=>{
    const checkbox=input('checkbox','',{ 'aria-label':`Exclude ${variant||'Standard'}` });
    checkbox.checked=exclusions.has(variant);
    checkbox.addEventListener('change',()=>{if(checkbox.checked)exclusions.add(variant);else exclusions.delete(variant);update();});
    const row=el('label',{class:'check-field'},checkbox,variant||'Standard');list.append(row);
  });
  quantity.addEventListener('input',update);
  root.append(el('div',{class:'assortment-mode actions'},mixButton,eachButton),field('Quantity',quantity),el('h3',{},'Exclude flavors'),list,warning,add);
  root.addButton=add;
  root.getSelection=()=>({mode,quantity:quantity.value,excludedVariants:[...exclusions]});
  setMode(mode);return root;
}

export function showPicking({order,el,input,button,modal,command,onSaved,isCurrent=()=>true}) {
  const m=modal('Confirm picked flavors','');
  const entries=order.lines.filter(l=>['mix','each'].includes(l.selectionMode)).map(line=>{
    const rows=line.allowedVariants.map(variant=>({variant,control:input('number',line.allocations?.find(a=>a.variant===variant)?.quantity||0,{min:0,step:1,'aria-label':`${line.name}: ${variant||'Standard'} picked`})}));
    m.content.append(el('section',{class:'panel'},el('h3',{},`${line.name}: ${line.quantity}${line.selectionMode==='each'?' each':''}`),el('p',{},assortmentLabel(line)),...rows.map(row=>el('label',{class:'split'},row.variant||'Standard',row.control))));
    return {line,rows};
  });
  m.footer.append(button('Cancel',m.close),button('Confirm picked flavors',async()=>{
    if(!isCurrent())throw new Error('The account or store changed. Reopen this order.');
    const allocations=entries.map(({line,rows})=>({lineId:line.id,variants:rows.map(({variant,control})=>({variant,quantity:Number(control.value)})).filter(a=>a.quantity!==0)}));
    const result=await command('order.pick',{id:order.id,expectedVersion:order.version,allocations});m.close();if(isCurrent())onSaved?.(result);
  },'primary'));
}
