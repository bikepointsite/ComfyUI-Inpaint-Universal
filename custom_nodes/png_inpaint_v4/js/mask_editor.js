import { t as inpaintText, language } from './language.js';
import { api } from '/scripts/api.js';
import { app } from '/scripts/app.js';
import { BrushStabilizer } from './brush_paths.js';
import { warpRGBA } from './geometry.js';
import { Underpaint } from './underpaint.js';
import { LightBrush, isLightLayer } from './light_brush.js';
import { installSmartWarp } from './smart_warp_tools.js';
import { prepareViewportOverlay } from './viewport_overlay.js';
import {ElasticCurve,CircularArcCurve,OvalArcCurve,nearestPath} from './elastic_curve.js';
import {referenceSource} from './reference_preview.js';
import {installReferenceRegion} from './reference_region.js';
import {ADD_OBJECT,value,setValue,processorFor,slider,help,colorControl,installEditorUndo} from './editor_ui.js';

export const diameterFromSlider = value => Math.round((1 + 249 * (Number(value) / 1000) ** 2) * 10) / 10;
export const sliderFromDiameter = value => Math.sqrt((Math.max(1, Math.min(250, Number(value))) - 1) / 249) * 1000;
export const panPosition = (start, x, y) => ({left:start.left + start.x - x, top:start.top + start.y - y});
export const alphaAfterEdits = (original, erased, opaque, edge = 0, edgeTarget = original) => Math.round(
    Math.max(original + Math.round((255-original)*opaque/255),
        original + Math.round((edgeTarget-original)*edge/255)) * (255-erased)/255);
export const combineErasure = (previous,cut) => previous+Math.round((255-previous)*cut/255);

export function installBrushCursor(area, canvas, {diameter, hidden, color, position=()=>null}) {
    const viewport = document.createElement('div');
    Object.assign(viewport.style,{position:'fixed', pointerEvents:'none', overflow:'hidden', zIndex:'3'});
    const ring = document.createElement('div');
    ring.setAttribute('data-brush-cursor',''); ring.setAttribute('aria-hidden','true');
    Object.assign(ring.style,{display:'none', position:'absolute', pointerEvents:'none', zIndex:'3',
        border:'1px solid white', boxShadow:'0 0 0 1px #151515', borderRadius:'50%',
        boxSizing:'border-box', transform:'translate(-50%, -50%)'});
    viewport.append(ring); area.append(viewport);
    let pointer = null;
    const refresh = () => {
        const view = area.getBoundingClientRect(), image = canvas.getBoundingClientRect();
        Object.assign(viewport.style,{left:view.left+'px',top:view.top+'px',width:area.clientWidth+'px',height:area.clientHeight+'px'});
        const shown=position()||pointer;
        if (!pointer || !shown || hidden() || shown.x < Math.max(view.left,image.left) || shown.x >= Math.min(view.left+area.clientWidth,image.right) ||
            shown.y < Math.max(view.top,image.top) || shown.y >= Math.min(view.top+area.clientHeight,image.bottom)) {
            ring.style.display = 'none'; return;
        }
        ring.style.width = diameter()*image.width/canvas.width + 'px';
        ring.style.height = diameter()*image.height/canvas.height + 'px';
        ring.style.left = shown.x-view.left + 'px';
        ring.style.top = shown.y-view.top + 'px';
        ring.style.borderColor = color(); ring.style.display = 'block';
    };
    for (const event of ['pointerenter','pointermove','pointerdown','pointerup']) {
        area.addEventListener(event,e=>{pointer={x:e.clientX,y:e.clientY};refresh();});
    }
    area.addEventListener('pointerleave',()=>{pointer=null;refresh();});
    area.addEventListener('pointercancel',()=>{pointer=null;refresh();});
    area.addEventListener('scroll',refresh);
    return refresh;
}

export function installMiddlePan(area, canvas, blocked) {
    let pan = null;
    area.addEventListener('pointerdown', e => {
        if (e.button !== 1 || blocked()) return;
        e.preventDefault(); e.stopPropagation();
        pan = {id:e.pointerId, x:e.clientX, y:e.clientY, left:area.scrollLeft, top:area.scrollTop};
        area.setPointerCapture(e.pointerId); area.style.cursor = canvas.style.cursor = 'grabbing';
    });
    area.addEventListener('pointermove', e => {
        if (!pan || pan.id !== e.pointerId) return;
        e.preventDefault(); const pos = panPosition(pan,e.clientX,e.clientY); area.scrollLeft = pos.left; area.scrollTop = pos.top;
    });
    const endPan = e => {
        if (!pan || pan.id !== e.pointerId) return;
        const id = pan.id; pan = null; area.style.cursor = ''; canvas.style.cursor = 'crosshair';
        if (area.hasPointerCapture(id)) area.releasePointerCapture(id);
    };
    for (const event of ['pointerup','pointercancel','lostpointercapture']) area.addEventListener(event,endPan);
    area.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault();});
    return () => pan !== null;
}

export async function openMaskEditor(node) {
    if (node._alphaEditorOpen) return;
    node._alphaEditorOpen = true;
    const source = node.widgets.find(w => w.name === 'image');
    const maskWidget = node.widgets.find(w => w.name === 'mask_data');
    const selected = source.value, initialPayload = maskWidget.value;
    let modal, frame = 0, pathFrame = 0, smartWarp=null, previewObserver=null,disposeUndo=()=>{};
    const processor=processorFor(node),taskMode=value(processor,'mode')||'Мягкая ретушь кожи / поверхности',recolor=taskMode==='Перекрасить без генерации';
    const extending=taskMode===ADD_OBJECT;
    const extensionHint=inpaintText("Одним выделением захватите край персонажа и прозрачное место, куда должен выступать предмет. Оставьте вокруг него небольшой запас.");
    const startColor=!!node._v4PickColor,startReference=!!node._v4PickReference;delete node._v4PickColor;delete node._v4PickReference;
    try {
        const response = await api.fetchApi('/png-inpaint-v4/source-preview', {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({image:selected,mask_data:initialPayload}),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || inpaintText("Не удалось открыть PNG"));
        const editor41 = node.properties?.inpaintBrushEditor==="4.1";
        const readSurface = editor41 && node.readInpaintSurface
            ? url=>node.readInpaintSurface(url,data.width,data.height) : decodePreview;
        const element = (tag, parent, style = {}) => {
            const el = document.createElement(tag); Object.assign(el.style, style); parent?.append(el); return el;
        };
        const rowStyle = {display:'flex', gap:'10px', alignItems:'center', flexWrap:'wrap'};
        modal = element('dialog', null, {width:'min(1180px,94vw)', height:'92vh', padding:'16px',
            background:'#202226', color:'#eee', border:'1px solid #777', borderRadius:'10px', maxWidth:'96vw', maxHeight:'96vh'});
        modal.setAttribute('aria-label',inpaintText("Маска и прозрачность PNG"));
        modal.className='png-v4-mask-editor';
        element('style',modal).textContent=`
            .png-v4-mask-editor button:disabled {opacity:.45;cursor:not-allowed !important}
            .png-v4-backgrounds button[aria-pressed="true"] {box-shadow:0 0 0 1px #202226,0 0 0 3px #8dd4ff}
            .png-v4-backgrounds button:focus-visible {outline:2px dashed white;outline-offset:3px}
        `;
        const layout = element('div', modal, {display:'flex', flexDirection:'column', gap:'12px', height:'100%'});
        const title = element('h3', layout, {margin:'0', fontSize:'17px'});
        title.textContent = 'Inpaint V4 · '+inpaintText(taskMode);
        const navigation=element('div',layout,rowStyle);
        const section=element('select',navigation,{padding:'7px'});section.setAttribute('aria-label',inpaintText("Раздел редактора"));
        for(const [v,t]of[['generation',inpaintText("Область генерации")],['manual',inpaintText("Ручная правка")]]){const o=element('option',section);o.value=v;o.textContent=recolor&&v==='generation'?inpaintText("Область перекраски"):t;}
        const action=element('select',navigation,{padding:'7px',minWidth:'220px'});action.setAttribute('aria-label',inpaintText("Действие"));
        const method=element('select',navigation,{padding:'7px'});method.setAttribute('aria-label',inpaintText("Как выделить"));
        for(const [v,t]of[['brush',inpaintText("Кистью / линией")],['smart',inpaintText("Умное выделение")]]){const o=element('option',method);o.value=v;o.textContent=t;}
        const stateHint=element('div',layout,{fontSize:'13px',color:'#b8dbe9',lineHeight:'1.4'});
        const tools = element('div', layout, rowStyle);
        const button = (parent, text, fn, style = {}) => {
            const b = element('button', parent, {padding:'8px 12px', cursor:'pointer', borderRadius:'5px',
                border:'1px solid #707780', background:'#353b43', color:'#f2f4f6', ...style});
            b.textContent = text; b.type = 'button'; b.onclick = fn; return b;
        };
        const layerLabel = element('label', tools); layerLabel.textContent = inpaintText("Редактировать ");
        layerLabel.style.display='none';
        const layer = element('select', layerLabel, {padding:'7px'}); layer.setAttribute('aria-label',inpaintText("Слой правки"));
        for (const [value, text] of [['mask',inpaintText("Маска Inpaint")], ['protect',inpaintText("Защитить детали")], ['guide',inpaintText("Нарисовать складку / шов")], ['strength',inpaintText("Сила генерации под кистью")], ['dodge',inpaintText("Осветлить")], ['burn',inpaintText("Затемнить")], ['heal',inpaintText("Донор / лечащая кисть")], ['edge_finish',inpaintText("Доработать край")], ['alpha',inpaintText("Прозрачность PNG")]]) {
            const option = element('option', layer); option.value = value; option.textContent = text;
        }
        layer.add(new Option(inpaintText("Дорисовать по прозрачности"),'underpaint'));
        let erasing = false, makingOpaque = false, editingEdge = false, saving = false;
        let refreshBrushCursor = () => {}, refreshPathPreview = () => {},refit=()=>{};
        const brush = button(tools, inpaintText("Кисть"), () => {erasing = false; makingOpaque = false; editingEdge = false; updateV4();});
        const eraser = button(tools, inpaintText("Ластик маски"), () => {erasing = true; makingOpaque = false; editingEdge = false; updateV4();});
        const opaqueButton = button(tools, inpaintText("Сделать непрозрачным"), () => {erasing = false; makingOpaque = true; editingEdge = false; updateV4();});
        opaqueButton.title = inpaintText("Убирает полупрозрачность внутри персонажа. Внешний край и полностью прозрачные пиксели защищены.");
        opaqueButton.disabled = !data.opaque_region;
        const edgeButton = button(tools, inpaintText("Правка у края"), () => {erasing = false; makingOpaque = false; editingEdge = true; updateV4();});
        edgeButton.title = inpaintText("Убирает полупрозрачность под кистью до исходной кромки PNG. Полностью прозрачный фон и край сглаживания защищены.");
        edgeButton.disabled = !data.edge_alpha_target;
        const undoButton = button(tools, inpaintText("Отменить штрих"), undoStroke);
        navigation.append(undoButton);

        const pathRow=element('div',layout,rowStyle);
        const pathLabel=element('label',pathRow);pathLabel.textContent=inpaintText("Линия ");
        const pathMode=element('select',pathLabel,{padding:'6px'});pathMode.setAttribute('aria-label',inpaintText("Способ рисования"));
        for(const [value,text] of [['free',inpaintText("Обычная кисть")],['smooth',inpaintText("Плавная кисть")],['line',inpaintText("Прямая линия")],['elastic',inpaintText("Гибкая кривая · круговая дуга")],['oval',inpaintText("Овальная дуга")],['curve',inpaintText("Кривая по точкам")]]) {
            const option=element('option',pathMode);option.value=value;option.textContent=text;
        }
        const smoothLabel=element('label',pathRow);smoothLabel.textContent=inpaintText("Стабилизация ");
        const smoothAmount=element('input',smoothLabel,{width:'130px',verticalAlign:'middle'});
        Object.assign(smoothAmount,{type:'range',min:'0',max:'100',step:'1',value:'35'});
        smoothAmount.setAttribute('aria-label',inpaintText("Сила стабилизации"));
        const smoothValue=element('output',smoothLabel);smoothValue.textContent=' 35%';
        smoothAmount.oninput=()=>{smoothValue.textContent=' '+smoothAmount.value+'%';};
        const applyCurveButton=button(pathRow,inpaintText("Применить кривую"),applyCurve,{background:'#285d74',borderColor:'#69a7bd'});
        const removePointButton=button(pathRow,inpaintText("Удалить точку"),()=>{curve.remove();refreshPathPreview();});
        const resetCurveButton=button(pathRow,inpaintText("Сбросить кривую"),()=>{curve.clear();refreshPathPreview();});
        const pointCount=element('span',pathRow,{fontSize:'12px',color:'#bfcbd5'});
        const curveReach=slider(pathRow,inpaintText("Ширина изгиба, %"),{min:editor41?1:10,max:100,step:1,value:55});

        const advancedRow=element('div',layout,rowStyle);
        const field=(text,min,max,step,value,description='')=>slider(advancedRow,text,{min,max,step,value,description});
        const brushStrength=field(inpaintText("Доля общей силы"),0,1,.01,.35,inpaintText("0 — сохранить, 1 — полная сила выбранного режима. Работает только внутри красного выделения. Нужная обработка включится автоматически."));
        const lightAmount=field(inpaintText("Сила света / тени"),0,1,.01,.25,inpaintText("0 — без изменения, 0.25 — мягко, 1 — сильно. При 1 осветление удваивает яркость света, затемнение уменьшает вдвое. Техническая единица — EV."));
        const accumulateLabel=element('label',advancedRow);
        const accumulate=element('input',accumulateLabel);accumulate.type='checkbox';
        accumulateLabel.append(inpaintText(" Накапливать мазки"));
        accumulateLabel.title=data.accumulated_light
            ? inpaintText("Каждое отпускание кисти добавляет выбранную силу. На пересечениях эффект складывается.")
            : inpaintText("Для накопления мазков перезапустите ComfyUI.");
        let baseLightAmount=.25, strokeLightAmount=null;
        let lightHold=null;
        if(editor41){
            const label=element('label',advancedRow);
            label.className='v41-light-fade';label.append(inpaintText("Полная сила до "));
            label.title=inpaintText("Доля длины штриха с выбранной силой. Дальше эффект плавно ослабевает до нуля. При 100% сила постоянна.");
            lightHold=element('input',label);
            Object.assign(lightHold,{type:'range',min:0,max:100,step:1,value:100});
            lightHold.setAttribute('aria-label',inpaintText("Полная сила до"));
            const percent=element('span',label);
            lightHold.oninput=()=>{
                percent.textContent=lightHold.value+'%';
                lightHold.setAttribute('aria-valuetext',Number(lightHold.value)===100?inpaintText("100%, без затухания"):lightHold.value+inpaintText("%, затем плавно до нуля"));
            };
            lightHold.oninput();
        }
        const healAmount=field(inpaintText("Интенсивность ретуши"),0,1,.01,1,inpaintText("0 — исходник, 1 — полный перенос выбранным способом."));
        const edgeAmount=field(inpaintText("Сила доводки"),0,1,.01,.8,inpaintText("Регулирует цвет и светотень вдоль края."));
        const smoothEdgeLabel=element('label',advancedRow);
        const smoothEdge=element('input',smoothEdgeLabel);smoothEdge.type='checkbox';
        smoothEdgeLabel.append(inpaintText(" Сгладить прозрачность"));
        smoothEdgeLabel.title=inpaintText("Слегка смягчает кромку внутрь силуэта только под кистью.");
        const localLayers=['dodge','burn','heal','edge_finish'];
        const donorSize=field(inpaintText("Размер образца, px"),editor41?1:16,512,1,128,inpaintText("Квадрат — участок, который увидит модель как пример. Это не размер лечащей кисти."));
        const healMode=element('select',advancedRow);healMode.setAttribute('aria-label',inpaintText("Режим донора"));
        for(const [value,text] of [['texture',inpaintText("Перенести фактуру, сохранить цвет")],['clone',inpaintText("Копировать цвет и фактуру")]]){
            const o=element('option',healMode);o.value=value;o.textContent=text;
        }
        let donor=null,donorSelected=false,healAnchor=null,pickingDonor=false,referenceDonor=null,referenceFile='',referenceMode=null,pickingColor=startColor;
        let selectedReference='',referenceUploading=false,referenceAbort=null;
        let referenceOriginal='',referenceRegion=null,regionDirty=false;
        async function uploadReference(blob,name,folder,signal) {
            const form=new FormData();
            form.append('image',blob,name);
            form.append('type','temp');
            form.append('subfolder','InpaintV4/References'+folder);
            const response=await api.fetchApi('/upload/image',{method:'POST',body:form,signal});
            if(!response.ok)throw new Error(inpaintText("Не удалось загрузить образец (")+response.status+').');
            const result=await response.json();
            return (result.subfolder?result.subfolder+'/':'')+result.name+' ['+(result.type||'temp')+']';
        }
        let chosenColor=value(processor,'target_color')||'#c52b35',localPreview=null,localTimer=0,localRevision=0,localAbort=null;
        let edgeState=null;
        const edgeAbort=new AbortController();
        const donorButton=button(advancedRow,inpaintText("1. Выбрать чистый участок"),()=>{pickingDonor=!pickingDonor;updateV4();});
        const resetDonor=button(advancedRow,inpaintText("Снять выбор донора"),()=>{
            snapshot('donor');donorSelected=false;pickingDonor=false;updateV4();scheduleRender();
        });
        resetDonor.title=inpaintText("Убирает крестик. Уже нанесённая ретушь сохраняется.");
        const referenceRow=element('div',layout,rowStyle);
        const sampleButton=button(referenceRow,inpaintText("Выбрать на персонаже"),async()=>{
            if(referenceUploading||saving)return;
            referenceUploading=true;referenceAbort=new AbortController();updatePathControls();
            try{
                // Capture the edited pixels, including the current alpha, before drawing editor overlays.
                const sample=newCanvas();
                let pixels;
                if(edgeState||localLayers.some(mapUsed)){
                    await resolveEdge(edgeState);
                    const response=await api.fetchApi('/png-inpaint-v4/local-preview',{
                        method:'POST',headers:{'Content-Type':'application/json'},signal:referenceAbort.signal,
                        body:JSON.stringify({image:selected,mask_data:buildPayload()})
                    });
                    const result=await response.json();
                    if(!response.ok)throw new Error(result.error||inpaintText("Не удалось подготовить ретушь для образца."));
                    pixels=await readSurface(result.preview);
                }else pixels=currentAlphaImage();
                sample.getContext('2d').putImageData(pixels,0,0);
                const blob=await new Promise((resolve,reject)=>sample.toBlob(b=>b?resolve(b):reject(new Error(inpaintText("Не удалось подготовить PNG."))),'image/png'));
                const uploaded=await uploadReference(blob,inpaintText("Персонаж.png"),'/Sources',referenceAbort.signal);
                if(!modal.isConnected)return;
                referenceOriginal=referenceFile=uploaded;referenceRegion=null;regionDirty=false;activateFile();
                referenceEditor.focusSelection();
            }catch(error){if(error.name!=='AbortError')alert(error.message);}
            finally{referenceUploading=false;referenceAbort=null;if(modal.isConnected){updateV4();updatePathControls();}}
        });
        const referenceUpload=button(referenceRow,inpaintText("Загрузить картинку образца"),()=>{
            const file=element('input',modal,{display:'none'});file.type='file';file.accept='image/*';file.oncancel=()=>file.remove();
            file.onchange=async()=>{try{if(!file.files?.[0])return;
                referenceUploading=true;referenceAbort=new AbortController();updateV4();updatePathControls();
                const uploaded=await uploadReference(file.files[0],file.files[0].name,'',referenceAbort.signal);
                if(!modal.isConnected)return;
                referenceOriginal=referenceFile=uploaded;referenceRegion=null;regionDirty=false;
                referenceMode='Загруженный образец';selectedReference='file';referenceDonor=null;pickingDonor=false;
            }catch(error){if(error.name!=='AbortError')alert(error.message);}finally{file.remove();referenceUploading=false;referenceAbort=null;if(modal.isConnected){updateV4();updatePathControls();scheduleRender();}}};file.click();
        });
        const referenceReset=button(referenceRow,inpaintText("Не использовать образец"),()=>{referenceDonor=null;referenceOriginal=referenceFile='';referenceRegion=null;regionDirty=false;selectedReference='';referenceMode='Выкл';pickingDonor=false;updateV4();scheduleRender();});
        help(referenceRow,inpaintText("Образец задаёт модели фактуру и внешний вид через IP-Adapter. Он не копируется буквально. Выберите участок здесь либо загрузите картинку; подключение произойдёт при сохранении правок. Лечащая кисть выбирает свой отдельный образец."));
        const colorRow=element('div',layout,rowStyle);
        const colors=colorControl(colorRow,chosenColor,v=>{chosenColor=v;},()=>{pickingColor=!pickingColor;updateV4();});
        const fill = new Underpaint(data.width, data.height);
        const fillRow = element('div',layout,rowStyle);
        const fillMode = element('select',fillRow);
        fillMode.setAttribute('aria-label',inpaintText("Чем дорисовать"));
        fillMode.add(new Option(inpaintText("Цвет"),'color'));
        fillMode.add(new Option(inpaintText("Текстура рядом"),'texture'));
        let fillColor='#808080', fillDonor=null, fillAnchor=null, fillStroke=null;
        const fillColors=colorControl(fillRow,fillColor,v=>{fillColor=v;},()=>{pickingColor=!pickingColor;updateV4();});
        const fillPick=button(fillRow,inpaintText("Взять образец с изображения"),()=>{pickingColor=true;updateV4();});
        fillMode.onchange=()=>{pickingColor=fillMode.value==='texture'&&!fillDonor;updateV4();};
        const localRow=element('div',layout,rowStyle),localState=element('span',localRow,{fontSize:'12px'});
        const showPaintLabel=element('label',localRow),showPaint=element('input',showPaintLabel);showPaint.type='checkbox';showPaintLabel.append(document.createTextNode(inpaintText(" Показать область ретуши")));showPaint.onchange=scheduleRender;
        const refreshLocal=button(localRow,inpaintText("Обновить предпросмотр"),()=>requestLocalPreview(true));
        if(editor41){
            localRow.dataset.retouchPreview='';
            localState.setAttribute('role','status');
            showPaintLabel.lastChild.textContent=inpaintText(" Показать маску мазков");
            showPaintLabel.title=inpaintText("Цветом отмечены уже применённые мазки выбранного инструмента.");
            refreshLocal.title=inpaintText("Ещё раз рассчитать результат уже применённых мазков.");
        }
        function previewStatus(phase,text){
            if(editor41)localRow.dataset.phase=phase;
            localState.textContent=text;
        }
        const settings = element('div', layout, rowStyle);
        const sizeLabel = element('label', settings); sizeLabel.textContent = inpaintText("Размер кисти ");
        const size = element('input', sizeLabel, {width:'240px', verticalAlign:'middle'});
        size.type = 'range'; size.min = '0'; size.max = '1000'; size.step = '1';
        size.setAttribute('aria-label',inpaintText("Размер кисти — плавно"));
        const exactSize = element('input', settings, {width:'72px', padding:'5px'});
        exactSize.type = 'number'; exactSize.min = '1'; exactSize.max = '250'; exactSize.step = '0.1';
        exactSize.setAttribute('aria-label',inpaintText("Размер кисти в пикселях"));
        const sizeUnits=element('span',settings);sizeUnits.textContent='px';
        let diameter = 45;
        const setDiameter = (value, origin = '') => {
            if (!Number.isFinite(value)) return;
            diameter = Math.round(Math.max(1, Math.min(250, value)) * 10) / 10;
            if (origin !== 'number') exactSize.value = String(diameter);
            if (origin !== 'slider') size.value = String(sliderFromDiameter(diameter));
            size.setAttribute('aria-valuetext', diameter + inpaintText(" пикселей"));
            refreshBrushCursor(); refreshPathPreview();
        };
        size.oninput = () => setDiameter(diameterFromSlider(size.value), 'slider');
        exactSize.oninput = () => {if (exactSize.validity.valid) setDiameter(exactSize.valueAsNumber, 'number');};
        exactSize.onchange = exactSize.onblur = () => {
            const value=exactSize.valueAsNumber;
            if(exactSize.value!==String(diameter))setDiameter(Number.isFinite(value)?value:diameter);
        };
        setDiameter(diameter);
        const backgrounds=element('div',settings,{display:'flex',alignItems:'center',gap:'7px'});
        backgrounds.className='png-v4-backgrounds';
        backgrounds.setAttribute('role','group');backgrounds.setAttribute('aria-label',inpaintText("Фон просмотра"));
        element('span',backgrounds).textContent=inpaintText("Фон просмотра");
        const zoomLabel = element('label', settings, {marginLeft:'auto'}); zoomLabel.textContent = inpaintText("Масштаб ");
        const zoom = element('select', zoomLabel, {padding:'5px'}); zoom.setAttribute('aria-label',inpaintText("Масштаб маски"));
        for (const [value, text] of [[1,inpaintText("Вписать")],[1.5,'150%'],[2,'200%'],[3,'300%'],[4,'400%'],[8,'800%']]) {
            const option = element('option', zoom); option.value = value; option.textContent = text;
        }
        const customZoom = element('option', zoom); customZoom.value = 'custom'; customZoom.hidden = true;
        const workspace=element('div',layout,{display:'flex',flex:'1',minHeight:'120px',gap:'12px'});
        workspace.className='reference-workspace';
        element('style',modal).textContent='.png-v4-mask-editor.reference-focus .reference-layout > :not(.reference-workspace):not(.reference-footer){display:none!important}';
        layout.className='reference-layout';
        const area = element('div', workspace, {position:'relative', flex:'1', minWidth:'0', minHeight:'120px', overflow:'scroll', background:'#333', touchAction:'none'});
        function activateFile() {
            selectedReference='file';referenceMode='Загруженный образец';referenceDonor=null;pickingDonor=false;
            updateV4();scheduleRender();
        }
        const referenceEditor=installReferenceRegion(workspace,{
            apiURL:url=>api.apiURL(url),
            locked:()=>saving||referenceUploading,
            expand:full=>{modal.classList.toggle('reference-focus',full);area.style.display=full?'none':'';requestAnimationFrame(()=>refit());},
            change:region=>{referenceRegion=region;regionDirty=!!region;if(!region)referenceFile=referenceOriginal;activateFile();}
        });
        const useReferenceButton=button(referenceEditor.root,inpaintText("Использовать эту картинку"),activateFile);
        area.setAttribute('aria-label',inpaintText("Область изображения"));
        const stage = element('div', area, {width:'max-content'});
        const imageFrame=element('div',stage,{position:'relative',width:'max-content',backgroundSize:'20px 20px'});
        const canvas = element('canvas', imageFrame, {display:'block', touchAction:'none', cursor:'crosshair',background:'transparent'});
        const checkerboard='repeating-conic-gradient(#999 0% 25%, #777 25% 50%)';
        let activeBackground=null;
        function selectBackground(swatch,color,pattern){
            activeBackground?.setAttribute('aria-pressed','false');
            swatch.setAttribute('aria-pressed','true');activeBackground=swatch;
            imageFrame.style.backgroundColor=color;
            imageFrame.style.backgroundImage=pattern;
        }
        for(const [name,color,pattern='none'] of [
            [inpaintText("Шахматка"),'#858585',checkerboard],[inpaintText("Белый"),'#ffffff'],[inpaintText("Чёрный"),'#000000'],
            [inpaintText("Серый"),'#808080'],[inpaintText("Ярко-розовый"),'#ff1493']
        ]){
            const swatch=button(backgrounds,'',()=>selectBackground(swatch,color,pattern),{
                width:'25px',height:'25px',padding:'0',backgroundColor:color,backgroundImage:pattern,
                backgroundSize:'10px 10px',borderColor:'#99a2ab'
            });
            swatch.title=name;swatch.setAttribute('aria-label',name);swatch.setAttribute('aria-pressed','false');
            if(!activeBackground)selectBackground(swatch,color,pattern);
        }
        canvas.width = data.width; canvas.height = data.height; canvas.setAttribute('aria-label',inpaintText("Холст маски правки"));
        canvas.tabIndex=0;
        const pathPreview=element('canvas',imageFrame,{position:'absolute',left:'0',top:'0',width:'100%',height:'100%',pointerEvents:'none'});
        pathPreview.width=data.width;pathPreview.height=data.height;pathPreview.setAttribute('aria-hidden','true');
        pathPreview.setAttribute('data-path-preview','');
        const pathContext=pathPreview.getContext('2d');
        const newCanvas = () => {const c = document.createElement('canvas'); c.width = data.width; c.height = data.height; return c;};
        const mask = newCanvas(), alphaErase = newCanvas(), alphaOpaque = newCanvas(), alphaEdge = newCanvas(), preview = newCanvas(), overlay = newCanvas();
        const strokeCanvas = newCanvas(), guardCanvas = newCanvas(), edgeGuardCanvas = newCanvas();
        const mc = mask.getContext('2d',{willReadFrequently:true});
        const ac = alphaErase.getContext('2d',{willReadFrequently:true});
        const bc = alphaOpaque.getContext('2d',{willReadFrequently:true});
        const ec = alphaEdge.getContext('2d',{willReadFrequently:true});
        const alphaContexts = [ac,bc,ec];
        const egc = edgeGuardCanvas.getContext('2d',{willReadFrequently:true});
        const sc = strokeCanvas.getContext('2d'), gc = guardCanvas.getContext('2d',{willReadFrequently:true});
        const extra={};
        for(const key of ['protect','guide','strength',...localLayers]){
            const canvas=newCanvas(),context=canvas.getContext('2d',{willReadFrequently:true});
            context.fillStyle=key==='strength'?'white':'black';context.fillRect(0,0,data.width,data.height);
            extra[key]={canvas,context};
        }
        const currentContext=()=>extra[layer.value]?.context||mc;
        const lightBrush=editor41?new LightBrush(imageFrame,newCanvas,extra):null;
        const lightTool=()=>editor41 && isLightLayer(layer.value);
        for (const c of [mc, ac, bc, ec]) {c.fillStyle = 'black'; c.fillRect(0,0,data.width,data.height);}
        if (data.opaque_region) {
            const guard = new Image(); guard.src = data.opaque_region; await guard.decode(); gc.drawImage(guard,0,0);
        }
        let allowed = gc.getImageData(0,0,data.width,data.height).data;
        const pc = preview.getContext('2d',{willReadFrequently:true}), oc = overlay.getContext('2d'), ctx = canvas.getContext('2d');
        let original = await readSurface(data.preview), warpPreview=null,warpFill=null,contourPreview=null;
        let dragAlphaMaps=null, warpAlphaPreview=null;
        if (data.edge_alpha_target) {
            const target = new Image(); target.src = data.edge_alpha_target; await target.decode(); egc.drawImage(target,0,0);
        }
        let edgeTargets = egc.getImageData(0,0,data.width,data.height).data;
        const edgeGuard = new ImageData(data.width,data.height);
        for (let i=0;i<edgeGuard.data.length;i+=4) {
            edgeGuard.data[i] = edgeGuard.data[i+1] = edgeGuard.data[i+2] = 255;
            edgeGuard.data[i+3] = edgeTargets[i+3];
        }
        egc.putImageData(edgeGuard,0,0);
        let previous;
        try {previous = JSON.parse(initialPayload || '{}');} catch {}
        let deformations=previous?.source_sha256===data.source_sha256?(previous.deformations||[]):[];
        if (previous?.source_sha256 === data.source_sha256 && previous.width === data.width && previous.height === data.height) {
            for (const [encoded, context] of [[previous.png, mc], [previous.alpha_erase_png, ac], [previous.alpha_opaque_png, bc], [previous.alpha_edge_png, ec],...Object.entries(extra).map(([key,value])=>[previous[key+'_png'],value.context])]) {
                if (!encoded) continue;
                const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode(); context.drawImage(image,0,0);
            }
        }
        if(previous?.source_sha256===data.source_sha256){
            await fill.load(previous.underpaint_png);
            edgeState=previous.edge_pixels?{pixels:previous.edge_pixels}:null;
            donor=previous.donor||null;donorSelected=!!donor&&previous.donor_selected!==false;healAnchor=previous.heal_anchor||null;
            lightAmount.value=previous.light_amount??.25;healAmount.value=previous.heal_amount??1;
            if(lightBrush){
                if(previous.light_strokes&&!data.accumulated_light)throw Error(inpaintText("Для открытия накопленной светотени перезапустите ComfyUI."));
                await lightBrush.load(previous);
                baseLightAmount=Number(lightAmount.value);
                strokeLightAmount=previous.stroke_light_amount??null;
                lightHold.value=previous.light_hold_percent??100;
                lightHold.oninput();
                accumulate.checked=!!(data.accumulated_light&&previous.accumulate_light);
                if(accumulate.checked)lightAmount.value=strokeLightAmount??baseLightAmount;
            }
            edgeAmount.value=previous.edge_finish_amount??.8;smoothEdge.checked=previous.edge_finish_smooth===true;
            donorSize.value=previous.reference_size??previous.donor_size??128;healMode.value=previous.heal_mode||'texture';
            referenceDonor=('reference_donor' in previous?previous.reference_donor:previous.donor)||null;referenceFile=previous.reference_file||'';
            referenceOriginal=previous.reference_original_file||referenceFile;
            referenceRegion=previous.reference_region||null;
            selectedReference=referenceSource({...previous,reference_donor:referenceDonor},value(processor,'reference_mode'));
        }
        for(const input of [lightAmount,healAmount,edgeAmount,donorSize])input.sync();
        accumulate.onchange=()=>{
            if(accumulate.checked)baseLightAmount=Number(lightAmount.value);
            else strokeLightAmount=Number(lightAmount.value);
            lightAmount.value=accumulate.checked?(strokeLightAmount??baseLightAmount):baseLightAmount;
            lightAmount.sync();
        };
        const modeMaps=previous?.source_sha256===data.source_sha256?{...previous.mode_maps}:{};
        if(previous?.source_sha256===data.source_sha256&&previous.editor_mode&&previous.editor_mode!==taskMode){
            modeMaps[previous.editor_mode]={guide:previous.guide_png,strength:previous.strength_png};
            for(const key of ['guide','strength']){const context=extra[key].context;context.fillStyle=key==='strength'?'white':'black';context.fillRect(0,0,data.width,data.height);
                if(modeMaps[taskMode]?.[key]){const saved=new Image();saved.src='data:image/png;base64,'+modeMaps[taskMode][key];await saved.decode();context.drawImage(saved,0,0);}}
        }
        const hint = element('div', layout, {fontSize:'12px', lineHeight:'1.4', color:'#ccd4de', minHeight:'34px'});
        const footer = element('div', layout, {...rowStyle, borderTop:'1px solid #454b53', paddingTop:'12px'});
        footer.className='reference-footer';
        // Clearing is isolated from the commit buttons and remains undoable.
        const clear = button(footer, inpaintText("Очистить маску Inpaint"), () => {
            if(layer.value==='underpaint'){
                snapshot('underpaint');fill.restore(null);localPreview=null;scheduleRender();requestLocalPreview();return;
            }
            if(layer.value==='edge_finish'&&data.edge_strokes){
                snapshot('acceptedEdge');edgeState=null;localPreview=null;scheduleRender();requestLocalPreview();return;
            }
            snapshot(layer.value);
            if(lightTool())delete lightBrush.layers[layer.value];
            const c=currentContext();c.fillStyle=layer.value==='strength'?'white':'black';c.fillRect(0,0,data.width,data.height);if(layer.value==='heal')healAnchor=null;scheduleRender();requestLocalPreview();
        }, {color:'#d0d4da', background:'#292e34'});
        const allMaskKeys=['mask',...Object.keys(extra).filter(key=>key!=='edge_finish')];
        const clearAll=button(footer,inpaintText("Очистить все маски"),()=>{
            snapshot('allMasks');
            if(lightBrush)lightBrush.layers={};
            for(const key of allMaskKeys){
                const c=contextsFor(key)[0];c.fillStyle=key==='strength'?'white':'black';c.fillRect(0,0,data.width,data.height);
            }
            for(const key of Object.keys(modeMaps))delete modeMaps[key];
            healAnchor=null;scheduleRender();requestLocalPreview();updatePathControls();
        },{color:'#d0d4da',background:'#292e34'});
        clearAll.title=inpaintText("Очищает выделения. Доводка края, правки прозрачности, контур и образец сохраняются. Ctrl+Z возвращает маски.");
        const actions = element('div', footer, {...rowStyle, marginLeft:'auto'});
        function mapUsed(key){const pixels=(key==='mask'?mc:extra[key].context).getImageData(0,0,data.width,data.height).data;for(let i=0;i<pixels.length;i+=4)if(key==='strength'?pixels[i]<255:pixels[i]>0)return true;return false;}
        // The other retouch layers stay constant across consecutive light strokes.
        // Keep their encoded PNGs so releasing a brush doesn't re-encode every canvas.
        let lightPreviewContext=null;
        function buildLightPreview(){
            const png=c=>c.toDataURL('image/png').split(',')[1];
            if(!lightPreviewContext)lightPreviewContext={
                source_sha256:data.source_sha256,width:data.width,height:data.height,deformations,
                underpaint_png:fill.encode(),alpha_erase_png:png(alphaErase),alpha_opaque_png:png(alphaOpaque),alpha_edge_png:png(alphaEdge),
                protect_png:png(extra.protect.canvas),heal_png:png(extra.heal.canvas),heal_amount:Number(healAmount.value),
                donor,heal_anchor:healAnchor,heal_mode:healMode.value,heal_edge_sampling:true,light_to_edge:true,
                edge_finish_png:!data.edge_strokes&&mapUsed('edge_finish')?png(extra.edge_finish.canvas):undefined,
                edge_finish_amount:Number(edgeAmount.value),edge_finish_smooth:smoothEdge.checked,
            };
            const layers=lightBrush.serialize();
            return JSON.stringify({...lightPreviewContext,...layers,
                dodge_png:layers.dodge_base_png?undefined:png(extra.dodge.canvas),
                burn_png:layers.burn_base_png?undefined:png(extra.burn.canvas),
                edge_pixels:edgeState?.pixels,light_amount:accumulate.checked?baseLightAmount:Number(lightAmount.value)});
        }
        function buildPayload(includeEdgeDraft=!data.edge_strokes){return JSON.stringify({source_sha256:data.source_sha256,width:data.width,height:data.height,deformations,
            underpaint_png:fill.encode(),
            png:mask.toDataURL('image/png').split(',')[1],alpha_erase_png:alphaErase.toDataURL('image/png').split(',')[1],
            alpha_opaque_png:alphaOpaque.toDataURL('image/png').split(',')[1],alpha_edge_png:alphaEdge.toDataURL('image/png').split(',')[1],
            ...Object.fromEntries(Object.entries(extra).filter(([key])=>key!=='edge_finish'||(includeEdgeDraft&&mapUsed(key))).map(([key,value])=>[key+'_png',value.canvas.toDataURL('image/png').split(',')[1]])),
            edge_pixels:edgeState?.pixels??undefined,edge_finish_amount:Number(edgeAmount.value),edge_finish_smooth:smoothEdge.checked,
            donor,donor_selected:donorSelected,heal_anchor:healAnchor,light_amount:accumulate.checked?baseLightAmount:Number(lightAmount.value),heal_amount:Number(healAmount.value),
            ...(lightBrush?{...lightBrush.serialize(),accumulate_light:accumulate.checked,light_hold_percent:Number(lightHold.value),
                stroke_light_amount:accumulate.checked?Number(lightAmount.value):strokeLightAmount}:{}),
            heal_edge_sampling:editor41||undefined,
            light_to_edge:editor41||undefined,
            donor_size:128,heal_mode:healMode.value,reference_donor:referenceDonor,reference_file:referenceFile,reference_original_file:referenceOriginal,reference_region:referenceRegion,reference_source:selectedReference,reference_size:Number(donorSize.value),
            ui_language:language,editor_mode:taskMode,mode_maps:modeMaps,map_usage:{guide:mapUsed('guide'),strength:mapUsed('strength'),mask:mapUsed('mask')}});}
        const saveButton = button(actions, inpaintText("Сохранить правки"), async () => {
            if (saving || referenceUploading || referenceEditor.busy || drawing || curve.points.length || smartWarp?.busy || smartWarp?.pending) return;
            if(fill.pixels&&!data.underpaint){alert(inpaintText("Для сохранения дорисовки перезапустите ComfyUI и обновите страницу."));return;}
            if((!data.edge_finish&&mapUsed('edge_finish'))||(!data.edge_strokes&&edgeState)){alert(inpaintText("Для доводки края сохраните работу и перезапустите ComfyUI."));return;}
            if(referenceEditor.unfinished){alert(inpaintText("Сначала нажмите «Замкнуть контур»."));return;}
            if(referenceMode==='Загруженный образец'&&!processor?.widgets?.find(w=>w.name==='reference_mode')?.options?.values?.includes(referenceMode)){
                alert(inpaintText("ComfyUI ещё использует старую версию нод. Перезапустите ComfyUI и обновите страницу: загруженный образец требует новой версии сервера."));return;
            }
            if (source.value !== selected || maskWidget.value !== initialPayload) {
                alert(inpaintText("Исходник или маска изменились. Закройте редактор и откройте его заново.")); return;
            }
            const pixels = mc.getImageData(0,0,data.width,data.height).data;
            let hasGenerationMask = false;
            for (let i=0;i<pixels.length;i+=4) {if (pixels[i]) {hasGenerationMask=true;break;}}
            if (!hasGenerationMask && section.value==='generation' && !recolor && (mapUsed('guide') || mapUsed('strength'))) {
                action.value='mask';method.value='brush';routeAction();
                stateHint.textContent=inpaintText("Линия и локальная сила сохранены в редакторе. Теперь красной кистью выделите, где модель должна изменить изображение, затем сохраните правки.");
                return;
            }
            const controls = [...modal.querySelectorAll('button,input,select')].filter(el=>el!==cancelButton).map(el=>[el,el.disabled]);
            try {
                saving = true; controls.forEach(([el])=>{el.disabled=true;}); refreshBrushCursor();
                if(regionDirty){
                    saveButton.textContent=inpaintText("Сохраняю фрагмент…");
                    referenceAbort=new AbortController();
                    const blob=await referenceEditor.blob();
                    const file=await uploadReference(blob,inpaintText("Образец.png"),'/Regions',referenceAbort.signal);
                    if(!modal.isConnected)return;
                    referenceFile=file;regionDirty=false;
                }
                await resolveEdge(edgeState);
                if(!modal.isConnected)return;
                const payload = buildPayload();
                let publish;
                if (!hasGenerationMask) {
                    saveButton.textContent = inpaintText("Обновляю PNG…");
                    const {prepareAlphaResult} = await import('./iteration.js');
                    publish = await prepareAlphaResult(node,payload);
                }
                if (!modal.isConnected) return; // Cancel/Escape during the request discards the pending edit.
                if (source.value !== selected || maskWidget.value !== initialPayload) {
                    throw new Error(inpaintText("Исходник или маска изменились. Новые данные сохранены; откройте редактор заново."));
                }
                node.graph?.beforeChange?.();
                try {
                    maskWidget.value = payload; node._alphaMaskSource = selected;
                    if(processor){
                        const usage=JSON.parse(payload).map_usage;
                        if(!recolor&&usage.guide&&value(processor,'guide_control')==='Выкл')setValue(processor,'guide_control','Рисунок + контекст');
                        if(!recolor&&usage.strength)setValue(processor,'differential',true);
                        if(referenceMode!==null&&!recolor)setValue(processor,'reference_mode',referenceMode);
                        if(recolor)setValue(processor,'target_color',chosenColor);
                        processor._v4Refresh?.();
                    }
                    publish?.(); node.setDirtyCanvas(true,true); node.graph?.change?.();
                } finally {node.graph?.afterChange?.();}
                modal.close();
            } catch (error) {
                if (modal.isConnected) {hint.textContent = error.message; hint.style.color = '#ffb3b3';}
            } finally {
                saving = false; controls.forEach(([el,disabled])=>{el.disabled=disabled;});
                saveButton.textContent = inpaintText("Сохранить правки"); refreshBrushCursor();
            }
        }, {background:'#247344', borderColor:'#4caa70', fontWeight:'600'});
        const cancelButton = button(actions, inpaintText("Отмена"), () => modal.close(), {background:'#793e45', borderColor:'#ac626b'});

        const undo = [];
        // An alpha stroke changes all three maps and must be undone atomically.
        const undoLimit = Math.max(1,Math.min(12,Math.floor(128*1024*1024/(data.width*data.height*12))));
        let drawing = false, last = null, drawPointer = null, stabilizer = null, lineDraft = null, curveDrag = -1, curveOffset=[0,0],curveBend=null;
        let curve=new ElasticCurve(), brushExtension=null;
        const curvePoints=()=>curve.sample();
        const curveTypes={curve:ElasticCurve,elastic:CircularArcCurve,oval:OvalArcCurve};
        const isCurve=()=>Object.hasOwn(curveTypes,pathMode.value);
        const isPanning = installMiddlePan(area,canvas,()=>drawing || saving || smartWarp?.busy);
        refreshBrushCursor = installBrushCursor(area,canvas,{diameter:()=>smartWarp?.mode==='warp'?smartWarp.diameter:diameter, hidden:()=>saving || pickingColor || action.value==='reference' || isPanning() || ['smart','segment'].includes(smartWarp?.mode),
            position:()=>{
                if(!drawing||pathMode.value!=='smooth'||!stabilizer)return null;
                const r=canvas.getBoundingClientRect();return {x:r.left+stabilizer.point[0]*r.width/data.width,y:r.top+stabilizer.point[1]*r.height/data.height};
            },
            color:()=>layer.value==='alpha' ? (editingEdge?'#8bd8ff':makingOpaque?'#ffd884':erasing?'#8ce6ae':'#ffb3b3') : (erasing?'#ffb3b3':'#fff')});
        function contextsFor(which) {
            if(which==='allMasks')return allMaskKeys.map(key=>key==='mask'?mc:extra[key].context);
            if(which==='donor')return [];
            return which === 'alpha' ? [ac,bc,ec] : [extra[which]?.context||mc];}
        function rebuildGuards(){
            gc.putImageData(new ImageData(new Uint8ClampedArray(allowed),data.width,data.height),0,0);
            const pixels=new ImageData(data.width,data.height);
            for(let i=0;i<pixels.data.length;i+=4){pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=255;pixels.data[i+3]=edgeTargets[i+3];}
            egc.putImageData(pixels,0,0);
        }
        async function decodePreview(url){
            const image=new Image();image.src=url;await image.decode();const c=newCanvas(),context=c.getContext('2d');
            context.drawImage(image,0,0);return context.getImageData(0,0,data.width,data.height);
        }
        // An unsaved eraser cut is an editable grayscale map. Move those edits
        // with a free-edge stroke so the old cut can't clip the new silhouette.
        function captureWarpAlpha(op){
            // Both the sampling footprint and its destination lie within 1.45 radii of the grab.
            const margin=Math.ceil(op.radius*1.45)+2;
            const x=Math.max(0,Math.floor(op.from[0])-margin),y=Math.max(0,Math.floor(op.from[1])-margin);
            const w=Math.min(data.width,Math.ceil(op.from[0])+margin+1)-x;
            const h=Math.min(data.height,Math.ceil(op.from[1])+margin+1)-y;
            const maps=[];
            for(const context of alphaContexts){
                const before=context.getImageData(x,y,w,h);
                for(let i=0;i<before.data.length;i+=4){
                    if(before.data[i]){maps.push({context,before});break;}
                }
            }
            return {x,y,w,h,maps,protect:maps.length?extra.protect.context.getImageData(x,y,w,h).data:null};
        }
        function shiftWarpAlpha(captured,op){
            const {x,y,w,h,maps,protect}=captured;
            const local={...op,from:[op.from[0]-x,op.from[1]-y],to:[op.to[0]-x,op.to[1]-y]};
            return maps.map(({context,before})=>({context,x,y,before,
                after:new ImageData(warpRGBA(before.data,w,h,local,protect),w,h)}));
        }
        async function commitWarp(op){
            if(deformations.length>=128)throw new Error(inpaintText("Сохраните правки и продолжите редактирование: достигнут лимит 128 сдвигов."));
            const protect=extra.protect.context.getImageData(0,0,data.width,data.height).data;
            if(protect.some((v,i)=>i%4===0&&v>0))op.protect_png=extra.protect.canvas.toDataURL('image/png').split(',')[1];
            const operations=[...deformations,op];
            const response=await api.fetchApi('/png-inpaint-v4/source-preview',{method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({image:selected,source_sha256:data.source_sha256,deformations:operations})});
            const result=await response.json();if(!response.ok)throw new Error(result.error||inpaintText("Не удалось применить деформацию"));
            const [base,guard,edge]=await Promise.all([readSurface(result.preview),decodePreview(result.opaque_region),decodePreview(result.edge_alpha_target)]);
            if(!modal.isConnected)return;
            const alphaPatches=op.mode==='free_edge'?shiftWarpAlpha(captureWarpAlpha(op),op):[];
            snapshot('geometry',alphaPatches.map(({context,x,y,before})=>({context,x,y,before})));
            for(const {context,x,y,after} of alphaPatches)context.putImageData(after,x,y);
            if(fill.pixels)fill.restore(warpRGBA(fill.pixels,data.width,data.height,op,protect));
            original=base;allowed=guard.data;edgeTargets=edge.data;deformations=operations;localPreview=null;rebuildGuards();scheduleRender();requestLocalPreview();
        }
        function updateTools() {
            brush.textContent = layer.value === 'alpha' ? inpaintText("Ластик прозрачности") : inpaintText("Кисть");
            eraser.textContent = layer.value === 'alpha' ? inpaintText("Восстановить") : inpaintText("Ластик маски");
            opaqueButton.style.display = layer.value === 'alpha' ? '' : 'none';
            edgeButton.style.display = layer.value === 'alpha' ? '' : 'none';
            for (const [b, active] of [[brush,!erasing&&!makingOpaque&&!editingEdge],[eraser,erasing],[opaqueButton,makingOpaque],[edgeButton,editingEdge]]) {
                b.setAttribute('aria-pressed',String(active)); b.style.background = active ? '#41647a' : '#353b43';
                b.style.borderColor = active ? '#88b9d8' : '#707780';
            }
            clear.style.visibility = layer.value === 'alpha' ? 'hidden' : 'visible';
            clear.textContent=layer.value==='mask'?inpaintText("Очистить маску Inpaint"):layer.value==='edge_finish'?inpaintText("Сбросить доводку края"):inpaintText("Очистить текущий слой");
            if(layer.value==='underpaint'){clear.textContent=inpaintText("Очистить дорисовку");eraser.textContent=inpaintText("Ластик дорисовки");}
            showPaintLabel.style.display=layer.value==='edge_finish'?'none':'';
            if(layer.value==='edge_finish')eraser.textContent=inpaintText("Ластик доводки");
            for(const [input,show] of [[brushStrength,layer.value==='strength'],[lightAmount,['dodge','burn'].includes(layer.value)],
                [healAmount,layer.value==='heal'],[edgeAmount,layer.value==='edge_finish'],[donorSize,action.value==='reference'&&(selectedReference!=='file'||pickingDonor)]])input.parentElement.style.display=show?'':'none';
            smoothEdgeLabel.style.display=layer.value==='edge_finish'?'':'none';
            accumulateLabel.style.display=lightTool()?'':'none';
            healMode.style.display=donorButton.style.display=resetDonor.style.display=layer.value==='heal'?'':'none';
            donorButton.textContent=pickingDonor?inpaintText("Кликните чистый участок (отменить)"):donorSelected?inpaintText("Выбрать другой чистый участок"):inpaintText("1. Выбрать чистый участок");
            resetDonor.disabled=!donorSelected;
            advancedRow.style.display=(layer.value==='strength'||localLayers.includes(layer.value))||action.value==='reference'?'flex':'none';
            referenceRow.style.display=action.value==='reference'?'flex':'none';
            colorRow.style.display=recolor&&section.value==='generation'?'flex':'none';
            fillRow.style.display=layer.value==='underpaint'?'flex':'none';
            fillColors.row.style.display=fillMode.value==='color'?'flex':'none';
            fillPick.hidden=fillMode.value!=='texture';
            fillPick.textContent=pickingColor?inpaintText("Кликните по образцу"):fillDonor?inpaintText("Выбрать другой образец"):inpaintText("Взять образец с изображения");
            localRow.style.display=localLayers.includes(layer.value)?'flex':'none';
            hint.style.color = '#ccd4de'; refreshBrushCursor();
            hint.textContent = (layer.value === 'alpha'
                ? (editingEdge
                    ? inpaintText("«Правка у края»: фон без альфы и внешний ряд сглаживания сохраняются; непрозрачность повышается внутрь контура. Закрашивайте тело: широкое свечение уже входит в альфу PNG и тоже может усилиться под кистью.")
                    : makingOpaque
                    ? inpaintText("«Сделать непрозрачным» убирает полупрозрачность внутри персонажа. Край, фон и полностью прозрачные пиксели защищены. Для перерисовки затем выделите это место в слое «Маска Inpaint».")
                    : inpaintText("Шахматка — прозрачность. Ластик скрывает; «Восстановить» возвращает исходную альфу. «Сделать непрозрачным» убирает полупрозрачность внутри персонажа."))
                : extending ? inpaintText("После генерации V4 вырежет предмет по его силуэту внутри красного выделения.")
                : inpaintText("Красное — область генерации. Эта кисть не меняет прозрачность. Для удаления выступа выберите слой «Прозрачность PNG»."))
                + inpaintText(" Колёсико — масштаб; зажатое колёсико — перемещение. При пустой маске Inpaint «Сохранить правки» сразу обновляет PNG.");
        }
        const v4Hints={protect:inpaintText("Зелёное — строгая защита деталей: их пиксели сохраняются даже внутри красной маски."),
            guide:inpaintText("Голубая линия — направление складки или шва для ControlNet. Ещё выделите область в «Маска Inpaint» и кратко опишите материал."),
            strength:inpaintText("Закрасьте нужную часть красного выделения. 0 — сохранить, 1 — полная сила режима. Обработка локальной силы включится автоматически."),
            dodge:inpaintText("Мягкое осветление без генерации. С пустой маской Inpaint «Сохранить правки» сразу показывает результат."),
            burn:inpaintText("Мягкое затемнение без генерации: можно подчеркнуть существующую складку. Изменение ограничено кистью."),
            edge_finish:inpaintText("Проведите кистью вдоль обрезанного края, захватив часть поверхности и прозрачного фона. Цвет берётся с поверхности, светотень — с соседних участков края."),
            heal:inpaintText("1. Выберите чистый участок (или Alt+клик). 2. Закрасьте дефект кистью. 3. Посмотрите предпросмотр и сохраните. Новый образец заменяет текущую ретушь; Ctrl+Z возвращает её.")};
        if(editor41){
            v4Hints.dodge=v4Hints.burn=inpaintText("Край кисти даёт мягкий свет или тень. Отпустите кнопку, чтобы увидеть результат. С накоплением каждый новый мазок усиливает пересечение.");
            v4Hints.heal=inpaintText("Alt+клик по чистой фактуре, затем закрасьте дефект. Образец можно брать с самого края. Полупрозрачные пиксели переносятся слабее, пустые пропускаются. Новый образец заменяет текущую ретушь. Ctrl+Z возвращает её.");
        }
        const baseUpdate=updateTools;
        function updateV4(){
            method.options[1].disabled=layer.value==='heal'&&!donorSelected;
            baseUpdate();if(v4Hints[layer.value])hint.textContent=v4Hints[layer.value]+inpaintText(" Колесо: масштаб; зажатое колесо: перемещение.");
            const tips={smooth:inpaintText(" Плавная кисть: выше стабилизация — ровнее линия и больше отставание кольца от мыши."),
                line:inpaintText(" Прямая: зажмите левую кнопку в начале и отпустите в конце. До отпускания виден только предпросмотр."),
                curve:inpaintText(" Добавьте точки кликами. Тяните линию между точками для локальных изгибов и S-формы. «Применить кривую» наносит весь штрих. Delete — убрать точку; Ctrl+Z — отменить; Esc — сбросить предпросмотр.")};
            hint.textContent+=tips[pathMode.value]||'';
            if(smartWarp&&smartWarp.mode!=='brush')hint.textContent=smartWarp.hint()+inpaintText(" Колесо — масштаб; зажатое колесо — перемещение.");
            if(pathMode.value==='elastic'&&smartWarp?.mode==='brush')hint.textContent+=inpaintText(" Поставьте две точки и потяните линию в сторону. Вся дуга закруглится от точки до точки, вплоть до полукруга. Следующая точка начинает новую дугу.");
            if(pathMode.value==='oval'&&smartWarp?.mode==='brush')hint.textContent+=inpaintText(" Поставьте два конца. Потяните между ними там, где нужна вершина дуги. Чем дальше от исходной линии, тем выше дуга.");
            stateHint.textContent=section.value==='manual'?inpaintText("Ручная правка без генерации. После сохранения при пустом красном выделении PNG обновится сразу."):recolor?inpaintText("Красное — где перекрасить. Выберите цвет палитрой или пипеткой."):inpaintText("Красное — где модель может рисовать. Прозрачность и остальные части изображения сохраняются.");
            if(extending && section.value==='generation' && action.value==='mask')stateHint.textContent=extensionHint;
            if(layer.value==='guide')stateHint.textContent=inpaintText("Направляющая подключится автоматически. Нужны: красная область правки + голубая линия внутри неё + описание складки или шва.");
            if(layer.value==='strength')stateHint.textContent=inpaintText("Локальная сила подключится автоматически. Фиолетовый слой уточняет силу только внутри красной области и сам ничего не выделяет.");
            if(layer.value==='edge_finish')stateHint.textContent=data.edge_strokes?inpaintText("Каждый проход усиливает доводку. Сила и сглаживание действуют на следующий штрих. Ctrl+Z отменяет последний проход."):inpaintText("Для накопительных штрихов сохраните работу, перезапустите ComfyUI и обновите страницу.");
            if(layer.value==='heal')stateHint.textContent=pickingDonor?inpaintText("Выбор образца: кликните по чистой поверхности."):donorSelected?inpaintText("Образец выбран. Теперь закрасьте дефект — результат появится после штриха."):inpaintText("Сначала выберите чистый участок рядом с дефектом.");
            const fileReference=action.value==='reference'&&!!referenceOriginal;
            const effectiveReferenceMode=referenceMode??value(processor,'reference_mode');
            modal.style.width=fileReference?'94vw':'min(1180px,94vw)';
            referenceEditor.update(referenceOriginal,referenceRegion,fileReference);
            useReferenceButton.style.display=effectiveReferenceMode==='Загруженный образец'?'none':'';
            useReferenceButton.disabled=referenceUploading;
            referenceUpload.textContent=referenceUploading?inpaintText("Загружаю образец…"):inpaintText("Загрузить картинку образца");
            sampleButton.textContent=pickingDonor?inpaintText("Отменить выбор на персонаже"):inpaintText("Выбрать на персонаже");
            if(action.value==='reference'){
                stateHint.textContent=referenceUploading?inpaintText("Загружаю картинку…"):pickingDonor?inpaintText("Кликните центр образца на персонаже слева."):fileReference&&selectedReference==='file'?inpaintText("На образце выберите участок с нужной фактурой."):referenceDonor?inpaintText("Жёлтый квадрат на персонаже — текущий образец."):inpaintText("Выберите участок на персонаже или загрузите картинку образца.");
                hint.textContent=fileReference?inpaintText("«Сохранить правки» передаст выбранный образец в настройки. Красная маска на персонаже определяет, где менять изображение."):inpaintText("Клик выбирает центр образца. Размер квадрата меняется ползунком.");
            }
            if(pickingColor){stateHint.textContent=inpaintText("Пипетка: кликните нужный цвет на самом изображении. Шахматка и цветные маски не попадут в образец.");}
            if(layer.value==='underpaint'){
                const clone=fillMode.value==='texture';
                stateHint.textContent=pickingColor?(clone?inpaintText("Кликните по чистому участку, откуда взять текстуру."):inpaintText("Кликните по изображению, чтобы взять цвет.")) :
                    clone&&!fillDonor?inpaintText("Выберите образец на видимой поверхности, затем закрасьте пропуск."):inpaintText("Закрасьте прозрачный участок. Полностью непрозрачные пиксели сохранятся.");
                hint.textContent=inpaintText("Alt+клик берёт новый образец. Чтобы доработать результат моделью, переключитесь на «Область генерации» и закрасьте заплатку красной маской.");
                if(!data.underpaint)stateHint.textContent=inpaintText("Для дорисовки перезапустите ComfyUI и обновите страницу.");
            }
        }
        layer.onchange = () => {erasing = false; makingOpaque = false; editingEdge = false; pickingDonor=false;updateV4(); scheduleRender();};
        pathMode.onchange=()=>{curve.clear();const CurveType=curveTypes[pathMode.value]||ElasticCurve;curve=new CurveType();pickingDonor=false;updateV4();refreshPathPreview();};
        const generationActions=[['mask',extending?inpaintText("Место крепления и новый предмет"):recolor?inpaintText("Где перекрасить"):inpaintText("Где изменить изображение")],['protect',inpaintText("Защитить детали")],...(!recolor?[['guide',inpaintText("Задать складку / шов")],['strength',inpaintText("Ослабить генерацию в отдельных местах")],['reference',inpaintText("Использовать образец внешнего вида")]]:[])];
        const manualActions=[['alpha',inpaintText("Прозрачность PNG")],['segment',inpaintText("Выровнять контур A—B")],['edge_finish',inpaintText("Доработать край")],['warp',inpaintText("Локальная деформация")],['dodge',inpaintText("Осветлить")],['burn',inpaintText("Затемнить")],['heal',inpaintText("Убрать дефект по образцу")],['protect',inpaintText("Защитить детали")]];
        manualActions.splice(1,0,['underpaint',inpaintText("Дорисовать по прозрачности")]);
        function fillActions(){
            const options=section.value==='manual'?manualActions:generationActions;
            action.replaceChildren();for(const[v,t]of options){const o=element('option',action);o.value=v;o.textContent=t;}
        }
        function routeAction(){
            const v=action.value;layer.value=['segment','warp'].includes(v)?'alpha':v==='reference'?'mask':v;
            if(v==='heal'&&!donorSelected)method.value='brush';
            if(v==='underpaint')method.value='brush';
            const external=['segment','warp'].includes(v);method.style.display=external||v==='reference'||v==='underpaint'?'none':'';
            smartWarp?.setMode(external?v:v==='reference'?'brush':method.value);
            erasing=makingOpaque=editingEdge=pickingDonor=false;pickingColor=false;
            updateV4();scheduleRender();refreshPathPreview();
            requestAnimationFrame(()=>refit());
            if(localLayers.includes(v))requestLocalPreview();
        }
        section.onchange=()=>{method.value='brush';fillActions();routeAction();};action.onchange=routeAction;method.onchange=routeAction;
        fillActions();
        async function displayLocal(result,revision){
            if(revision!==localRevision||!modal.isConnected)return;
            const pixels=await readSurface(result.preview);
            if(revision!==localRevision||!modal.isConnected)return;
            localPreview=pixels;
            const unchanged=layer.value==='edge_finish'&&result.edge_finish_pixels===0;
            previewStatus(unchanged?'notice':'ready',unchanged
                ? inpaintText("Край без изменений. Захватите кистью границу силуэта и проверьте силу доводки.")
                : editor41?inpaintText("Предпросмотр готов"):inpaintText("Предпросмотр готов · без генерации"));
            scheduleRender();
        }
        // Capture settings and layer context at pointer-up. Undo can return to a
        // pending parent even when several strokes arrive before the first reply.
        function resolveEdge(state,onResult){
            if(!state?.draft)return Promise.resolve(state?.pixels??null);
            if(!state.running){
                state.running=(async()=>{
                    const previousPixels=await resolveEdge(state.parent);
                    const body={...state.draft,edge_pixels:previousPixels};
                    const response=await api.fetchApi('/png-inpaint-v4/local-preview',{method:'POST',
                        headers:{'Content-Type':'application/json'},signal:edgeAbort.signal,
                        body:JSON.stringify({image:selected,mask_data:JSON.stringify(body),commit_edge:true,erase_edge:state.erase})});
                    const result=await response.json();
                    if(!response.ok||!('edge_pixels' in result))throw new Error(result.error||inpaintText("Не удалось применить штрих доводки."));
                    state.pixels=result.edge_pixels;state.draft=null;state.parent=null;
                    if(onResult)await onResult(result);
                    return state.pixels;
                })().finally(()=>{state.running=null;});
            }
            return state.running;
        }
        function commitEdgeStroke(erase=false,migrate=false){
            if(!data.edge_strokes||!mapUsed('edge_finish'))return;
            const draft=JSON.parse(buildPayload(true));
            delete draft.edge_pixels;
            if(!migrate)snapshot('acceptedEdge');
            const state={parent:edgeState,draft,erase};
            edgeState=state;
            const c=extra.edge_finish.context;c.fillStyle='black';c.fillRect(0,0,data.width,data.height);
            const revision=++localRevision;clearTimeout(localTimer);localAbort?.abort();
            previewStatus('busy',inpaintText("Применяю штрих…"));scheduleRender();
            resolveEdge(state,result=>displayLocal(result,revision)).catch(error=>{
                if(revision===localRevision&&modal.isConnected)previewStatus('error',error.message+inpaintText(" Нажмите «Обновить предпросмотр», чтобы повторить."));
            });
        }
        async function requestLocalPreview(immediate=false,lightOnly=false){
            if(!lightOnly)lightPreviewContext=null;
            if(!data.local_preview || (drawing&&lightTool()))return;
            const revision=++localRevision;clearTimeout(localTimer);localAbort?.abort();
            const activeMap=editor41&&localLayers.includes(layer.value)?mapUsed(layer.value):false;
            if(editor41)localRow.dataset.layerPainted=String(activeMap);
            if(!edgeState&&!activeMap&&!localLayers.some(key=>(!editor41||key!==layer.value)&&mapUsed(key))){localPreview=null;previewStatus('empty',inpaintText("Штрихов ретуши пока нет"));scheduleRender();return;}
            if(!data.edge_finish&&mapUsed('edge_finish')){localPreview=null;previewStatus('notice',inpaintText("Требуется перезапуск ComfyUI"));scheduleRender();return;}
            previewStatus('busy',inpaintText("Обновляю предпросмотр…"));
            localTimer=setTimeout(async()=>{const controller=new AbortController();localAbort=controller;
                try{await resolveEdge(edgeState);
                    if(revision!==localRevision||!modal.isConnected)return;
                    const response=await api.fetchApi('/png-inpaint-v4/local-preview',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({image:selected,mask_data:lightOnly?buildLightPreview():buildPayload()})});
                    const result=await response.json();if(!response.ok)throw new Error(result.error||inpaintText("Не удалось обновить предпросмотр"));
                    await displayLocal(result,revision);
                }catch(error){if(error.name!=='AbortError'&&revision===localRevision){localPreview=null;previewStatus('error',error.message);scheduleRender();}}
            },immediate?0:160);
        }
        for(const input of[lightAmount,healAmount]){const previousInput=input.oninput;input.oninput=()=>{if(previousInput()&&(input!==lightAmount||!accumulate.checked))requestLocalPreview();};}
        healMode.onchange=()=>requestLocalPreview();
        function currentAlphaImage(base=original,cut=null){
            const planes = alphaContexts.map(c=>c.getImageData(0,0,data.width,data.height).data);
            if(base===warpPreview && warpAlphaPreview){
                for(const {context,x,y,after} of warpAlphaPreview){
                    const dst=planes[alphaContexts.indexOf(context)],stride=after.width*4;
                    for(let row=0;row<after.height;row++)
                        dst.set(after.data.subarray(row*stride,(row+1)*stride),4*((y+row)*data.width+x));
                }
            }
            const [erased,opaque,edge]=planes;
            const image = new ImageData(new Uint8ClampedArray(base.data),data.width,data.height);
            for (let i=0;i<image.data.length;i+=4) image.data[i+3] = alphaAfterEdits(base.data[i+3],cut?combineErasure(erased[i],cut.data[i]):erased[i],allowed[i+3]&&base.data[i+3]?opaque[i]:0,
                base.data[i+3]?edge[i]:0,Math.max(base.data[i+3],edgeTargets[i]));
            return fill.composite(image,cut,base===warpPreview?warpFill:fill.pixels);
        }
        function render() {
            frame = 0;
            if(drawing&&lightTool())return;
            const image=currentAlphaImage(warpPreview||original,contourPreview);
            if(localPreview&&!warpPreview)for(let i=0;i<image.data.length;i+=4){image.data[i]=localPreview.data[i];image.data[i+1]=localPreview.data[i+1];image.data[i+2]=localPreview.data[i+2];
                if(!contourPreview&&!(drawing&&layer.value==='alpha'))image.data[i+3]=Math.min(image.data[i+3],localPreview.data[i+3]);}
            pc.putImageData(image,0,0); ctx.clearRect(0,0,data.width,data.height); ctx.drawImage(preview,0,0);
            if (section.value==='generation'&&action.value!=='reference'&&!pickingColor) {
                const selectedPixels = mc.getImageData(0,0,data.width,data.height);
                for (let i=0;i<selectedPixels.data.length;i+=4) {
                    const v = selectedPixels.data[i]; selectedPixels.data[i]=255; selectedPixels.data[i+1]=55;
                    selectedPixels.data[i+2]=35; selectedPixels.data[i+3]=Math.round(v*.48);
                }
                oc.putImageData(selectedPixels,0,0); ctx.drawImage(overlay,0,0);
            }
            const colors={protect:[68,230,120],guide:[50,210,255],strength:[130,130,255],dodge:[255,220,70],burn:[170,90,210],heal:[245,160,40],edge_finish:[45,210,190]};
            for(const [key,value] of Object.entries(extra)){
                if(key!==layer.value && !['protect','guide'].includes(key))continue;
                if(layer.value==='alpha'||action.value==='reference'||pickingColor)continue;
                if(section.value==='manual'&&(key!==layer.value||(!showPaint.checked&&!(drawing&&key==='edge_finish'))))continue;
                const pixels=value.context.getImageData(0,0,data.width,data.height),color=colors[key];
                for(let i=0;i<pixels.data.length;i+=4){const v=key==='strength'?255-pixels.data[i]:pixels.data[i];
                    pixels.data[i]=color[0];pixels.data[i+1]=color[1];pixels.data[i+2]=color[2];pixels.data[i+3]=Math.round(v*(key==='guide'?.85:.45));}
                oc.putImageData(pixels,0,0);ctx.drawImage(overlay,0,0);
            }
            const marker=layer.value==='underpaint'&&fillMode.value==='texture'?fillDonor:layer.value==='heal'&&donorSelected?donor:null;
            if(marker){
                ctx.save();ctx.strokeStyle='#ffd884';ctx.lineWidth=2;ctx.beginPath();
                ctx.moveTo(marker[0]-10,marker[1]);ctx.lineTo(marker[0]+10,marker[1]);
                ctx.moveTo(marker[0],marker[1]-10);ctx.lineTo(marker[0],marker[1]+10);ctx.stroke();
                ctx.restore();
            }
            if(selectedReference==='crop'&&referenceDonor&&action.value==='reference'){ctx.save();ctx.strokeStyle='#ffd884';ctx.lineWidth=2;const side=Number(donorSize.value);ctx.strokeRect(referenceDonor[0]-side/2,referenceDonor[1]-side/2,side,side);ctx.restore();}
        }
        const donorSizeInput=donorSize.oninput;donorSize.oninput=()=>{if(donorSizeInput())scheduleRender();};
        function scheduleRender() {if (!frame) frame = requestAnimationFrame(render);}
        function snapshotStroke() {
            const restore = brushExtension?.beginStroke();
            if (!restore) return snapshot(layer.value);
            if (undo.length >= undoLimit) undo.shift();
            undo.push({restore});
            undoButton.disabled = false;
        }
        function snapshot(which,alphaPatches) {
            if(which==='edge_finish'&&data.edge_strokes)return;
            if (undo.length >= undoLimit) undo.shift();
            if(which==='acceptedEdge')undo.push({which,edgeState});
            else if(which==='geometry')undo.push({which,original,allowed,edgeTargets,deformations:deformations.slice(),fill:fill.snapshot(),alphaPatches});
            else if(which==='underpaint')undo.push({which,fill:fill.snapshot(),anchor:fillAnchor?.slice()});
            else {
                const saved={which,donor:donor?.slice(),donorSelected,healAnchor:healAnchor?.slice()};
                if(lightBrush&&(which==='allMasks'||isLightLayer(which)))saved.restoreLight=lightBrush.snapshot(which==='allMasks'?['dodge','burn']:[which]);
                if(which==='allMasks'){
                    // The maps are grayscale. Keep one byte per changed pixel plane
                    // instead of retaining seven complete RGBA images on every reset.
                    saved.modeMaps={...modeMaps};saved.planes=[];
                    for(const key of allMaskKeys){
                        const {data:pixels}=contextsFor(key)[0].getImageData(0,0,data.width,data.height);
                        const empty=key==='strength'?255:0;
                        let plane=null;
                        for(let i=0;i<pixels.length;i+=4){
                            if(pixels[i]===empty)continue;
                            if(!plane)plane=new Uint8Array(pixels.length/4).fill(empty);
                            plane[i/4]=pixels[i];
                        }
                        if(plane)saved.planes.push({key,plane});
                    }
                }else saved.pixels=contextsFor(which).map(c=>c.getImageData(0,0,data.width,data.height));
                if(which==='alpha')saved.fill=fill.snapshot();
                undo.push(saved);
            }
            undoButton.disabled=false;
        }
        function undoStroke() {
            if (drawing || isPanning() || smartWarp?.busy) return;
            if(smartWarp?.undoDraft())return;
            if(isCurve()&&curve.history.length){curve.undo();refreshPathPreview();return;}
            const saved = undo.pop();
            saved?.restoreLight?.();
            if(saved && 'fill' in saved)fill.restore(saved.fill);
            if(saved?.restore){
                saved.restore();scheduleRender();
            }else if(saved?.which==='acceptedEdge'){
                edgeState=saved.edgeState;scheduleRender();
            }else if(saved?.which==='underpaint'){
                fillAnchor=saved.anchor??null;scheduleRender();
            }else if(saved?.which==='geometry'){
                for(const {context,x,y,before} of saved.alphaPatches)context.putImageData(before,x,y);
                ({original,allowed,edgeTargets,deformations}=saved);rebuildGuards();scheduleRender();
                hint.textContent=inpaintText("Деформация отменена. Восстановлены изображение и прозрачность до сдвига.");
            } else if(saved){
                donor=saved.donor||null;donorSelected=saved.donorSelected;healAnchor=saved.healAnchor||null;
                if(saved.which==='allMasks'){
                    Object.assign(modeMaps,saved.modeMaps);
                    for(const {key,plane} of saved.planes){
                        const c=contextsFor(key)[0],image=c.createImageData(data.width,data.height);
                        for(let j=0;j<plane.length;j++){
                            const i=j*4;image.data[i]=image.data[i+1]=image.data[i+2]=plane[j];image.data[i+3]=255;
                        }
                        c.putImageData(image,0,0);
                    }
                }else contextsFor(saved.which).forEach((c,i)=>c.putImageData(saved.pixels[i],0,0));
                scheduleRender();
            }
            if(saved)smartWarp?.refreshGeometry();
            if(saved){localPreview=null;requestLocalPreview();}updateV4();updatePathControls();
        }
        function paintPoints(points) {
            if(!points.length)return;
            const p=points[points.length-1];
            if(lightTool()){
                lightBrush.draw(points,last,diameter,layer.value,erasing,Number(lightHold.value));
                last=p;
                return;
            }
            if(layer.value==='heal'&&!healAnchor)healAnchor=points[0].slice();
            const c = sc;
            c.clearRect(0,0,data.width,data.height); c.strokeStyle = 'white'; c.fillStyle = 'white';
            c.lineWidth = diameter; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath();
            c.moveTo(...(last || points[0])); for(const point of points)c.lineTo(...point);
            c.stroke(); c.beginPath(); c.arc(p[0],p[1],diameter/2,0,Math.PI*2); c.fill();
            if(brushExtension?.paintStroke(strokeCanvas,points,last,diameter)){
                last=p;scheduleRender();return;
            }
            const paintFill=layer.value==='underpaint';
            const cutFill=layer.value==='alpha'&&!erasing&&!makingOpaque&&!editingEdge&&fill.pixels;
            if(paintFill||cutFill){
                if(paintFill&&!last){
                    const surface=(localPreview||currentAlphaImage()).data;
                    const protect=extra.protect.context.getImageData(0,0,data.width,data.height).data;
                    const color=fillColor.slice(1).match(/../g).map(v=>parseInt(v,16));
                    let offset=null;
                    if(!erasing && fillMode.value==='texture'){
                        if(!fillDonor)return;
                        fillAnchor??=points[0].map(Math.floor);
                        offset=fillDonor.map((v,i)=>v-fillAnchor[i]);
                    }
                    fillStroke={surface,protect,color,offset,erase:erasing};
                    ++localRevision;clearTimeout(localTimer);localAbort?.abort();localPreview=null;
                }
                let [minX,minY]=last||points[0],maxX=minX,maxY=minY;
                for(const [x,y] of points){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
                const pad=diameter/2+1,x=Math.max(0,Math.floor(minX-pad)),y=Math.max(0,Math.floor(minY-pad));
                const w=Math.min(data.width,Math.ceil(maxX+pad))-x,h=Math.min(data.height,Math.ceil(maxY+pad))-y;
                if(w>0&&h>0)fill.stroke(x,y,c.getImageData(x,y,w,h),paintFill?fillStroke:{erase:true});
                if(paintFill){last=p;scheduleRender();return;}
            }
            if (layer.value === 'alpha' && (makingOpaque || editingEdge)) {
                c.globalCompositeOperation = 'destination-in'; c.drawImage(editingEdge?edgeGuardCanvas:guardCanvas,0,0); c.globalCompositeOperation = 'source-over';
            }
            // White adds to the selected map, black removes prior edits. Restore
            // clears all maps; opacity tools clear other edits within their guard.
            if (layer.value === 'alpha') {
                if (!erasing) (editingEdge ? ec : makingOpaque ? bc : ac).drawImage(strokeCanvas,0,0);
            } else if (!erasing || (layer.value==='edge_finish'&&data.edge_strokes)) {
                if(layer.value==='strength'){
                    const v=Math.round(Math.max(0,Math.min(1,Number(brushStrength.value)||0))*255);
                    c.globalCompositeOperation='source-in';c.fillStyle=`rgb(${v},${v},${v})`;c.fillRect(0,0,data.width,data.height);c.globalCompositeOperation='source-over';
                }
                currentContext().drawImage(strokeCanvas,0,0);
            }
            c.globalCompositeOperation = 'source-in'; c.fillStyle = 'black'; c.fillRect(0,0,data.width,data.height); c.globalCompositeOperation = 'source-over';
            if (layer.value === 'alpha') {
                if (erasing || makingOpaque || editingEdge) ac.drawImage(strokeCanvas,0,0);
                if (!makingOpaque) bc.drawImage(strokeCanvas,0,0);
                if (!editingEdge) ec.drawImage(strokeCanvas,0,0);
            } else if (erasing && !(layer.value==='edge_finish'&&data.edge_strokes)) {
                if(layer.value==='strength'){c.globalCompositeOperation='source-in';c.fillStyle='white';c.fillRect(0,0,data.width,data.height);c.globalCompositeOperation='source-over';}
                currentContext().drawImage(strokeCanvas,0,0);
            }
            last = p; scheduleRender();
        }
        function eventPoint(e) {
            const r=canvas.getBoundingClientRect();
            return [(e.clientX-r.left)*data.width/r.width,(e.clientY-r.top)*data.height/r.height];
        }
        function updatePathControls() {
            const pending=curve.points.length>0,curveMode=isCurve(),external=smartWarp?.mode!=='brush'&&!!smartWarp,locked=saving||referenceUploading||smartWarp?.busy;
            smoothLabel.style.display=pathMode.value==='smooth'?'':'none';
            for(const el of [applyCurveButton,removePointButton,resetCurveButton,pointCount])el.style.display=curveMode?'':'none';
            curveReach.container.style.display=pathMode.value==='curve'?'':'none';
            applyCurveButton.disabled=curve.points.length<2||drawing||saving;
            removePointButton.disabled=curve.selected<0||drawing||saving;
            resetCurveButton.disabled=(!pending&&!curve.history.length)||drawing||saving;
            pointCount.textContent=pending?`${inpaintText("Точек: ")}${curve.points.length}${inpaintText(" · предпросмотр")}`:inpaintText("Кликните начало дуги");
            // A pending path belongs to one layer/tool; switching cannot silently
            // discard it or apply it to a different alpha operation.
            for(const el of [layer,pathMode,brush,eraser,donorButton,healMode,brushStrength,clear])el.disabled=pending||drawing||locked||external;
            opaqueButton.disabled=!data.opaque_region||pending||drawing||locked||external;
            edgeButton.disabled=!data.edge_alpha_target||pending||drawing||locked||external;
            size.disabled=exactSize.disabled=smoothAmount.disabled=drawing||saving;
            saveButton.disabled=pending||drawing||locked||smartWarp?.pending;
            undoButton.textContent=curveMode&&curve.history.length?inpaintText("Отменить точку / сдвиг"):inpaintText("Отменить штрих · Ctrl+Z");
            undoButton.disabled=drawing||locked||(!undo.length&&!curve.history.length&&!smartWarp?.pending);
            smartWarp?.sync();
            for(const el of [sizeLabel,exactSize,sizeUnits])el.style.display=external?'none':'';
            for(const el of [section,action,method])el.disabled=pending||drawing||locked||smartWarp?.pending;
            for(const el of fillRow.querySelectorAll('input,button,select'))el.disabled=pending||drawing||locked||!data.underpaint;
            for(const input of[brushStrength,lightAmount,healAmount,edgeAmount,donorSize]){input.disabled=pending||drawing||locked;input.range.disabled=input.disabled;}
            smoothEdge.disabled=pending||drawing||locked;
            accumulate.disabled=pending||drawing||locked||!data.accumulated_light;
            if(lightHold)lightHold.disabled=drawing||locked;
            curveReach.disabled=curveReach.range.disabled=drawing||locked;
            const reference=action.value==='reference';
            if(reference){pathRow.style.display='none';for(const el of[sizeLabel,exactSize,sizeUnits])el.style.display='none';}
            tools.style.display=external||reference?'none':'flex';
            for(const b of[sampleButton,referenceUpload,referenceReset])b.disabled=pending||drawing||locked;
            clear.disabled=clear.disabled||reference;
            clearAll.disabled=pending||drawing||locked||smartWarp?.pending||referenceEditor.unfinished;
            resetDonor.disabled=!donorSelected||pending||drawing||locked;
        }
        function drawPathPreview() {
            pathFrame=0;
            const viewport=prepareViewportOverlay(pathPreview,canvas,area);
            if(!viewport)return;
            if(smartWarp?.mode!=='brush'&&smartWarp){smartWarp.draw(pathContext,viewport.scale);return;}
            const points=lineDraft||curvePoints();
            if(!points.length)return;
            const scale=viewport.scale;
            const c=pathContext,color=erasing?'#ffb3b3':layer.value==='guide'?'#32d2ff':layer.value==='protect'?'#44e678':'#ffc66c';
            c.save();c.lineCap='round';c.lineJoin='round';c.strokeStyle=color;c.fillStyle=color;c.globalAlpha=.35;
            c.lineWidth=diameter;c.beginPath();c.moveTo(...points[0]);for(const p of points)c.lineTo(...p);c.stroke();
            c.beginPath();c.arc(points[0][0],points[0][1],diameter/2,0,Math.PI*2);c.fill();
            c.globalAlpha=1;c.lineWidth=1.3/scale;c.setLineDash([5/scale,4/scale]);
            c.beginPath();c.moveTo(...points[0]);for(const p of points)c.lineTo(...p);c.stroke();c.setLineDash([]);
            if(!lineDraft)(curve.displayPoints?.() || curve.points).forEach((p,i)=>{
                c.beginPath();c.arc(p[0],p[1],6/scale,0,Math.PI*2);
                c.fillStyle=i===curve.selected?'#ffc66c':'#202226';c.fill();c.strokeStyle='#fff';c.lineWidth=1.5/scale;c.stroke();
                c.fillStyle='#fff';c.font=`${12/scale}px sans-serif`;c.fillText(String(i+1),p[0]+9/scale,p[1]-8/scale);
            });c.restore();
        }
        refreshPathPreview=()=>{updatePathControls();if(!pathFrame)pathFrame=requestAnimationFrame(drawPathPreview);};
        area.addEventListener('scroll',()=>refreshPathPreview(),{passive:true});
        previewObserver=new ResizeObserver(()=>{refit();refreshPathPreview();});
        previewObserver.observe(area);previewObserver.observe(canvas);
        modal.addEventListener('close',()=>previewObserver.disconnect(),{once:true});
        function finishLightStroke(commit) {
            lightBrush.finish(commit ? (patch,x,y)=>{
                snapshot(layer.value);
                lightBrush.apply(layer.value,patch,x,y,accumulate.checked,erasing,Number(lightAmount.value));
            } : null);
        }
        function applyCurve() {
            if(curve.points.length<2||drawing||saving)return;
            if(!lightTool())snapshotStroke();
            last=null;paintPoints(curvePoints());last=null;
            if(lightTool())finishLightStroke(true);
            curve.clear();refreshPathPreview();
            fillStroke=null;
            if(layer.value==='edge_finish'&&data.edge_strokes)commitEdgeStroke(erasing);
            else requestLocalPreview(false,lightTool());
        }
        canvas.onpointerdown = e => {
            if (e.button !== 0 || isPanning() || saving || referenceUploading) return;
            if(layer.value==='edge_finish'&&!data.edge_strokes)return;
            e.preventDefault(); e.stopPropagation();
            canvas.focus({preventScroll:true});
            if(layer.value==='underpaint'){
                if(!data.underpaint)return;
                if((pickingColor || e.altKey) && !curve.points.length){
                    const [x,y]=eventPoint(e).map((v,i)=>Math.min((i?data.height:data.width)-1,Math.max(0,Math.floor(v))));
                    const surface=(localPreview||currentAlphaImage()).data,i=(y*data.width+x)*4;
                    if(!surface[i+3]){stateHint.textContent=inpaintText("Выберите образец на видимой части изображения.");return;}
                    if(fillMode.value==='texture'){fillDonor=[x,y];fillAnchor=null;}
                    else{fillColor='#'+Array.from(surface.slice(i,i+3),v=>v.toString(16).padStart(2,'0')).join('');fillColors.update(fillColor,false);}
                    pickingColor=false;updateV4();scheduleRender();return;
                }
                if(!erasing&&fillMode.value==='texture'&&!fillDonor){stateHint.textContent=inpaintText("Сначала возьмите текстуру кнопкой или Alt+кликом.");return;}
            }
            if(pickingColor){const p=eventPoint(e),x=Math.max(0,Math.min(data.width-1,Math.floor(p[0]))),y=Math.max(0,Math.min(data.height-1,Math.floor(p[1]))),i=(y*data.width+x)*4,base=localPreview||currentAlphaImage();
                if(!currentAlphaImage().data[i+3]){stateHint.textContent=inpaintText("Это прозрачный фон. Кликните по видимой поверхности.");return;}
                chosenColor='#'+Array.from(base.data.slice(i,i+3)).map(v=>v.toString(16).padStart(2,'0')).join('');colors.update(chosenColor,false);pickingColor=false;updateV4();scheduleRender();return;}
            if(action.value==='reference'){
                if(selectedReference==='file'&&!pickingDonor)return;
                referenceDonor=eventPoint(e).map((v,i)=>Math.max(0,Math.min((i?data.height:data.width)-1,v)));selectedReference='crop';referenceMode='Донор из кисти';pickingDonor=false;updateV4();scheduleRender();return;
            }
            if(smartWarp?.down(e,eventPoint(e)))return;
            if(layer.value==='heal'&&(e.altKey||pickingDonor)&&!curve.points.length){
                snapshot('heal');const r=canvas.getBoundingClientRect();
                donorSelected=true;donor=[(e.clientX-r.left)*data.width/r.width,(e.clientY-r.top)*data.height/r.height];
                healAnchor=null;pickingDonor=false;extra.heal.context.fillStyle='black';extra.heal.context.fillRect(0,0,data.width,data.height);
                localPreview=null;updateV4();scheduleRender();requestLocalPreview();return;
            }
            if(layer.value==='heal'&&!donorSelected&&!erasing){hint.textContent=inpaintText("Сначала выберите донора Alt+кликом.");return;}
            const p=eventPoint(e);
            drawing = true; drawPointer = e.pointerId; last=null;
            if(lightTool()){
                ++localRevision; clearTimeout(localTimer); localAbort?.abort();
            }
            canvas.setPointerCapture(drawPointer);
            if(isCurve()) {
                if(curve.beginGesture){
                    curve.beginGesture(p, data.width/canvas.getBoundingClientRect().width);
                    refreshPathPreview();return;
                }
                const hit=curve.hit(p,10*data.width/canvas.getBoundingClientRect().width);
                const lineHit=curve.path.length>1?nearestPath(curve.path,p):null;
                if(hit<0&&lineHit&&lineHit.distance<12*data.width/canvas.getBoundingClientRect().width){curve.remember();curveBend={base:curve.path.map(p=>p.slice()),index:lineHit.index,start:p};curveDrag=-1;}
                else {if(hit>=0){curve.remember();curve.select(hit);curveOffset=[curve.points[hit][0]-p[0],curve.points[hit][1]-p[1]];}
                    else {curve.add(p);curveOffset=[0,0];}curveDrag=curve.selected;}
                refreshPathPreview();
            } else if(pathMode.value==='line') {lineDraft=[p,p];refreshPathPreview();}
            else {
                if(!lightTool())snapshotStroke();
                if(pathMode.value==='smooth')stabilizer=new BrushStabilizer(p,Number(smoothAmount.value)*.6*data.width/canvas.getBoundingClientRect().width);
                paintPoints([p]);updatePathControls();
            }
        };
        canvas.onpointermove = e => {
            if(smartWarp?.move(e,eventPoint(e)))return;
            if(!drawing||e.pointerId!==drawPointer)return;
            if(isCurve()&&curve.moveGesture){curve.moveGesture(eventPoint(e));refreshPathPreview();}
            else if(curveBend){const p=eventPoint(e);curve.bend(curveBend.base,curveBend.index,[p[0]-curveBend.start[0],p[1]-curveBend.start[1]],Number(curveReach.value)/100);refreshPathPreview();}
            else if(curveDrag>=0){const p=eventPoint(e);curve.move(curveDrag,[p[0]+curveOffset[0],p[1]+curveOffset[1]]);refreshPathPreview();}
            else if(lineDraft){lineDraft[1]=eventPoint(e);refreshPathPreview();}
            else {
                const events=e.getCoalescedEvents?.();
                for(const event of events?.length?events:[e]) {
                    const p=eventPoint(event);paintPoints(stabilizer?stabilizer.move(p):[p]);
                }
                refreshBrushCursor();
            }
        };
        const endDrawing = e => {
            if(smartWarp&&smartWarp.mode!=='brush'){smartWarp.end(e,eventPoint(e));return;}
            if(!drawing||e.pointerId!==drawPointer)return;
            if(isCurve()&&curve.endGesture){
                curve.endGesture(e.type==='pointerup'?eventPoint(e):null);
            }else if(e.type==='pointerup') {
                if(lineDraft){lineDraft[1]=eventPoint(e);if(!lightTool())snapshotStroke();paintPoints(lineDraft);}
                else if(stabilizer)paintPoints(stabilizer.finish(eventPoint(e)));
                else if(lightTool()&&!isCurve())paintPoints([eventPoint(e)]);
                else if(curveBend){const p=eventPoint(e);curve.bend(curveBend.base,curveBend.index,[p[0]-curveBend.start[0],p[1]-curveBend.start[1]],Number(curveReach.value)/100);}
                else if(curveDrag>=0){const p=eventPoint(e);curve.move(curveDrag,[p[0]+curveOffset[0],p[1]+curveOffset[1]]);}
            } else if(curveDrag>=0||curveBend)curve.undo(); // Interrupted handle moves never commit.
            const id=drawPointer;drawing=false;last=null;drawPointer=null;stabilizer=null;lineDraft=null;curveDrag=-1;curveBend=null;
            if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);
            if(lightTool()){
                finishLightStroke(e.type==='pointerup');
                requestLocalPreview(false,true);
            }else if(layer.value==='edge_finish'&&data.edge_strokes){
                if(e.type==='pointerup')commitEdgeStroke(erasing);
                else {const c=extra.edge_finish.context;c.fillStyle='black';c.fillRect(0,0,data.width,data.height);scheduleRender();}
            }else if(localLayers.includes(layer.value)||['alpha','protect','underpaint'].includes(layer.value)){localPreview=null;requestLocalPreview();}
            fillStroke=null;
            refreshPathPreview();refreshBrushCursor();
        };
        canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = endDrawing;
        modal.addEventListener('keydown',e=>{
            // Comfy's global shortcuts can prevent the native dialog cancel event.
            // Handle Escape here before it reaches the workflow canvas.
            if(e.key==='Escape') {
                e.preventDefault();e.stopPropagation();
                if(smartWarp?.escape())return;
                if(drawing)endDrawing({type:'pointercancel',pointerId:drawPointer});
                else if(curve.points.length&&!saving){curve.clear();refreshPathPreview();}
                else modal.close();
                return;
            }
        });
        modal.addEventListener('cancel',e=>{
            if(drawing){e.preventDefault();endDrawing({type:'pointercancel',pointerId:drawPointer});return;}
            if(curve.points.length&&!saving){e.preventDefault();curve.clear();refreshPathPreview();}
        });
        disposeUndo=installEditorUndo(modal,undoStroke,()=>saving||drawing||referenceUploading||smartWarp?.busy,app.constructor,()=>{
            if(smartWarp?.mode==='brush'&&isCurve()&&curve.selected>=0){curve.remove();refreshPathPreview();}
        });
        modal.addEventListener('close',()=>{disposeUndo();referenceAbort?.abort();referenceEditor.dispose();localRevision++;clearTimeout(localTimer);localAbort?.abort();smartWarp?.dispose();if(frame)cancelAnimationFrame(frame);if(pathFrame)cancelAnimationFrame(pathFrame);modal.remove();node._alphaEditorOpen=false;});
        smartWarp=installSmartWarp({element,button,layout,pathRow,rowStyle,canvas,width:data.width,height:data.height,available:data.geometry_version===1&&data.smart_selection,
            fitInwardContour:node.properties?.inpaintBrushEditor==="4.1"?node.fitInwardContour:null,
            contourAvailable:data.geometry_modes?.includes('contour'),
            editor41, freeEdgeAvailable:data.geometry_modes?.includes('free_edge'),
            routed:true,targetLabel:()=>action.selectedOptions[0]?.textContent||inpaintText("выделение"),
            brushPending:()=>curve.points.length>0||drawing||saving,
            resetPath:()=>{curve.clear();pickingDonor=false;},update:updateV4,
            refresh:()=>{refreshPathPreview();refreshBrushCursor();},
            message:(text,error=false)=>{hint.textContent=text;hint.style.color=error?'#ffb3b3':'#ccd4de';},
            request:()=>({image:selected,source_sha256:data.source_sha256,mask_data:buildPayload()}),
            drawOverlay:(context,pixels)=>{oc.putImageData(pixels,0,0);context.drawImage(overlay,0,0);},
            previewWarp:op=>{
                const protect=op?extra.protect.context.getImageData(0,0,data.width,data.height).data:null;
                if(op?.mode==='free_edge'){
                    dragAlphaMaps??=captureWarpAlpha(op);
                    warpAlphaPreview=shiftWarpAlpha(dragAlphaMaps,op);
                }else{dragAlphaMaps=null;warpAlphaPreview=null;}
                warpPreview=op?new ImageData(warpRGBA(original.data,data.width,data.height,op,protect),data.width,data.height):null;
                warpFill=op&&fill.pixels?warpRGBA(fill.pixels,data.width,data.height,op,protect):null;
                scheduleRender();
            },
            commitWarp,
            contourImage:()=>currentAlphaImage(),
            contourProtection:()=>extra.protect.context.getImageData(0,0,data.width,data.height).data,
            previewContour:mask=>{contourPreview=mask;scheduleRender();},
            acceptContour:mask=>{
                snapshot('alpha');const pixels=ac.getImageData(0,0,data.width,data.height);
                fill.stroke(0,0,mask,{erase:true,grayMask:true});
                for(let i=0;i<pixels.data.length;i+=4){const v=combineErasure(pixels.data[i],mask.data[i]);pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=v;}
                ac.putImageData(pixels,0,0);layer.value='alpha';erasing=makingOpaque=editingEdge=false;localPreview=null;updateV4();scheduleRender();requestLocalPreview();
            },
            acceptMask:(pixels,alpha)=>{
                alpha=alpha||layer.value==='alpha';
                if(layer.value==='heal'&&!donorSelected){hint.textContent=inpaintText("Сначала выберите чистый участок в режиме кисти.");return;}
                snapshot(alpha?'alpha':layer.value);
                if(!alpha&&lightTool()){
                    lightBrush.applySelection(layer.value,pixels,accumulate.checked,Number(lightAmount.value));
                    erasing=false;scheduleRender();requestLocalPreview();return;
                }
                if(alpha)fill.stroke(0,0,pixels,{erase:true,grayMask:true});
                const contexts=alpha?[ac,bc,ec]:[currentContext()];
                if(layer.value==='heal'&&!healAnchor){let count=0,x=0,y=0;for(let i=0;i<pixels.data.length;i+=4)if(pixels.data[i]){x+=(i/4)%data.width;y+=Math.floor(i/4/data.width);count++;}if(count)healAnchor=[x/count,y/count];}
                contexts.forEach((context,index)=>{
                    const target=context.getImageData(0,0,data.width,data.height);
                    for(let i=0;i<target.data.length;i+=4){
                        const v=!alpha&&layer.value==='strength'?Math.round(target.data[i]*(1-pixels.data[i]/255)+Number(brushStrength.value)*pixels.data[i]):index===0?Math.max(target.data[i],pixels.data[i]):Math.round(target.data[i]*(1-pixels.data[i]/255));
                        target.data[i]=target.data[i+1]=target.data[i+2]=v;
                    }context.putImageData(target,0,0);
                });
                erasing=makingOpaque=editingEdge=false;scheduleRender();
                if(layer.value==='edge_finish'&&data.edge_strokes)commitEdgeStroke();
                else requestLocalPreview();
            },
        });
        // An opted-in source can provide additional strokes using the same
        // paint, preview and undo pipeline as the built-in brushes.
        brushExtension=node.createInpaintBrushTools?.({
            dialog:modal, pathMode, curveTypes, refresh:refreshPathPreview,
            surface:()=>pc.getImageData(0,0,data.width,data.height),
            maps:{mask:mc,protect:extra.protect.context,guide:extra.guide.context,strength:extra.strength.context},
        });
        if(startReference&&!recolor)action.value='reference';
        routeAction();pickingColor=startColor&&recolor;updateV4();updatePathControls();
        document.body.append(modal); modal.showModal();
        stage.style.padding = `${Math.floor(area.clientHeight/2)}px ${Math.floor(area.clientWidth/2)}px`;
        let fit = Math.min((area.clientWidth-12)/data.width,(area.clientHeight-12)/data.height);
        let magnification = 1;
        const resize = (next,clientX,clientY) => {
            const before = canvas.getBoundingClientRect();
            const anchorX = (clientX-before.left)/before.width, anchorY = (clientY-before.top)/before.height;
            magnification = Math.max(1,Math.min(8,next));
            canvas.style.width = Math.max(1,Math.floor(data.width*fit*magnification))+'px';
            canvas.style.height = Math.max(1,Math.floor(data.height*fit*magnification))+'px';
            const after = canvas.getBoundingClientRect();
            area.scrollLeft += after.left+anchorX*after.width-clientX;
            area.scrollTop += after.top+anchorY*after.height-clientY;
            const preset = [1,1.5,2,3,4,8].find(value=>Math.abs(value-magnification)<.0001);
            customZoom.hidden = !!preset; customZoom.textContent = Math.round(magnification*100)+'%';
            zoom.value = preset ? String(preset) : 'custom';
            refreshBrushCursor(); refreshPathPreview();
        };
        refit=()=>{if(magnification!==1||area.clientWidth<=12||area.clientHeight<=12)return;const next=Math.min((area.clientWidth-12)/data.width,(area.clientHeight-12)/data.height);if(Math.abs(fit-next)<.0001)return;fit=next;const r=area.getBoundingClientRect();resize(1,r.left+area.clientWidth/2,r.top+area.clientHeight/2);area.scrollLeft=(area.scrollWidth-area.clientWidth)/2;area.scrollTop=(area.scrollHeight-area.clientHeight)/2;};
        zoom.onchange = () => {
            if (zoom.value === 'custom') return;
            const rect = area.getBoundingClientRect(); resize(Number(zoom.value),rect.left+area.clientWidth/2,rect.top+area.clientHeight/2);
        };
        area.addEventListener('wheel',e=>{
            e.preventDefault(); e.stopPropagation(); if (drawing || isPanning() || saving || smartWarp?.busy) return;
            const delta = e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?area.clientHeight:1);
            resize(magnification*Math.exp(-Math.max(-240,Math.min(240,delta))*.0025),e.clientX,e.clientY);
        },{passive:false});
        const rect = area.getBoundingClientRect(); resize(1,rect.left+area.clientWidth/2,rect.top+area.clientHeight/2);
        modal.addEventListener('close',()=>edgeAbort.abort(),{once:true});
        area.scrollLeft = (area.scrollWidth-area.clientWidth)/2; area.scrollTop = (area.scrollHeight-area.clientHeight)/2; render();
        if(data.edge_strokes&&previous?.source_sha256===data.source_sha256&&previous.edge_finish_png&&mapUsed('edge_finish'))commitEdgeStroke(false,true);
        else requestLocalPreview();
    } catch (error) {
        disposeUndo();previewObserver?.disconnect();smartWarp?.dispose();if (frame) cancelAnimationFrame(frame);if(pathFrame)cancelAnimationFrame(pathFrame); modal?.remove(); node._alphaEditorOpen = false; alert(error.message);
    }
}
