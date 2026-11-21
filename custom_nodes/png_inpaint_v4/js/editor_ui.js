import { t as inpaintText } from './language.js';
export const ADD_OBJECT = 'Добавить предмет за контур';
export const MODE_LABELS={
 'Ретушь: мелкая деталь / татуировка':inpaintText("Убрать мелкую деталь"),
 'Удалить и восстановить':'Удалить и восстановить',
 'Заменить одежду / предмет':inpaintText("Заменить одежду или предмет"),
 'Изменить форму / пропорции':inpaintText("Изменить пропорции внутри силуэта"),
 'Перекрасить без генерации':inpaintText("Перекрасить"),
 'Мягкая ретушь кожи / поверхности':inpaintText("Мягко исправить поверхность"),
 [ADD_OBJECT]:ADD_OBJECT,
};
export const DEFAULT_STRENGTH=[.48,.86,.92,.80,0,.28,.95];
export const modeIndex=mode=>Object.keys(MODE_LABELS).indexOf(mode);
export const value=(node,name)=>node?.widgets?.find(w=>w.name===name)?.value;
export function setValue(node,name,v){const w=node?.widgets?.find(w=>w.name===name);if(w){w.value=v;w.callback?.(v);node.setDirtyCanvas?.(true,true);}}
export function processorFor(source){
 const graph=source.graph;if(!graph)return null;
 const queue=[source],seen=new Set();
 while(queue.length){const n=queue.shift();if(seen.has(n.id))continue;seen.add(n.id);
  if(n.comfyClass==='PNGV4UniversalInpaint')return n;
  for(const out of n.outputs||[])for(const id of out.links||[]){const link=graph.links?.[id],next=link&&graph.getNodeById(link.target_id);if(next)queue.push(next);}
 }return null;
}
export function sourceFor(processor){
 for(const input of processor.inputs||[]){const l=processor.graph?.links?.[input.link];const n=l&&processor.graph.getNodeById(l.origin_id);if(n?.comfyClass==='PNGV4AlphaInpaintSource')return n;}return null;
}
export function help(parent,text){
 const b=document.createElement('button');b.type='button';b.textContent='ⓘ';b.title=text;b.setAttribute('aria-label',inpaintText("Справка: ")+text.split('.')[0]);
 Object.assign(b.style,{border:'none',background:'transparent',color:'#a9cbdc',cursor:'help',padding:'2px 5px'});
 const info=document.createElement('span');info.textContent=text;info.hidden=true;Object.assign(info.style,{fontSize:'12px',lineHeight:'1.4',flexBasis:'100%',color:'#c7d5df'});
 b.onclick=e=>{e.preventDefault();info.hidden=!info.hidden;};parent.append(b,info);return b;
}
export function slider(parent,label,{min=0,max=1,step=.01,value:initial=0,onChange=()=>{},format=v=>String(v),description='',commitOnBlur=false}={}){
 const wrap=document.createElement('label');Object.assign(wrap.style,{display:'flex',alignItems:'center',gap:'8px',flexWrap:'wrap'});
 const text=document.createElement('span');text.textContent=label;
 const range=document.createElement('input');Object.assign(range,{type:'range',min,max,step,value:initial});range.setAttribute('aria-label',label+inpaintText(" — ползунок"));range.style.width='150px';
 const number=document.createElement('input');Object.assign(number,{type:'number',min,max,step,value:initial});number.setAttribute('aria-label',label);number.style.width='68px';
 const out=format?document.createElement('output'):null;if(out)out.style.fontSize='12px';
 let applied=initial;
 function reflect(v){
  applied=v;
  range.value=String(v);
  if(out)out.textContent=format(v);
 }
 function normalized(){
  const typed=number.valueAsNumber;
  if(!Number.isFinite(typed))return applied;
  const bounded=Math.max(min,Math.min(max,typed));
  return Number((min+Math.round((bounded-min)/step)*step).toFixed(10));
 }
 // While typing, leave the browser's text and caret alone, including a pending
 // decimal separator. The slider may have a smaller maximum than the number.
 number.oninput=()=>{
  if(commitOnBlur||number.value===''||!number.validity.valid)return false;
  reflect(number.valueAsNumber);
  onChange(applied);
  return true;
 };
 function commit(){
  const v=normalized();
  number.value=String(v);
  if(v===applied)return;
  if(commitOnBlur){reflect(v);onChange(v);}
  else number.oninput();
 }
 number.onchange=number.onblur=commit;
 number.onkeydown=e=>{if(e.key==='Enter'&&!e.isComposing){e.preventDefault();e.stopPropagation();commit();}};
 range.oninput=()=>{
  number.value=range.value;
  if(commitOnBlur)commit();else number.oninput();
 };
 wrap.append(text,range,number);if(out)wrap.append(out);if(description)help(wrap,description);parent.append(wrap);reflect(initial);
 number.sync=()=>{const v=normalized();number.value=String(v);reflect(v);};number.container=wrap;number.range=range;return number;
}
export function isTextEditing(target){return !!target?.closest?.('textarea,input:not([type=range]):not([type=checkbox]):not([type=color]),[contenteditable=true]');}
export function isUndoKey(e){return (e.ctrlKey||e.metaKey)&&!e.shiftKey&&(e.code==='KeyZ'||e.key?.toLowerCase()==='z'||e.key?.toLowerCase()==='я');}
export function installEditorUndo(modal,undo,blocked=()=>false,appConstructor=null,removePoint=()=>{}){
 // Comfy's ChangeTracker captures keydown before extension listeners and queues
 // a later undo. Honour its mask-editor guard while our own dialog is open.
 const original=appConstructor?.maskeditor_is_opended;
 const guard=function(...args){return modal.open||original?.apply(this,args)||false;};
 if(appConstructor)appConstructor.maskeditor_is_opended=guard;
 // A native dialog makes the graph inert for clicks, but its document-level
 // shortcuts still receive keyboard events. Intercept both halves at window capture.
 const intercept=e=>{
  if(!modal.open)return;
  const deletion=e.key==='Delete'||e.key==='Backspace';
  if(!deletion&&!isUndoKey(e))return;
  e.stopImmediatePropagation();
  if(isTextEditing(e.target)||e.target?.isContentEditable)return; // Keep native text editing.
  e.preventDefault();
  if(e.type!=='keydown'||blocked()||e.isComposing)return;
  if(!deletion)undo();
  else if(!e.repeat&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey)removePoint();
 };
 window.addEventListener('keydown',intercept,true);window.addEventListener('keyup',intercept,true);
 const dispose=()=>{window.removeEventListener('keydown',intercept,true);window.removeEventListener('keyup',intercept,true);if(appConstructor?.maskeditor_is_opended===guard)appConstructor.maskeditor_is_opended=original;};
 modal.addEventListener('close',dispose,{once:true});return dispose;
}
export function colorControl(parent,initial,onChange,onPick){
 const row=document.createElement('div');Object.assign(row.style,{display:'flex',gap:'8px',alignItems:'center',flexWrap:'wrap'});
 const picker=document.createElement('input');picker.type='color';picker.setAttribute('aria-label',inpaintText("Палитра цвета"));picker.style.cssText='width:48px;height:32px;padding:2px';
 const hex=document.createElement('input');hex.type='text';hex.setAttribute('aria-label',inpaintText("Цвет HEX"));hex.style.width='100px';
 const update=(v,notify=true)=>{if(!/^#[0-9a-f]{6}$/i.test(v))return false;picker.value=hex.value=v;if(notify)onChange(v);return true;};
 picker.oninput=()=>update(picker.value);hex.onchange=()=>{if(!update(hex.value))hex.value=picker.value;};
 row.append(picker,hex);if(onPick){const b=document.createElement('button');b.type='button';b.textContent=inpaintText("Пипетка с изображения");b.onclick=onPick;row.append(b);}
 parent.append(row);update(initial||'#c52b35',false);return {row,update,picker,hex};
}
