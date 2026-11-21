import { t as inpaintText } from './language.js';
import { api } from '/scripts/api.js';
import { installContourEditor } from './contour_editor.js';
import {slider} from './editor_ui.js';

export function installSmartWarp(host) {
    const {element,button,layout,pathRow,rowStyle,canvas,width,height}=host;
    const row=element('div',null,rowStyle);layout.insertBefore(row,pathRow);
    const label=element('label',row);label.textContent=inpaintText("Инструмент ");
    const mode=element('select',label,{padding:'7px'});mode.setAttribute('aria-label',inpaintText("Инструмент редактора"));
    for(const [value,text] of [['brush',inpaintText("Кисть / линии")],['smart',inpaintText("Умное выделение")],['warp',inpaintText("Локальная деформация")],['segment',inpaintText("Участок контура · A—B")]]){
        const o=element('option',mode);o.value=value;o.textContent=text;o.disabled=['smart','warp'].includes(value)&&!host.available;
    }
    if(!host.available)element('span',row,{fontSize:'12px',color:'#ffd884'}).textContent=inpaintText("Новые инструменты станут доступны после перезапуска ComfyUI.");
    const smart=element('div',row,{...rowStyle,flexBasis:'100%'}),warp=element('div',row,{...rowStyle,flexBasis:'100%'});
    const pointMode=element('select',smart);pointMode.setAttribute('aria-label',inpaintText("Уточнение выделения"));
    for(const [v,t] of [['include',inpaintText("Включить (+)")],['exclude',inpaintText("Исключить (−)")],['box',inpaintText("Ограничить рамкой")]]){const o=element('option',pointMode);o.value=v;o.textContent=t;}
    const find=button(smart,inpaintText("Найти область"),findArea);
    const candidate=element('select',smart);candidate.setAttribute('aria-label',inpaintText("Вариант выделения"));
    const feather=slider(smart,inpaintText("Сглаживание выделения, px"),{min:0,max:16,step:.5,value:2});
    const apply=button(smart,inpaintText("В маску Inpaint"),()=>accept(false),{background:'#285d74'});
    const hide=button(smart,inpaintText("Скрыть выбранное"),()=>accept(true),{background:'#704249'});
    hide.title=inpaintText("Явно изменяет прозрачность только в выбранной области. Сначала проверьте жёлтый предпросмотр.");
    const reset=button(smart,inpaintText("Сбросить выделение"),clearDraft);
    const warpMode=element('select',warp);warpMode.setAttribute('aria-label',inpaintText("Режим деформации"));
    const warpModes=[['surface',inpaintText("Внутри силуэта · контур фиксирован")],['shrink',inpaintText("Подтянуть край внутрь")],['contour',inpaintText("Только контур внутрь")]];
    if(host.editor41)warpModes.push(['free_edge',inpaintText("Свободная деформация края")]);
    for(const [v,t] of warpModes){
        const o=element('option',warpMode);o.value=v;o.textContent=t;
        if((v==='contour'&&!host.contourAvailable)||(v==='free_edge'&&!host.freeEdgeAvailable)){o.disabled=true;o.textContent+=inpaintText(" · нужен перезапуск ComfyUI");}
    }
    const force=slider(warp,inpaintText("Сила деформации, %"),{min:host.editor41?1:5,max:100,step:1,value:65,format:null});
    const initialDiameter=host.editor41?45:160;
    let brushDiameter=initialDiameter;
    const diameter=slider(warp,inpaintText("Диаметр деформации, px"),{min:host.editor41?1:8,max:1024,step:1,value:initialDiameter,format:null,
        onChange:value=>{brushDiameter=value;host.refresh();}});
    for(const field of [force,diameter]){
        Object.assign(field.container.style,{display:'grid',gridTemplateColumns:'max-content minmax(0,150px) 68px',maxWidth:'100%'});
        Object.assign(field.range.style,{width:'100%',minWidth:'0',margin:'0'});
        Object.assign(field.style,{width:'100%',boxSizing:'border-box',fontVariantNumeric:'tabular-nums'});
    }
    if(host.editor41){
        const range=diameter.range;
        range.max=100;
        range.title=inpaintText("Диаметр от 1 до 100 px, шаг 1 px");
        diameter.title=inpaintText("Точный диаметр от 1 до 1024 px");
        diameter.container.style.gridTemplateColumns='max-content minmax(0,240px) 68px';
        // A larger typed value parks the thumb at 100. Clicking that endpoint
        // again must select 100 even if the native range emits no input event.
        range.onclick=()=>{if(brushDiameter>Number(range.max))range.dispatchEvent(new Event('input',{bubbles:true}));};
    }
    if(host.routed)label.style.display='none';
    const contour=installContourEditor(host,row);
    let points=[],box=null,candidates=[],mask=null,drag=null,busy=false,disposed=false,revision=0,abort=null,previewFrame=0;
    const clamp=p=>[Math.max(0,Math.min(width-1,p[0])),Math.max(0,Math.min(height-1,p[1]))];
    const invalidate=()=>{revision++;candidates=[];mask=null;candidate.replaceChildren();};
    const pending=()=>points.length>0||!!box||!!mask;
    function sync(){
        smart.style.display=mode.value==='smart'?'flex':'none';warp.style.display=mode.value==='warp'?'flex':'none';
        pathRow.style.display=mode.value==='brush'?'flex':'none';
        mode.disabled=busy||!!drag||host.brushPending()||(mode.value==='smart'&&pending())||(mode.value==='segment'&&(contour.pending||contour.busy));
        for(const el of [pointMode,feather,warpMode,force,diameter])el.disabled=busy||!!drag;
        for(const el of [feather,force,diameter])el.range.disabled=el.disabled;
        if(host.targetLabel){apply.textContent=inpaintText("Применить: ")+host.targetLabel();hide.style.display='none';}
        candidate.disabled=busy||!candidates.length;candidate.style.display=candidates.length?'':'none';
        find.disabled=busy||!!drag||(!box&&!points.some(p=>p[2]===1));
        apply.disabled=hide.disabled=busy||!mask;reset.disabled=busy||!pending();
        contour.sync();
    }
    function refresh(){sync();host.refresh();}
    mode.onchange=()=>{host.resetPath();if(mode.value==='segment')contour.activate();else contour.deactivate();host.update();refresh();};
    warpMode.onchange=()=>host.update();
    const featherInput=feather.oninput;feather.oninput=()=>{if(featherInput()){invalidate();refresh();}};
    candidate.onchange=async()=>{
        busy=true;revision++;mask=null;refresh();
        try{await loadCandidate(Number(candidate.value));}
        catch(error){if(!disposed)host.message(error.message,true);}
        finally{busy=false;if(!disposed)refresh();}
    };
    async function loadCandidate(index){
        const token=revision,item=candidates[index];if(!item)return;
        const image=new Image();image.src='data:image/png;base64,'+item.png;await image.decode();
        if(disposed||token!==revision)return;
        const c=document.createElement('canvas');c.width=width;c.height=height;
        const ctx=c.getContext('2d');ctx.drawImage(image,0,0);mask=ctx.getImageData(0,0,width,height);
    }
    async function findArea(){
        busy=true;const token=++revision;abort=new AbortController();refresh();host.message(inpaintText("SAM ищет область на CPU. Первый поиск может занять несколько секунд…"));
        try{
            const response=await api.fetchApi('/png-inpaint-v4/smart-select',{method:'POST',headers:{'Content-Type':'application/json'},signal:abort.signal,
                body:JSON.stringify({...host.request(),points,box,feather:Number(feather.value)})});
            const result=await response.json();if(!response.ok)throw new Error(result.error||inpaintText("Не удалось выделить область"));
            if(disposed||token!==revision)return;
            candidates=result.candidates;candidate.replaceChildren();
            candidates.forEach((c,i)=>{const o=element('option',candidate);o.value=i;o.textContent=`${inpaintText("Область ")}${i+1}`;});
            await loadCandidate(0);host.message(`${inpaintText("Жёлтое — предпросмотр. Проверьте край, уточните −точками или рамкой. Поиск: ")}${result.seconds}${inpaintText(" с")}${result.cached?inpaintText(" · кэш"):''}.`);
        }catch(error){if(!disposed&&error.name!=='AbortError')host.message(error.message,true);}
        finally{busy=false;abort=null;if(!disposed)refresh();}
    }
    function clearDraft(){invalidate();points=[];box=null;refresh();host.update();}
    function accept(alpha){if(!mask||busy)return;host.acceptMask(mask,alpha);clearDraft();host.message(alpha?inpaintText("Выбранная область скрыта. Отмена возвращает прозрачность."):inpaintText("Выделение применено. Можно уточнить кистью или отменить Ctrl+Z."));}
    function opFor(p){return {from:drag.start,to:clamp(p),radius:brushDiameter/2,strength:Number(force.value)/100,mode:warpMode.value};}
    function release(e){const id=drag?.id;drag=null;if(id!==undefined&&canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);}
    function down(e,p){
        if(mode.value==='segment')return contour.down(e,p);
        if(mode.value==='brush')return false;
        if(busy)return true;
        const start=clamp(p);
        if(mode.value==='smart'&&pointMode.value!=='box'){
            if(points.length>=64){host.message(inpaintText("До 64 точек. Сбросьте выделение или примените результат."),true);return true;}
            invalidate();points.push([...start,pointMode.value==='include'?1:0]);refresh();return true;
        }
        drag={start,current:start,id:e.pointerId,kind:mode.value};canvas.setPointerCapture(e.pointerId);refresh();return true;
    }
    function move(e,p){
        if(mode.value==='segment')return contour.move(e,p);
        if(mode.value==='brush')return false;
        if(!drag||e.pointerId!==drag.id)return true;
        drag.current=clamp(p);
        if(drag.kind==='warp'&&!previewFrame)previewFrame=requestAnimationFrame(()=>{previewFrame=0;if(drag)host.previewWarp(opFor(drag.current));});
        refresh();return true;
    }
    async function end(e,p){
        if(mode.value==='segment')return contour.end(e,p);
        if(mode.value==='brush')return false;
        if(!drag||e.pointerId!==drag.id)return true;
        const complete=e.type==='pointerup',saved=drag,op=opFor(p);
        if(previewFrame){cancelAnimationFrame(previewFrame);previewFrame=0;}
        release(e);host.previewWarp(null);
        if(complete&&Math.hypot(op.to[0]-saved.start[0],op.to[1]-saved.start[1])>=1){
            if(saved.kind==='smart'){
                invalidate();box=[Math.min(saved.start[0],op.to[0]),Math.min(saved.start[1],op.to[1]),Math.max(saved.start[0],op.to[0]),Math.max(saved.start[1],op.to[1])];
                if(box[2]-box[0]<1||box[3]-box[1]<1)box=null;
            }else{
                busy=true;refresh();host.message(inpaintText("Применяю деформацию…"));
                try{await host.commitWarp(op);if(!disposed)host.message(inpaintText("Деформация применена. Можно продолжить или отменить этот сдвиг."));}
                catch(error){if(!disposed)host.message(error.message,true);}
                finally{busy=false;}
            }
        }
        if(!disposed)refresh();return true;
    }
    function draw(c,scale){
        if(mode.value==='segment'){contour.draw(c,scale);return;}
        if(mode.value!=='smart')return;
        if(mask){const copy=new ImageData(new Uint8ClampedArray(mask.data),width,height);for(let i=0;i<copy.data.length;i+=4){const v=copy.data[i];copy.data[i]=255;copy.data[i+1]=210;copy.data[i+2]=40;copy.data[i+3]=Math.round(v*.55);}host.drawOverlay(c,copy);}
        c.save();c.lineWidth=1.5/scale;
        const rect=drag?.kind==='smart'?[...drag.start,...drag.current]:box;
        if(rect){c.strokeStyle='#ffd884';c.setLineDash([5/scale,4/scale]);c.strokeRect(rect[0],rect[1],rect[2]-rect[0],rect[3]-rect[1]);c.setLineDash([]);}
        points.forEach(p=>{c.beginPath();c.arc(p[0],p[1],6/scale,0,Math.PI*2);c.fillStyle=p[2]?'#3ad982':'#ff6068';c.fill();c.strokeStyle='#101214';c.stroke();c.strokeStyle='#fff';c.beginPath();c.moveTo(p[0]-3/scale,p[1]);c.lineTo(p[0]+3/scale,p[1]);if(p[2]){c.moveTo(p[0],p[1]-3/scale);c.lineTo(p[0],p[1]+3/scale);}c.stroke();});c.restore();
    }
    function hint(){
        if(mode.value==='segment')return contour.hint();
        if(mode.value==='smart')return inpaintText("Клик + включает деталь, − исключает соседние участки. Рамка ограничивает поиск. После «Найти область» примените жёлтый предпросмотр в маску или явно скройте через прозрачность.");
        switch(warpMode.value){
            case 'free_edge':return inpaintText("Возьмитесь за видимый край и потяните наружу или внутрь. Текстура и прозрачность сдвинутся вместе. Ctrl+Z отменяет последний сдвиг.");
            case 'contour':return inpaintText("Перетяните край внутрь: меняется только прозрачность, рисунок и текстура остаются на месте. Силуэт не расширяется, защищённые детали сохраняются.");
            case 'shrink':return inpaintText("Перетяните выступ к телу. Альфа может только уменьшаться, силуэт не расширяется. Короткие сдвиги сохраняют форму лучше.");
            default:return inpaintText("Перетаскивайте поверхность мягкой кистью. Альфа и защищённые детали сохраняются. Размер круга задаёт область влияния.");
        }
    }
    return {get mode(){return mode.value;},get busy(){return busy||!!drag||(mode.value==='segment'&&contour.busy);},get pending(){return mode.value==='segment'?contour.pending:mode.value==='smart'&&pending();},
        get diameter(){return brushDiameter;},sync,down,move,end,draw,
        setMode(next){if(mode.value===next)return true;if(busy||drag||pending()||contour.pending||host.brushPending())return false;mode.value=next;mode.onchange();return true;},
        hint,
        refreshGeometry(){if(mode.value==='segment')contour.activate();},
        undoDraft(){if(mode.value==='segment')return contour.undo();if(mode.value==='smart'&&pending()&&!busy){invalidate();if(points.length)points.pop();else box=null;refresh();return true;}return false;},
        escape(){if(mode.value==='segment')return contour.escape();if(drag){end({type:'pointercancel',pointerId:drag.id},drag.current);return true;}if(pending()&&!busy){clearDraft();return true;}return false;},
        dispose(){disposed=true;revision++;abort?.abort();contour.dispose();if(previewFrame)cancelAnimationFrame(previewFrame);},
    };
}
