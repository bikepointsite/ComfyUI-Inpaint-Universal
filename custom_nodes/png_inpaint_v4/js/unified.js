import { t as inpaintText, addLanguageSelector, language } from './language.js';
import { app } from '/scripts/app.js';
import { api } from '/scripts/api.js';

import { openMaskEditor as editor } from './mask_editor.js';
import { installModePanel } from './mode_panel.js';

const titles = {"1": ["1 · PNG и кисти", "1 · PNG and brushes"], "2": ["2 · Режим и усиления", "2 · Mode and enhancements"], "4": ["Модель локального восстановления", "Fooocus inpaint patch"], "5": ["3 · Сохранить или доработать", "3 · Save or continue editing"], "6": ["Слева исходник · справа результат", "Source (left) · result (right)"], "7": ["Начало работы", "Getting started"], "8": ["Помощник по промптам", "Prompt assistant"], "11": ["Модель SDXL", "SDXL checkpoint"]};
const notes = ["Перед первым запуском выберите свой чекпойнт в ноде «Модель SDXL» и сохраните workflow. На тестовом лоскуте красным отмечена торчащая нить. Запустите мягкую ретушь и нажмите «Сохранить результат».", "Before the first run, choose your own SDXL checkpoint in the SDXL checkpoint node and save the workflow. The red mask marks a loose thread on the fabric sample. Run soft retouch, then choose Save result to keep the PNG."];
function localizeGraphNode(node) {
    const id = node.properties?.inpaintPortableTitle;
    if (!Object.hasOwn(titles,id)) return;
    const index = language === 'en' ? 1 : 0;
    if (titles[id].includes(node.title)) node.title = titles[id][index];
    const note = id === '7' && node.widgets?.[0];
    if (note && notes.includes(note.value)) note.value = notes[index];
}
app.registerExtension({
    name:'PNGInpaintV4.UnifiedInpaint',
    beforeRegisterNodeDef(nodeType, definition) {
        if (!definition.name.startsWith('PNGV4') || language !== 'en') return;
        definition.display_name = inpaintText(definition.display_name);
        if (definition.description) definition.description = inpaintText(definition.description);
        for (const inputs of Object.values(definition.input || {})) {
            for (const spec of Object.values(inputs)) {
                const options = spec?.[1];
                if (options?.tooltip) options.tooltip = inpaintText(options.tooltip);
            }
        }
    },
    afterConfigureGraph(){
        for(const node of app.graph?._nodes || []) { localizeGraphNode(node); node._v4Refresh?.(); }
    },
    nodeCreated(node){
        if(node.comfyClass==='PNGV4UniversalInpaint'){installModePanel(node);return;}
        if(node.comfyClass!=='PNGV4AlphaInpaintSource')return;
        addLanguageSelector(node);
        const mask=node.widgets.find(w=>w.name==='mask_data');
        if(mask){mask.type='converted-widget';mask.computeSize=()=>[0,-4];mask.hidden=true;mask.options={...mask.options,hidden:true};}
        const image=node.widgets.find(w=>w.name==='image');
        const configured=node.onConfigure;node.onConfigure=function(){
            configured?.apply(this,arguments);
            if(image?.value&&Array.isArray(image.options?.values)&&!image.options.values.includes(image.value))image.options.values.push(image.value);
        };
        if(image){const callback=image.callback;image.callback=function(value){const changed=node._alphaMaskSource && node._alphaMaskSource!==value;const result=callback?.apply(this,arguments);if(changed&&mask)mask.value='';node._alphaMaskSource=value;return result;};}
        node.addWidget('button',inpaintText("Загрузить PNG с компьютера"),null,()=>{
            const chooser=document.createElement('input');chooser.type='file';chooser.accept='image/png';chooser.style.display='none';document.body.append(chooser);
            chooser.oncancel=()=>chooser.remove();
            chooser.onchange=async()=>{
                const file=chooser.files?.[0];if(!file){chooser.remove();return;}
                try{
                    const form=new FormData();form.append('image',file);form.append('type','input');form.append('overwrite','false');
                    const response=await api.fetchApi('/upload/image',{method:'POST',body:form});
                    if(!response.ok)throw new Error(inpaintText("Не удалось загрузить PNG"));
                    const data=await response.json();const value=(data.subfolder?data.subfolder+'/':'')+data.name;
                    if(Array.isArray(image.options?.values)&&!image.options.values.includes(value))image.options.values.push(value);
                    image.value=value;mask.value='';node._alphaMaskSource=value;image.callback?.(value);node.setDirtyCanvas(true,true);
                }catch(error){alert(error.message);}finally{chooser.remove();}
            };
            chooser.click();
        },{serialize:false});
        node.addWidget('button',inpaintText("Выделить область кистью"),null,()=>editor(node),{serialize:false});
    }
});
