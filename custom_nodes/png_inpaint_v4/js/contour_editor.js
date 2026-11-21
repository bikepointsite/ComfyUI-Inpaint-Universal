import { t as inpaintText } from './language.js';
import {traceAlphaContours,nearestVertex,selectArc,bendArc,insideAlpha,validArc,smoothArc,strongContourIndices,displayContourIndices} from './contour_paths.js';
import {alphaIsolines,matchingRawArc} from './alpha_isoline.js';
import {bendPolyline} from './elastic_curve.js';
import {slider,help} from './editor_ui.js';

export function installContourEditor(host,parent){
    const {element,button,rowStyle,canvas,width,height}=host;
    const panel=element('div',parent,{...rowStyle,flexBasis:'100%'});
    const apply=button(panel,inpaintText("Применить контур"),applyContour,{background:'#247344',borderColor:'#4caa70'});
    const smoothing=button(panel,inpaintText("Сгладить участок"),smoothSelection);
    const straighten=button(panel,inpaintText("Соединить A—B прямой"),()=>{
        if(!hasArc()||drag)return;
        const p=current(),a=p[0],b=p.at(-1);
        let next=p.map((_,i)=>i===0?a.slice():i===p.length-1?b.slice():a.map((v,k)=>v+(b[k]-v)*i/(p.length-1)));
        if(host.fitInwardContour)host.update();
        if(!check(next,true)){
            next=host.fitInwardContour&&fitSection(true);
            if(!next){host.message(inpaintText("Прямая вышла бы за силуэт или задела соседнюю границу. Выберите более короткий участок."),true);return;}
            host.message(inpaintText("Прямая вышла бы на прозрачность. Голубым показан вариант с плавным отступом внутрь. Проверьте его и нажмите «Применить контур»."));
        }
        remember();draft.base=next;draft.handles=[];draft.selected=-1;refresh();
    });
    const addPoint=button(panel,inpaintText("Добавить опорную точку"),()=>{addingPoint=!addingPoint;sync();host.message(addingPoint?inpaintText("Кликните по линии: появится закреплённая опорная точка."):inpaintText("Тяните любую часть линии; новые точки не добавляются."));});
    const flip=button(panel,inpaintText("Другой участок"),()=>{remember();draft.other=!draft.other;chooseArc();refresh();});
    const remove=button(panel,inpaintText("Удалить точку"),()=>{
        if(draft.selected<0)return;remember();draft.handles.splice(draft.selected,1);draft.selected=-1;refresh();
    });
    const reset=button(panel,inpaintText("Сбросить участок"),()=>{resetDraft();refresh();host.update();});
    const status=element('span',panel,{fontSize:'12px',color:'#b7d3df'});
    const displayRow=element('div',panel,{...rowStyle,flexBasis:'100%'});
    const weakLabel=element('label',displayRow,{display:'flex',alignItems:'center',gap:'6px'});
    const weak=element('input',weakLabel);weak.type='checkbox';weak.setAttribute('aria-label',inpaintText("Показывать мелкие и слабые границы"));
    const weakText=element('span',weakLabel);weakText.textContent=inpaintText("Показывать мелкие и слабые границы");
    weakLabel.title=inpaintText("Показывает и мелкие отдельные границы при выбранном пороге видимости. Это только показ линий: PNG не очищается и его альфа не меняется.");
    const legend=element('span',displayRow,{fontSize:'12px',color:'#d5e3ea'});
    legend.textContent=inpaintText("Белая — граница PNG · жёлтая — выбранный участок · голубая — новый край");
    const threshold=slider(displayRow,inpaintText("Видимая граница, %"),{min:1,max:99,step:1,value:50,format:v=>v+'%',description:inpaintText("Выше — линия ближе к непрозрачной части; ниже — учитывается слабый ореол. Меняется только линия предпросмотра. PNG меняется лишь после применения выбранного участка."),onChange:()=>{if(active&&!draft.first)activate();}});
    const reach=slider(displayRow,inpaintText("Ширина изгиба, %"),{min:host.editor41?1:10,max:100,step:1,value:55,description:inpaintText("Меньше — локальная вмятина, больше — широкая плавная дуга. Концы A и B закреплены.")});
    const radius=host.fitInwardContour?slider(displayRow,inpaintText("Радиус сглаживания, px"),{min:1,max:48,step:1,value:8,format:null,commitOnBlur:true,
        description:inpaintText("Размер неровностей вдоль линии в пикселях PNG. Для более крупных выступов увеличьте радиус и нажмите «Сгладить участок». Опорные точки сохраняются.")}):null;
    let image=null,boundaryAlpha=null,rawLoops=[],loops=[],strong=[],draft=empty(),history=[],drag=null,hover=null,valid=true,previewFrame=0,active=false,disposed=false,addingPoint=false;
    weak.onchange=()=>{hover=null;refresh();};
    function shownIndices(){return weak.checked?loops.map((_,i)=>i):strong;}
    function nearestBoundary(p){
        const indices=draft.first?[draft.first.loop]:shownIndices();
        const nearest=nearestVertex(indices.map(i=>loops[i]),p);
        if(nearest)nearest.loop=indices[nearest.loop];return nearest;
    }
    function empty(){return {first:null,second:null,other:false,arc:null,cutArc:null,base:null,handles:[],selected:-1};}
    const hasArc=()=>!!draft.arc;
    const current=()=>hasArc()?draft.base:[];
    const scale=()=>canvas.getBoundingClientRect().width/width;
    function remember(){history.push(structuredClone(draft));if(history.length>16)history.shift();}
    function cancelFrame(){if(previewFrame)cancelAnimationFrame(previewFrame);previewFrame=0;}
    function resetDraft(){cancelFrame();draft=empty();history=[];drag=null;valid=true;host.previewContour(null);}
    function activate(){
        active=true;resetDraft();hover=null;image=host.contourImage();
        try{
            rawLoops=traceAlphaContours(image.data,width,height);
            const level=Number(threshold.value)*2.55;
            loops=alphaIsolines(image.data,width,height,level);
            strong=displayContourIndices(loops,loops.map((_,i)=>i));
            boundaryAlpha=new Uint8ClampedArray(image.data);
            for(let i=3;i<boundaryAlpha.length;i+=4)boundaryAlpha[i]=boundaryAlpha[i]>=level?255:0;
        }
        catch(error){loops=[];strong=[];host.message(error.message,true);}
        sync();host.refresh();
    }
    function chooseArc(){
        const arc=selectArc(loops[draft.first.loop],draft.first.index,draft.second.index,draft.other);
        if(arc.points.length<8||arc.points.length>6000){draft.arc=null;draft.base=null;draft.handles=[];host.message(inpaintText("Выберите участок длиной от 8 до 6000 пикселей."),true);return;}
        draft.arc=arc;draft.base=arc.points.map(p=>p.slice());
        // Include only the corresponding old fringe in the confirmed local cut.
        // Thresholding must never trim the rest of the PNG.
        draft.cutArc=matchingRawArc(loops[draft.first.loop],arc,rawLoops);
        draft.handles=[];draft.selected=-1;valid=true;addingPoint=false;
    }
    function check(points,full=false){
        // Subpixel raster corners / one-pixel holes must not lock the whole arc.
        // The final erasure is intersected with actual alpha in maskFor: it can
        // never add opacity, even where the guide touches this 0.75px tolerance.
        return validArc(points,draft.arc.points,boundaryAlpha,width,height,loops,draft.first.loop,draft.arc.indices,full,{pixelTolerance:.75,ignoreMicroHoles:true});
    }
    function maskFor(points){
        const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');
        ctx.fillStyle='white';ctx.beginPath();ctx.moveTo(...draft.cutArc[0]);
        for(const p of draft.cutArc)ctx.lineTo(...p);
        for(const p of points.slice().reverse())ctx.lineTo(...p);ctx.closePath();ctx.fill('evenodd');
        const mask=ctx.getImageData(0,0,width,height),protection=host.contourProtection();
        for(let i=0;i<mask.data.length;i+=4){
            const v=protection[i]||!image.data[i+3]?0:mask.data[i+3];
            mask.data[i]=mask.data[i+1]=mask.data[i+2]=v;mask.data[i+3]=255;
        }return mask;
    }
    function updatePreview(){
        previewFrame=0;if(disposed||!active)return;
        if(!hasArc()){host.previewContour(null);return;}
        host.previewContour(maskFor(current()));
    }
    function refresh(){sync();host.refresh();if(!previewFrame)previewFrame=requestAnimationFrame(updatePreview);}
    function sync(){
        panel.style.display=active?'flex':'none';
        const arc=hasArc();
        apply.disabled=!arc||!!drag||!valid;
        smoothing.disabled=!arc||!!drag;flip.disabled=!draft.second||!!drag;
        straighten.disabled=addPoint.disabled=!arc||!!drag;
        addPoint.setAttribute('aria-pressed',String(addingPoint));
        addPoint.textContent=addingPoint?inpaintText("Кликните для добавления точки"):inpaintText("Добавить опорную точку");
        remove.disabled=!arc||draft.selected<0||!!drag;reset.disabled=!draft.first||!!drag;
        status.textContent=!loops.length?inpaintText("Нет границы: уменьшите порог"):!draft.first?inpaintText("1. Выберите начало A"):!draft.second?inpaintText("2. Выберите конец B"):!arc?inpaintText("Выберите другой участок"):inpaintText("3. Тяните линию внутрь · концы закреплены");
        weak.disabled=!!draft.first;
        if(radius)radius.disabled=radius.range.disabled=!!drag;
        threshold.disabled=threshold.range.disabled=!!draft.first;reach.disabled=reach.range.disabled=!!drag;
        weakText.textContent=`${inpaintText("Показывать мелкие и слабые границы")}${loops.length>strong.length?' ('+(loops.length-strong.length)+')':''}`;
    }
    function down(e,p){
        if(!active)return false;
        if(!hasArc()){
            const nearest=nearestBoundary(p);
            if(!nearest||nearest.distance>14/scale()){host.message(inpaintText("Кликните по тонкой линии границы альфы."),true);return true;}
            if(draft.first)nearest.loop=draft.first.loop;
            if(draft.first&&nearest.index===draft.first.index)return true;
            remember();if(!draft.first)draft.first=nearest;else{draft.second=nearest;chooseArc();}refresh();return true;
        }
        const points=current();let index=-1,best=10/scale();
        draft.handles.forEach((h,i)=>{const q=points[h.index],d=Math.hypot(p[0]-q[0],p[1]-q[1]);if(d<best){best=d;index=i;}});
        const initial=structuredClone(draft);
        if(index<0){
            const nearest=nearestVertex([points],p);
            if(!nearest||nearest.distance>12/scale()||nearest.index<2||nearest.index>points.length-3){host.message(inpaintText("Тяните любую часть голубой линии между A и B."),true);return true;}
            if(addingPoint){
                if(draft.handles.length>=24){host.message(inpaintText("До 24 опорных точек. Удалите лишнюю."),true);return true;}
                remember();draft.handles.push({index:nearest.index});draft.selected=draft.handles.length-1;addingPoint=false;refresh();return true;
            }
            index=nearest.index;
        }else{draft.selected=index;index=draft.handles[index].index;}
        if(addingPoint){addingPoint=false;refresh();return true;}
        history.push(initial);if(history.length>16)history.shift();
        drag={id:e.pointerId,start:p,index,initial};
        canvas.setPointerCapture(e.pointerId);refresh();return true;
    }
    function move(e,p){
        if(!active)return false;
        if(!drag){hover=hasArc()?nearestVertex([current()],p):nearestBoundary(p);host.refresh();return true;}
        if(e.pointerId!==drag.id)return true;
        const old=draft.base,delta=[p[0]-drag.start[0],p[1]-drag.start[1]];
        const desired=bendPolyline(drag.initial.base,drag.index,delta,Number(reach.value)/100,draft.handles.map(h=>h.index).filter(i=>i!==drag.index));
        draft.base=desired;
        if(!check(desired)){
            let low=0,high=1;
            for(let i=0;i<10;i++){const t=(low+high)/2;const next=old.map((q,j)=>q.map((v,k)=>v+(desired[j][k]-v)*t));if(check(next))low=t;else high=t;}
            draft.base=old.map((q,j)=>q.map((v,k)=>v+(desired[j][k]-v)*low));
        }
        refresh();return true;
    }
    function end(e,p){
        if(!active)return false;if(!drag||drag.id!==e.pointerId)return true;
        if(e.type==='pointerup')move(e,p);
        const saved=drag;drag=null;
        if(e.type!=='pointerup'){
            draft=saved.initial;history.pop();
        }else if(!check(current(),true)){
            // Keep the usable part of an inward drag instead of snapping the
            // complete edit back when its last pixels touch another boundary.
            const desired=draft.base;
            const at=t=>{draft.base=saved.initial.base.map((p,j)=>p.map((v,k)=>v+(desired[j][k]-v)*t));return check(current(),true);};
            let low=0,high=1;
            for(let step=15;step>=0;step--)if(at(step/16)){low=step/16;high=(step+1)/16;break;}
            for(let step=0;step<10;step++){const t=(low+high)/2;if(at(t))low=t;else high=t;}
            at(low);
            if(!check(current(),true)){draft=saved.initial;history.pop();}
            host.message(inpaintText("Сдвиг ограничен перед соседней границей или пересечением линии. Можно добавить ещё опорную точку."));
        }
        if(canvas.hasPointerCapture(saved.id))canvas.releasePointerCapture(saved.id);
        valid=true;refresh();return true;
    }
    function fitSection(straight){
        const pins=straight?[]:draft.handles.map(h=>h.index);
        const candidate=host.fitInwardContour({points:current(),arc:draft.arc,rgba:boundaryAlpha,width,height,
            radius:Number(radius.range.value),pins,straight});
        return candidate&&check(candidate,true)?candidate:null;
    }
    function smoothSelection(){
        if(!hasArc()||drag)return;
        if(host.fitInwardContour){
            const candidate=fitSection(false);
            if(!candidate){host.message(inpaintText("На этом радиусе линия выходит за силуэт или задевает другую границу. Уменьшите радиус либо поставьте A и B ближе к неровности."),true);return;}
            remember();draft.base=candidate;host.update();refresh();return;
        }
        let points=current();for(let pass=0;pass<5;pass++)points=smoothArc(points,boundaryAlpha,width,height);
        if(!check(points,true)){host.message(inpaintText("Здесь сглаживание затронет соседний контур. Сместите опорные точки вручную."),true);return;}
        remember();draft.base=points;refresh();
    }
    function applyContour(){
        if(!hasArc()||drag)return;const points=current();
        if(!check(points,true)){host.message(inpaintText("Участок пересекает соседнюю границу. Скорректируйте изгиб."),true);return;}
        const mask=maskFor(points);
        if(!mask.data.some((v,i)=>i%4===0&&v>0)){host.message(inpaintText("Сначала потяните выбранную линию внутрь."),true);return;}
        cancelFrame();host.previewContour(null);host.acceptContour(mask);activate();
        host.message(inpaintText("Контур применён. Изменена только альфа; «Отменить штрих» вернёт весь участок."));
    }
    function draw(c,s){
        if(!active)return;
        c.save();c.lineJoin='round';c.lineCap='round';
        function path(points,color,lineWidth,closed=false,dash=[]){
            if(!points.length)return;c.beginPath();c.moveTo(...points[0]);for(const p of points)c.lineTo(...p);if(closed)c.closePath();
            c.strokeStyle=color;c.lineWidth=lineWidth/s;c.setLineDash(dash.map(v=>v/s));c.stroke();c.setLineDash([]);
        }
        const shown=shownIndices();
        for(const i of shown)path(loops[i],'#10161d',4.5,true);
        for(const i of shown)path(loops[i],'#f4faff',2,true);
        if(hasArc()){
            path(draft.arc.points,'#ffc66c',3,false,[6,4]);const points=current();path(points,'#082b35',6);path(points,'#25ddf5',3);
            draft.handles.forEach((h,i)=>{const p=points[h.index];c.beginPath();c.arc(...p,6/s,0,Math.PI*2);c.fillStyle=i===draft.selected?'#25ddf5':'#24333d';c.fill();c.strokeStyle='#fff';c.lineWidth=1.5/s;c.stroke();});
        }
        for(const [anchor,text] of [[draft.first,'A'],[draft.second,'B']])if(anchor){
            const p=loops[anchor.loop][anchor.index];c.beginPath();c.arc(...p,6/s,0,Math.PI*2);c.fillStyle='#77ec9c';c.fill();c.strokeStyle='#16221a';c.lineWidth=1.5/s;c.stroke();
            c.font=`bold ${14/s}px sans-serif`;c.lineWidth=4/s;c.strokeStyle='#10161d';c.strokeText(text,p[0]+10/s,p[1]-9/s);c.fillStyle='#fff';c.fillText(text,p[0]+10/s,p[1]-9/s);
        }
        if(hover&&hover.distance<14/s&&!drag){c.beginPath();c.arc(...hover.point,3/s,0,Math.PI*2);c.fillStyle='#fff';c.fill();}c.restore();
    }
    return {activate,sync,down,move,end,draw,
        get pending(){return !!draft.first;},get busy(){return !!drag;},
        deactivate(){active=false;resetDraft();sync();},
        undo(){if(drag)return true;if(history.length){draft=history.pop();valid=true;if(host.fitInwardContour)host.update();refresh();return true;}return false;},
        escape(){if(drag){end({type:'pointercancel',pointerId:drag.id},drag.start);return true;}if(draft.first){resetDraft();refresh();return true;}return false;},
        dispose(){disposed=true;cancelFrame();},
        hint:()=> inpaintText("Выберите A и B, затем тяните любую часть голубой линии внутрь. Обычный клик не добавляет точку. Можно соединить A—B прямой и изогнуть её. Меняется только прозрачность выбранного участка."),
    };
}
