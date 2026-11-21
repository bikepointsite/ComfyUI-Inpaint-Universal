import { t as inpaintText } from './language.js';
import { app } from '/scripts/app.js';
import { api } from '/scripts/api.js';
import { openMaskEditor } from './mask_editor.js';

const widget = (node, name) => node.widgets?.find(w => w.name === name);
const getLink = (graph, id) => graph?.links?.[id] ?? graph?.links?.get?.(id);
const inputLink = (node, name) => getLink(node.graph, node.inputs?.find(i => i.name === name)?.link);

export function sourceForResult(node) {
    const resultLink = inputLink(node, 'images');
    if (!resultLink || resultLink.origin_slot !== 0) return null;
    const engine = node.graph.getNodeById(resultLink.origin_id);
    if (engine?.comfyClass !== 'PNGV4UniversalInpaint') return null;
    const sourceLink = inputLink(engine, 'original_rgba');
    if (!sourceLink || sourceLink.origin_slot !== 2) return null;
    const source = node.graph.getNodeById(sourceLink.origin_id);
    return source?.comfyClass === 'PNGV4AlphaInpaintSource' ? source : null;
}

export function resultsForSource(source) {
    return (source.graph?._nodes || []).filter(node => node.comfyClass === 'PNGV4InpaintResult' && sourceForResult(node)?.id === source.id);
}

export async function prepareAlphaResult(source, payload) {
    const graph = source.graph;
    const targets = resultsForSource(source);
    if (!targets.length) throw new Error(inpaintText("Подключите первую ноду через универсальную правку к ноде прозрачного результата."));
    const ensureIdle = async () => {
        const response = await api.fetchApi('/queue');
        if (!response.ok) throw new Error(inpaintText("Не удалось проверить состояние ComfyUI. Повторите сохранение правок."));
        const queue = await response.json();
        if (queue.queue_running?.length || queue.queue_pending?.length) {
            throw new Error(inpaintText("Дождитесь завершения текущей генерации, затем сохраните правки прозрачности."));
        }
    };
    await ensureIdle();
    const workflow = JSON.parse(JSON.stringify(graph.serialize()));
    const savedSource = workflow.nodes.find(node => String(node.id) === String(source.id));
    if (savedSource) savedSource.widgets_values = [widget(source,'image').value,payload];
    const result = await post('alpha-result', {image:widget(source,'image').value, mask_data:payload,
        source_node_id:String(source.id), workflow});
    // Download first. A failed result must not replace the last good preview or editor data.
    await Promise.all(result.images.map(async ref => {
        const image = new Image();
        image.src = api.apiURL('/view?' + new URLSearchParams({filename:ref.filename,subfolder:ref.subfolder,type:ref.type}));
        await image.decode();
    }));
    await ensureIdle();
    const current = resultsForSource(source);
    if (source.graph !== graph || targets.length !== current.length || targets.some(node => !current.includes(node))) {
        throw new Error(inpaintText("Подключения workflow изменились. Повторите сохранение правок."));
    }
    return () => {
        for (const node of targets) {
            // Feed the standard frontend output handler so both Vue and classic
            // previews update. This is a local UI event, not a queued execution.
            api.dispatchEvent(new CustomEvent('executed', {detail:{node:String(node.id),
                display_node:String(node.id), prompt_id:'manual-alpha-' + crypto.randomUUID(),
                output:{images:result.images, inpaint_result:[result]}}}));
            node.setDirtyCanvas(true,true);
        }
    };
}

export function enginesForPrompt(node) {
    const found = new Map();
    for (const output of node.outputs || []) {
        for (const id of output.links || []) {
            const link = getLink(node.graph, id);
            const target = node.graph?.getNodeById(link?.target_id);
            if (target?.comfyClass === 'PNGV4UniversalInpaint') found.set(target.id, target);
        }
    }
    return [...found.values()];
}

export function promptMode(node) {
    const engines = enginesForPrompt(node);
    if (!engines.length) throw new Error(inpaintText("Подключите позитив и негатив к ноде универсальной правки."));
    const modes = new Set(engines.map(n => widget(n, 'mode')?.value));
    if (modes.size !== 1 || ![...modes][0]) throw new Error(inpaintText("Подключённые ноды правки должны использовать один режим."));
    return [...modes][0];
}

async function post(path, data) {
    const response = await api.fetchApi('/png-inpaint-v4/' + path, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || inpaintText("Не удалось выполнить действие."));
    return result;
}

function controls(node, name) {
    const panel = document.createElement('div');
    Object.assign(panel.style, {padding: '8px', display: 'flex', flexDirection: 'column', gap: '7px', color: '#d7e3df', backgroundColor: '#24282d', borderRadius: '6px'});
    const status = document.createElement('div');
    Object.assign(status.style, {fontSize: '12px', lineHeight: '1.4', whiteSpace: 'pre-wrap'});
    const button = document.createElement('button'); button.type = 'button';
    Object.assign(button.style, {padding: '10px', cursor: 'pointer', borderRadius: '6px', fontSize: '14px'});
    panel.append(button, status);
    node.addDOMWidget(name, 'div', panel, {serialize: false, hideOnZoom: false,
        getMinHeight:()=>Number(panel.dataset.height)||(name==='continue_edit_controls'?170:110),
        getMaxHeight:()=>Number(panel.dataset.height)||(name==='continue_edit_controls'?170:110)});
    return {button, status};
}

export async function selectSource(source, data) {
    const image = widget(source, 'image');
    const mask = widget(source, 'mask_data');
    if (!image || !mask) throw new Error(inpaintText("Не найдены исходник и маска в первой ноде."));
    const previousImage = image.value, previousMask = mask.value;
    // Decode before touching the source: a failed download must not discard a user's mask.
    const picture = new Image();
    picture.src = api.apiURL('/view?' + new URLSearchParams({filename: data.filename, subfolder: data.subfolder, type: data.type}));
    await picture.decode();
    if (image.value !== previousImage || mask.value !== previousMask || source._alphaEditorOpen) {
        throw new Error(inpaintText("Исходник или маска изменились при загрузке. Ваши правки сохранены; нажмите кнопку снова."));
    }
    if (Array.isArray(image.options?.values) && !image.options.values.includes(data.image)) image.options.values.push(data.image);
    image.value = data.image;
    mask.value = '';
    source._alphaMaskSource = data.image;
    image.callback?.(data.image);
    // The custom source is not the native LoadImage class. Explicitly refresh its preview.
    source.imgs = [picture]; source.imageIndex = 0;
    source.setDirtyCanvas(true, true);
    source.graph?.change?.();
}

app.registerExtension({
    name: 'PNGInpaintV4.IterativeEditingV4',
    nodeCreated(node) {
        if (node.comfyClass === 'PNGV4InpaintResult') {
            const {button, status} = controls(node, 'continue_edit_controls');
            button.textContent = inpaintText("Продолжить редактирование");
            button.disabled = true;
            const saveButton = button.cloneNode(false);
            saveButton.textContent = inpaintText("Сохранить результат");
            Object.assign(saveButton.style,{background:'#247344',border:'1px solid #4caa70',color:'#fff'});
            button.after(saveButton);
            const prefixWidget = widget(node, 'filename_prefix');
            if (prefixWidget) prefixWidget.label = inpaintText("Имя файла при сохранении");
            status.textContent = inpaintText("Проходы хранятся в temp до перезапуска ComfyUI. Готовый PNG сохраняйте кнопкой «Сохранить результат».");
            const gallery=document.createElement('div');
            Object.assign(gallery.style,{display:'flex',gap:'6px',overflowX:'auto',flexShrink:'0'});button.before(gallery);
            const picker = document.createElement('select');
            picker.setAttribute('aria-label', inpaintText("Результат для продолжения")); picker.style.display = 'none';
            button.before(picker);
            // Vue's native preview store does not restore legacy node.imgs from saved workflows.
            // Show a persisted preview until the next execution supplies a native output preview.
            const restoredPreview = document.createElement('img');
            restoredPreview.alt = inpaintText("Прозрачный результат");
            Object.assign(restoredPreview.style, {display:'none', width:'100%', height:'550px', objectFit:'contain',
                backgroundColor:'#858585', backgroundImage:'conic-gradient(#999 25%, #777 0 50%, #999 0 75%, #777 0)', backgroundSize:'20px 20px'});
            const frame = document.createElement('div'); frame.append(restoredPreview);
            let restoredVisible = false;
            node.addDOMWidget('restored_result_preview', 'div', frame, {serialize:false, hideOnZoom:false,
                getMinHeight:()=>restoredVisible?550:0, getMaxHeight:()=>restoredVisible?550:0});
            let result = null, busy = false;
            const updateButtons = () => {
                button.disabled = saveButton.disabled = picker.disabled = busy || !result;
                for(const candidate of gallery.children)candidate.disabled=busy;
            };
            const viewURL = ref => api.apiURL('/view?' + new URLSearchParams({filename:ref.filename, subfolder:ref.subfolder, type:ref.type}));
            picker.onchange = () => {
                if(result){
                    result={...result,selected_index:Number(picker.value)||0};node.properties.inpaint_result_v4=result;
                    restoredVisible=true;restoredPreview.style.display='block';restoredPreview.src=viewURL(result.images[result.selected_index]);
                    for(const b of gallery.children){const active=Number(b.dataset.index)===result.selected_index;b.style.border=active?'3px solid #72c9a0':'3px solid transparent';b.setAttribute('aria-pressed',String(active));}
                    node.setDirtyCanvas(true,true);node.graph?.change?.();
                }
            };
            const receive = data => {
                if (!data?.images?.length || !data.images.every(i => i.sha256 && ['temp', 'output'].includes(i.type))) return;
                result = data;
                node.properties ??= {};
                node.properties.inpaint_result_v4 = data;
                picker.replaceChildren();
                data.images.forEach((im, index) => {
                    const option = document.createElement('option'); option.value = index;
                    option.textContent = `${index + 1} · ${im.filename}`; picker.append(option);
                });
                picker.value=String(Math.min(data.selected_index||0,data.images.length-1));
                gallery.replaceChildren();
                button.parentElement.dataset.height=data.images.length>1?'370':'170';
                if(data.images.length>1)data.images.forEach((ref,index)=>{
                    const b=document.createElement('button');b.type='button';b.dataset.index=index;
                    b.setAttribute('aria-label',`${inpaintText("Выбрать вариант ")}${index+1}`);b.style.padding='3px';b.style.cursor='pointer';
                    const im=document.createElement('img');im.src=viewURL(ref);im.alt=`${inpaintText("Вариант ")}${index+1}`;
                    Object.assign(im.style,{width:'120px',height:'140px',objectFit:'contain',background:'#777'});
                    const label=document.createElement('div');label.textContent=`${inpaintText("Вариант ")}${index+1}`;b.append(im,label);
                    b.onclick=()=>{if(busy)return;picker.value=String(index);picker.onchange();};gallery.append(b);
                });
                if(data.images.length>1)picker.onchange();
                picker.style.display = data.images.length > 1 ? 'block' : 'none';
                updateButtons();
                status.textContent = data.images.every(i => i.type === 'output')
                    ? inpaintText("PNG уже сохранён в output. Можно продолжить редактирование.")
                    : data.manual_alpha ? inpaintText("Прозрачность и локальные кисти обновлены без генерации. Готовый PNG можно сохранить или продолжить редактирование.")
                    : inpaintText("Временный результат готов. Продолжайте правку или сохраните готовый PNG в output.");
            };
            const executed = node.onExecuted;
            node.onExecuted = function(message) {
                executed?.apply(this, arguments);
                restoredVisible = false; restoredPreview.style.display = 'none';
                receive(message?.inpaint_result?.[0]);
            };
            const configured = node.onConfigure;
            node.onConfigure = function() {
                configured?.apply(this, arguments);
                receive(this.properties?.inpaint_result_v4);
                const saved = result;
                if (saved) {
                    restoredVisible = true; restoredPreview.style.display = 'block';
                    restoredPreview.src = viewURL(saved.images[Number(picker.value)||0]);
                }
                if (saved) Promise.allSettled(saved.images.map(async ref => {
                    const image = new Image();
                    image.src = viewURL(ref);
                    await image.decode(); return image;
                })).then(loaded => {
                    if (result !== saved) return;
                    const available=loaded.map((item,index)=>({item,index})).filter(x=>x.item.status==='fulfilled');
                    if(!available.length){
                        result = null; restoredVisible = false; restoredPreview.style.display = 'none'; updateButtons();
                        gallery.replaceChildren();picker.style.display='none';button.parentElement.dataset.height='170';
                        status.textContent = inpaintText("Результат недоступен: temp очищается при перезапуске ComfyUI. Загрузите сохранённый PNG или выполните новый проход.");
                        return;
                    }
                    if(available.length!==saved.images.length){
                        const selected=available.findIndex(x=>x.index===(saved.selected_index||0));
                        receive({...saved,images:available.map(x=>saved.images[x.index]),selected_index:Math.max(0,selected)});
                        restoredPreview.src=viewURL(result.images[result.selected_index||0]);
                        status.textContent=inpaintText("Доступные PNG восстановлены. Несохранённые временные варианты уже очищены.");
                    }
                    // Our selected preview is sufficient; do not duplicate it with a native image grid.
                    this.imgs=[];this.imageIndex=null;this.setDirtyCanvas(true,true);
                });
            };
            button.onclick = async event => {
                event.stopPropagation();
                if (!result || busy) return;
                const currentResult = result;
                const source = sourceForResult(node);
                const selected = result.images[Number(picker.value) || 0];
                try {
                    if (!source) throw new Error(inpaintText("Подключите transparent_png универсальной правки к этой ноде."));
                    if (result.source_node_id != null && String(source.id) !== String(result.source_node_id)) {
                        throw new Error(inpaintText("Подключение исходника изменилось после генерации. Выполните новый проход."));
                    }
                    if (source._alphaEditorOpen) throw new Error(inpaintText("Сначала закройте редактор маски."));
                    busy = true; updateButtons(); status.textContent = inpaintText("Подставляю результат в первую ноду…");
                    const original = widget(source, 'image').value;
                    const oldMask = widget(source, 'mask_data').value;
                    const data = await post('continue-edit', {image: selected, sha256: selected.sha256});
                    if (result !== currentResult || widget(source, 'image').value !== original || widget(source, 'mask_data').value !== oldMask || source._alphaEditorOpen) {
                        throw new Error(inpaintText("Вы успели изменить исходник или маску. Они сохранены; нажмите кнопку снова."));
                    }
                    await selectSource(source, data);
                    status.textContent = inpaintText("Результат уже в первой ноде. Открываю редактор кисти…");
                    await openMaskEditor(source);
                    status.textContent = source._alphaEditorOpen
                        ? inpaintText("Результат уже в первой ноде. Маска очищена — выделите следующую область в редакторе кисти.")
                        : inpaintText("Результат уже в первой ноде. Маска очищена. Откройте редактор кнопкой «Выделить область кистью».");
                } catch (error) {
                    status.textContent = error.message;
                } finally { busy = false; updateButtons(); }
            };
            saveButton.onclick = async event => {
                event.stopPropagation();
                if (!result || busy) return;
                const currentResult = result;
                const index = Number(picker.value) || 0;
                const selected = result.images[index];
                try {
                    busy = true; updateButtons(); status.textContent = inpaintText("Сохраняю прозрачный PNG в output…");
                    const data = await post('save-result', {image:selected, sha256:selected.sha256,
                        filename_prefix:prefixWidget?.value || result.filename_prefix || 'Inpaint_V4/Result'});
                    if (result !== currentResult) return;
                    // Persist a durable reference so the saved result can be reopened after restart.
                    node.graph?.beforeChange?.();
                    result = {...result, images:result.images.map((ref, i) => i === index
                        ? {filename:data.filename, subfolder:data.subfolder, type:data.type, sha256:data.sha256} : ref)};
                    node.properties.inpaint_result_v4 = result;
                    picker.options[index].textContent = `${index + 1} · ${data.filename}`;
                    if (restoredVisible) restoredPreview.src = viewURL(result.images[index]);
                    status.textContent = `${data.already_saved ? inpaintText("Уже сохранено") : inpaintText("Сохранено")}: output/${data.subfolder ? data.subfolder + '/' : ''}${data.filename}${inpaintText("\nПрозрачность и полный размер сохранены.")}`;
                    node.graph?.change?.();
                    node.graph?.afterChange?.();
                } catch (error) { status.textContent = error.message; }
                finally { busy = false; updateButtons(); }
            };
            return;
        }
        if (node.comfyClass !== 'PNGV4InpaintPromptAssistant') return;
        const labels = {request_ru: inpaintText("Что изменить — по-русски"), positive: inpaintText("Позитив — можно исправить"), negative: inpaintText("Негатив — можно исправить")};
        for (const w of node.widgets || []) if (labels[w.name]) w.label = labels[w.name];
        const {button, status} = controls(node, 'prepare_prompt_controls');
        button.textContent = inpaintText("Подготовить промпт");
        status.textContent = inpaintText("Grok получает только русский текст и режим правки. Запуск генерации не обращается к API. Готовые поля можно заполнять вручную.");
        let busy = false;
        button.onclick = async event => {
            event.stopPropagation();
            if (busy) return;
            try {
                const request = String(widget(node, 'request_ru').value || '').trim();
                if (!request) throw new Error(inpaintText("Напишите, что должно измениться в выделенной области."));
                const mode = promptMode(node);
                if (mode === 'Перекрасить без генерации') throw new Error(inpaintText("Для перекраски задайте цвет #RRGGBB в ноде правки. Grok не нужен."));
                const positiveBefore = widget(node, 'positive').value;
                const negativeBefore = widget(node, 'negative').value;
                busy = true; button.disabled = true; status.textContent = inpaintText("Готовлю позитив и негатив. Изображение не отправляется…");
                const answer = await post('inpaint-prompt', {request_ru: request, mode});
                if (String(widget(node, 'request_ru').value || '').trim() !== request || promptMode(node) !== mode ||
                    widget(node, 'positive').value !== positiveBefore || widget(node, 'negative').value !== negativeBefore) {
                    throw new Error(inpaintText("Текст, режим или промпты изменились во время запроса. Ваши правки сохранены. Нажмите кнопку снова; готовый ответ находится в кэше."));
                }
                for (const name of ['positive', 'negative']) {
                    const w = widget(node, name); w.value = answer[name]; w.callback?.(answer[name]);
                }
                status.textContent = answer.cached ? inpaintText("Промпт взят из кэша — нового обращения к API не было.") : inpaintText("Промпт готов. Следующие генерации и смена seed не вызывают Grok.");
                node.setDirtyCanvas(true, true); node.graph?.change?.();
            } catch (error) { status.textContent = error.message; }
            finally { busy = false; button.disabled = false; }
        };
    },
});
