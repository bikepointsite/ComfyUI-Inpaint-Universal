import { t as inpaintText } from '/extensions/png_inpaint_v4/language.js';
import { app } from "/scripts/app.js";
import { installStrokeTools } from "./stroke_tools.js";
import { fitInwardContour } from "./inward_contour.js";
import { readSurfacePixels } from "./surface_pixels.js";

const shapes = {
    free: inpaintText("От руки"), smooth: inpaintText("Со стабилизацией"), line: inpaintText("Прямая"),
    elastic: inpaintText("Круговая дуга"), oval: inpaintText("Овальная дуга"), curve: inpaintText("Кривая по точкам"),
    contourStroke: inpaintText("Плавный контур"),
};
const alphaTools = ["alpha-erase", "alpha-restore", "alpha-opaque", "alpha-edge"];
const nonBrush = new Set(["smart", "warp", "segment", "reference"]);
const preferencePrefix = "inpaint.v4.1.brush.";

function readPreferences(key) {
    try { return JSON.parse(localStorage.getItem(preferencePrefix + key)) || {}; }
    catch { return {}; }
}

function savePreferences(key, values) {
    try { localStorage.setItem(preferencePrefix + key, JSON.stringify(values)); }
    catch { /* Browsers with storage disabled still keep the settings for this session. */ }
}

const sessionPreferences = new Map();
function preferences(key) {
    return sessionPreferences.get(key) || readPreferences(key);
}

function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
}

function addButton(parent, text, handler) {
    const button = make("button", "", text);
    button.type = "button";
    button.addEventListener("click", handler);
    parent.append(button);
    return button;
}

function selectValue(select, value) {
    if (select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNumber(input, value) {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

function enhance(dialog) {
    const field = label => dialog.querySelector('[aria-label="' + label + '"]');
    const section = field(inpaintText("Раздел редактора"));
    const action = field(inpaintText("Действие"));
    const method = field(inpaintText("Как выделить"));
    const shape = field(inpaintText("Способ рисования"));
    const size = field(inpaintText("Размер кисти в пикселях"));
    const sizeSlider = field(inpaintText("Размер кисти — плавно"));
    const warpSize = field(inpaintText("Диаметр деформации, px"));
    const engine = field(inpaintText("Инструмент редактора"));
    const layout = dialog.querySelector(".reference-layout");
    const workspace = dialog.querySelector(".reference-workspace");
    const nativeTools = field(inpaintText("Слой правки"))?.closest("label")?.parentElement;
    if (![section, action, method, shape, size, sizeSlider, warpSize, engine, layout, workspace, nativeTools].every(Boolean)) return;

    const [paint, erase, opaque, edge] = nativeTools.querySelectorAll("button");
    const navigation = section.parentElement;
    const title = layout.querySelector("h3");
    const undo = navigation.querySelector("button");
    const background = dialog.querySelector(".png-v4-backgrounds");
    const zoom = field(inpaintText("Масштаб маски"))?.closest("label");
    const shapeLabel = shape.closest("label");
    const stateHint = navigation.nextElementSibling;
    if (![paint, erase, opaque, edge, title, undo, background, zoom, shapeLabel, stateHint].every(Boolean)) return;
    const availableGeneration = new Map(Array.from(action.options, opt => [opt.value, opt.text]));
    const originals = Array.from(layout.children).slice(0, Array.from(layout.children).indexOf(workspace));

    dialog.classList.add("inpaint-v41");
    const header = make("header", "v41-header");
    title.textContent = title.textContent.replace("Inpaint V4", "Inpaint V4.1");
    const modeTitle=title.textContent;
    header.append(title, background, zoom, undo);
    const frame = make("div", "v41-frame");
    const rail = make("nav", "v41-rail");
    rail.setAttribute("aria-label", inpaintText("Инструменты правки"));
    layout.before(header, frame);
    frame.append(rail, layout);
    const options = make("div", "v41-options");
    workspace.before(options);
    options.append(...originals.filter(el => el !== title && el !== stateHint));
    options.append(stateHint);
    navigation.hidden = true;
    navigation.classList.add("v41-internal");
    shapeLabel.classList.add("v41-internal");
    stateHint.classList.add("v41-instruction");
    const help=workspace.nextElementSibling;
    help?.classList.add("v41-help");
    const shapeBar = make("div", "v41-shapes v41-stroke-types");
    shapeBar.setAttribute("role", "group");
    shapeBar.setAttribute("aria-label", inpaintText("Тип штриха"));
    shapeBar.append(make("span", "v41-shape-label", inpaintText("Тип штриха")));
    shapeLabel.before(shapeBar);
    const sizeCaption=make("span","v41-size-caption");
    sizeSlider.closest("label").firstChild.replaceWith(sizeCaption);
    const pathRow=shapeLabel.parentElement;
    const applyPath=Array.from(pathRow.querySelectorAll("button")).find(b=>b.textContent===inpaintText("Применить кривую"));
    const pointCount=pathRow.querySelector(":scope > span");
    pointCount?.classList.add("v41-point-count");
    const opBar=make("div","v41-operations v41-shapes");
    opBar.setAttribute("aria-label",inpaintText("Действие кисти"));
    const basics=make("div","v41-brush-basics");
    pathRow.before(basics);
    const sizeRow=size.parentElement;
    sizeRow.classList.add("v41-brush-size");
    basics.append(opBar,sizeRow);
    const strength=field(inpaintText("Сила света / тени"))?.closest("label");
    const lightFade=field(inpaintText("Полная сила до"))?.closest("label");
    const lightParameters=make("div","v41-light-parameters");
    if(strength){
        const accumulate=strength.parentElement.querySelector('input[type="checkbox"]')?.closest("label");
        strength.parentElement.classList.add("v41-advanced");
        strength.classList.add("v41-light-amount");
        basics.append(lightParameters);
        lightParameters.append(strength);
        if(accumulate)lightParameters.append(accumulate);
    }
    const penButton=addButton(opBar,inpaintText("Кисть"),()=>setOperation(false));
    const eraserButton=addButton(opBar,inpaintText("Ластик"),()=>setOperation(true));
    const scope=make("select");
    scope.setAttribute("aria-label",inpaintText("Что стирать"));
    scope.title=inpaintText("Все маски — маска правки, защита, направляющая и локальная сила текущего режима.");
    scope.add(new Option(inpaintText("Текущий слой"),"layer"));scope.add(new Option(inpaintText("Все маски"),"all"));
    basics.append(scope);
    const contourBar=make("div","v41-contour-options");
    pathRow.append(contourBar);
    const contour=dialog.contourStroke;
    scope.options[1].disabled=!contour;
    const snapActions=make("div","v41-shapes");
    contourBar.append(snapActions);
    const snap=addButton(snapActions,inpaintText("Привязать к границе"),()=>{contour.snap(false);sync();});
    snap.title=inpaintText("Подтянуть линию к ближайшему стыку цвета, фактуры или прозрачности.");
    const limit=addButton(snapActions,inpaintText("Привязать внутри маски"),()=>{contour.snap(true);sync();});
    limit.title=inpaintText("Искать такой же стык только в закрашенной маске правки, рядом с линией.");
    const offsetLabel=make("label","v41-offset",inpaintText("Смещение, px "));
    const offset=make("input"),exactOffset=make("input");
    for(const [field,type] of [[offset,"range"],[exactOffset,"number"]]){
        Object.assign(field,{type,min:-64,max:64,step:.5,value:0});
        field.setAttribute("aria-label",type==="number"?inpaintText("Смещение в пикселях"):inpaintText("Смещение контура"));
        field.oninput=()=>{
            if(!field.value||!Number.isFinite(field.valueAsNumber))return;
            contour.options.offset=Math.max(-64,Math.min(64,field.valueAsNumber));
            (field===offset?exactOffset:offset).value=contour.options.offset;
            contour.refresh();
        };
        field.onchange=()=>{field.value=contour.options.offset;};
        offsetLabel.append(field);
    }
    contourBar.append(offsetLabel);
    const contourHint=inpaintText("Проведите линию по изображению или поставьте две точки.");
    const contourTip=make("span","v41-contour-tip",contourHint);
    contourTip.setAttribute("role","status");
    contourBar.before(contourTip);
    applyPath?.classList.add("v41-apply-path");
    const curveShapes = ["elastic", "oval", "curve", "contourStroke"];
    const curveFields = [...pathRow.children].filter(el => el.matches("button,.v41-point-count"));
    const curveActions=make("div","v41-curve-actions");
    pathRow.append(curveActions);
    curveActions.append(...curveFields);
    if(applyPath)curveActions.append(applyPath);
    const pairedControls = [
        [pathRow.querySelector(inpaintText("[aria-label=\"Сила стабилизации\"]")).closest("label"), ["smooth"]],
        [pathRow.querySelector(inpaintText("[aria-label=\"Ширина изгиба, %\"]")).closest("label"), ["curve"]],
        [contourBar, ["contourStroke"]],
        ...curveFields.map(el => [el, curveShapes]),
    ];

    // A pending curve edits geometry. The preview strip refers only to strokes
    // already applied to the image. Keep them beside their respective targets.
    const previewRow=dialog.querySelector('[data-retouch-preview]');
    if(previewRow){
        workspace.after(previewRow);
        previewRow.classList.add("v41-preview-strip");
    }
    const footer=dialog.querySelector(".reference-footer");
    const savingHint=make("span","v41-saving-hint");
    if(footer)footer.lastElementChild?.before(savingHint);

    const toolButtons = new Map();
    const shapeButtons = new Map();
    const alphaOperations = [paint, erase, opaque, edge];
    let appliedKey = null;
    let routing = false;
    let beforeAll=null;

    function eraseAll(){return dialog.dataset.eraseAll==="true";}
    function setOperation(isEraser){
        if(shape.disabled)return;
        if(eraseAll()&&!isEraser)activate(beforeAll||"mask",false);
        else if(!eraseAll()){
            // Leave donor/eyedropper picking before the first eraser stroke.
            if(isEraser)action.dispatchEvent(new Event("change",{bubbles:true}));
            (isEraser?erase:paint).click();
        }
        sync();
    }
    scope.onchange=()=>{
        if(scope.value==="all"){
            const previous=activeTool();
            activate("mask",true);
            beforeAll=previous;
            dialog.dataset.eraseAll="true";
        }else activate(beforeAll||activeTool(),true);
        sync();
    };

    function activeTool() {
        if (engine.value === "smart") return "smart";
        if (action.value !== "alpha") return action.value;
        const i = alphaOperations.findIndex(b => b.getAttribute("aria-pressed") === "true");
        return alphaTools[Math.max(0, i)];
    }

    function brushKey(tool) {
        if(eraseAll())return "all.eraser";
        if (nonBrush.has(tool) || alphaTools.includes(tool)) return tool;
        return erase.getAttribute("aria-pressed") === "true" ? tool + ".eraser" : tool;
    }

    function remember() {
        if (routing || !appliedKey) return;
        const tool = activeTool();
        if (brushKey(tool) !== appliedKey) return;
        if (nonBrush.has(tool) && tool !== "warp") return;
        const number = tool === "warp" ? warpSize : size;
        const diameter = Number(number.value);
        if (number.value === "" || !number.validity.valid || !Number.isFinite(diameter)) return;
        const prefs = { diameter };
        if (tool !== "warp") prefs.shape = shape.value;
        sessionPreferences.set(appliedKey, prefs);
        savePreferences(appliedKey, prefs);
    }

    function restore(tool, key) {
        appliedKey = key;
        if (nonBrush.has(tool) && tool !== "warp") return;
        const prefs = preferences(key);
        const number = tool === "warp" ? warpSize : size;
        routing = true;
        try {
            const diameter = Number.isFinite(prefs.diameter) ? prefs.diameter : 45;
            if (Number(number.value) !== diameter) setNumber(number, diameter);
            if (tool !== "warp") selectValue(shape, Object.hasOwn(shapes, prefs.shape) ? prefs.shape : "free");
        } finally { routing = false; }
    }

    function sync() {
        if (routing) return;
        const tool = activeTool();
        const key = brushKey(tool);
        if (key !== appliedKey) restore(tool, key);
        dialog.dataset.tool = tool;
        lightParameters.hidden=!["dodge","burn"].includes(action.value);
        const currentTitle=["burn","dodge"].includes(tool)?"Inpaint V4.1 · "+toolButtons.get(tool).textContent:modeTitle;
        if(title.textContent!==currentTitle)title.textContent=currentTitle;
        title.title=modeTitle;
        const isEraser=eraseAll()||erase.getAttribute("aria-pressed")==="true";
        if(lightFade)lightFade.hidden=isEraser||!["dodge","burn"].includes(tool);
        opBar.hidden=nonBrush.has(tool)||alphaTools.includes(tool);
        penButton.disabled=eraserButton.disabled=shape.disabled;
        scope.disabled=shape.disabled||!isEraser;
        scope.hidden=opBar.hidden;
        penButton.setAttribute("aria-pressed",String(!isEraser));
        eraserButton.setAttribute("aria-pressed",String(isEraser));
        scope.style.visibility=isEraser?"visible":"hidden";
        scope.value=eraseAll()?"all":"layer";
        const railKey=eraseAll()?null:tool;
        const isContour=shape.value==="contourStroke"&&!nonBrush.has(tool);
        contourBar.hidden=!isContour;
        contourTip.hidden=!isContour;
        const count=isContour?contour?.pointCount||0:0;
        if(!isContour||!size.disabled||!dialog.dataset.contourStage)
            dialog.dataset.contourStage=!isContour?"off":count===0?"empty":count===1?"point":"draft";
        basics.hidden=nonBrush.has(tool)&&!(tool==="smart"&&["burn","dodge"].includes(action.value));
        sizeCaption.textContent=isContour?inpaintText("Ширина штриха "):inpaintText("Диаметр кисти ");
        // Paired tools remember independent strokes. Reserve the other stroke's
        // controls invisibly so switching the operation doesn't re-fit the image.
        const peerKey = isEraser ? (beforeAll || tool) : tool + ".eraser";
        const peerShape = opBar.hidden ? shape.value : (preferences(peerKey).shape || "free");
        curveActions.hidden=!curveShapes.includes(shape.value)&&!curveShapes.includes(peerShape);
        dialog.classList.toggle("v41-paired-strokes", peerShape !== shape.value);
        for (const [el, modes] of pairedControls) {
            el.classList.toggle("v41-reserved", modes.includes(peerShape) && !modes.includes(shape.value));
        }
        snap.disabled=limit.disabled=!isContour||!applyPath||applyPath.disabled||size.disabled;
        offset.disabled=exactOffset.disabled=size.disabled;
        const tip=(isContour&&contour.message)||(count===0?contourHint:count===1?inpaintText("Поставьте вторую точку или протяните линию."):inpaintText("Черновик. Поправьте линию и примените штрих."));
        if(contourTip.textContent!==tip)contourTip.textContent=tip;
        if(isContour&&contour.undoSnap)undo.textContent=inpaintText("Отменить привязку · Ctrl+Z");
        if(applyPath)applyPath.textContent=isContour?inpaintText("Применить штрих"):inpaintText("Применить кривую");
        for (const [id, btn] of toolButtons) {
            const limited = id === "smart" && engine.querySelector('[value="smart"]').disabled
                || id === "warp" && engine.querySelector('[value="warp"]').disabled
                || action.value === "alpha" && engine.value === "brush"
                   && (id === "alpha-opaque" && opaque.disabled || id === "alpha-edge" && edge.disabled);
            btn.disabled = action.disabled || limited;
            btn.setAttribute("aria-pressed", String(id === railKey));
        }
        for (const [id, btn] of shapeButtons) {
            btn.disabled = shape.disabled;
            btn.setAttribute("aria-pressed", String(id === shape.value));
        }
        smartTarget.hidden = tool !== "smart";
        if (tool === "smart") smartTarget.textContent = inpaintText("Выделение для слоя «") + (toolButtons.get(action.value)?.textContent || action.selectedOptions[0].text) + "»";
    }

    function activate(id, useEraser) {
        if (action.disabled || routing) return;
        useEraser??=!alphaTools.includes(activeTool())&&!nonBrush.has(activeTool())&&erase.getAttribute("aria-pressed")==="true";
        delete dialog.dataset.eraseAll;
        beforeAll=null;
        // Leave draft ownership and committing strokes to the original editor.
        routing = true;
        try {
            if (id === "smart") {
                if (method.style.display === "none" || method.options[1].disabled) {
                    selectValue(section, "generation");
                    selectValue(action, "mask");
                }
                selectValue(method, "smart");
            } else {
                const isAlpha = alphaTools.includes(id);
                const destination = isAlpha ? "alpha" : id;
                selectValue(method, "brush");
                selectValue(section, availableGeneration.has(destination) ? "generation" : "manual");
                selectValue(action, destination);
                if (isAlpha) alphaOperations[alphaTools.indexOf(id)].click();
                else if (!nonBrush.has(id)) (useEraser ? erase : paint).click();
            }
        } finally { routing = false; }
        sync();
    }

    function group(label, entries) {
        const box = make("div", "v41-group");
        box.setAttribute("role", "group");
        box.setAttribute("aria-label", label);
        box.append(make("h4", "", label));
        for (const [id, text] of entries) {
            const btn = addButton(box, text, () => activate(id));
            btn.dataset.tool = id;
            toolButtons.set(id, btn);
        }
        rail.append(box);
    }

    group(inpaintText("Выделение"), [
        ["mask",inpaintText("Маска правки")],
        ["protect", inpaintText("Защитная маска")], ["smart", inpaintText("Умное выделение")],
        ...[["guide", inpaintText("Направляющая складки / шва")], ["strength", inpaintText("Локальная сила генерации")], ["reference", inpaintText("Референс генерации")]]
            .filter(([id]) => availableGeneration.has(id)),
    ]);
    group(inpaintText("Прозрачность и край"), [
        ["alpha-erase", inpaintText("Стереть до прозрачности")], ["alpha-restore", inpaintText("Вернуть исходную прозрачность")],
        ["alpha-opaque", inpaintText("Сделать непрозрачным")], ["alpha-edge", inpaintText("Убрать полупрозрачность у края")],
        ["underpaint", inpaintText("Дорисовка на прозрачном фоне")],
        ["segment", inpaintText("Правка контура A–B")],
        ["edge_finish", inpaintText("Ретушь края")],
    ]);
    group(inpaintText("Ручная ретушь"), [
        ["warp", inpaintText("Локальная деформация")], ["dodge", inpaintText("Осветлить")], ["burn", inpaintText("Затемнить")], ["heal", inpaintText("Ретушь по образцу")],
    ]);
    const smartTarget = make("span", "v41-smart-target");
    engine.closest("label").after(smartTarget);
    engine.closest("label").parentElement.classList.add("v41-geometry");
    for (const [id, name] of Object.entries(shapes)) {
        if(!shape.querySelector('option[value="' + id + '"]'))continue;
        const btn = addButton(shapeBar, name, () => {
            if (shape.disabled) return;
            selectValue(shape, id);
            sync();
        });
        btn.title = name;
        btn.dataset.shape = id;
        shapeButtons.set(id, btn);
    }
    if(lightFade)shapeBar.append(lightFade);
    nativeTools.classList.add("v41-paint-actions");
    for (const input of [size, sizeSlider, warpSize, warpSize.range]) {
        input.addEventListener("input", remember);
        input.addEventListener("change", remember);
    }
    shape.addEventListener("change", remember);
    for (const b of alphaOperations) b.addEventListener("click", sync);
    // Native operations (save, undo, curve drafts, smart selection) also change
    // these gates without a DOM change event. Watch the controls, not the canvases.
    const gates = new MutationObserver(sync);
    for (const el of [action, shape, opaque, edge, paint, erase]) {
        gates.observe(el, { attributes: true, attributeFilter: ["disabled", "aria-pressed"] });
    }
    if(applyPath)gates.observe(applyPath,{attributes:true,attributeFilter:["disabled"]});
    const clear=dialog.querySelector(".reference-footer button");
    const captions=[stateHint,help,clear].filter(Boolean);
    function updateCaptions(){
        for(const el of captions){
            const old=el.textContent;
            const label=old.replaceAll(inpaintText("Маска Inpaint"),inpaintText("Маска правки"))
                .replaceAll(inpaintText("маску Inpaint"),inpaintText("маску правки")).replaceAll(inpaintText("маске Inpaint"),inpaintText("маске правки"))
                .replaceAll(inpaintText("«Область генерации»"),inpaintText("«Маска правки»"));
            if(label!==old)el.textContent=label;
        }
        const generic=stateHint.textContent===inpaintText("Ручная правка без генерации. После сохранения при пустом красном выделении PNG обновится сразу.");
        stateHint.hidden=generic;
        savingHint.hidden=!generic;
        if(generic){
            savingHint.textContent=inpaintText("При пустой маске генерации PNG обновится сразу после сохранения.");
            savingHint.title=stateHint.textContent;
        }
    }
    const captionChanges=new MutationObserver(updateCaptions);
    for(const el of captions)captionChanges.observe(el,{childList:true,characterData:true,subtree:true});
    updateCaptions();
    dialog.addEventListener("close", () => {gates.disconnect();captionChanges.disconnect();}, { once: true });
    sync();
}

app.registerExtension({
    name: "PNGInpaintV41.BrushEditor",
    nodeCreated(node){
        if(node.comfyClass==="PNGV4AlphaInpaintSource"){
            node.readInpaintSurface=readSurfacePixels;
            node.fitInwardContour=fitInwardContour;
            node.createInpaintBrushTools=host=>node.properties?.inpaintBrushEditor==="4.1"?installStrokeTools(host):null;
        }
    },
    setup() {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = new URL("./brush_editor.css", import.meta.url).href;
        document.head.append(css);
        // All V4 entry points open this same modal, including Continue editing
        // and the reference picker. Only the source of a V4.1 graph opts in.
        const openings = new MutationObserver(changes => {
            for (const change of changes) for (const dialog of change.addedNodes) {
                if (!dialog.matches?.("dialog.png-v4-mask-editor")) continue;
                const source = app.graph?._nodes?.find(n => n.comfyClass === "PNGV4AlphaInpaintSource" && n._alphaEditorOpen);
                if (source?.properties?.inpaintBrushEditor === "4.1") enhance(dialog);
            }
        });
        openings.observe(document.body, { childList: true });
    },
});
