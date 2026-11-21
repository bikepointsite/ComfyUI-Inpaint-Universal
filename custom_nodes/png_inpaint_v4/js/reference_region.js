import { t as inpaintText } from './language.js';
import {referenceLocation} from './reference_preview.js';

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function bounds(points) {
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// A square input keeps patch proportions when CLIP preprocesses its reference.
// Outside a lasso (including padding) stays transparent for Comfy's neutral matte.
export function cutReference(image, selection) {
    const [x, y, right, bottom] = bounds(selection.points);
    const w = right - x, h = bottom - y, side = Math.max(w, h);
    if (Math.min(w, h) < 1) throw new Error(inpaintText("Выделите участок побольше."));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(1024, Math.ceil(side));
    const ctx = canvas.getContext('2d'), scale = canvas.width / side;
    ctx.scale(scale, scale);
    ctx.translate((side-w)/2-x, (side-h)/2-y);
    ctx.beginPath();
    selection.points.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
    ctx.closePath(); ctx.clip();
    ctx.drawImage(image, x, y, w, h, x, y, w, h);
    return canvas;
}

export function installReferenceRegion(parent, {apiURL, change, expand, locked}) {
    const make = (tag, container, css = '') => {
        const el = document.createElement(tag); el.style.cssText = css;
        container.append(el); return el;
    };
    const root = make('section', parent, 'display:none;flex:1;min-width:0;min-height:0;flex-direction:column;gap:6px');
    root.setAttribute('aria-label', inpaintText("Редактор картинки образца"));
    const top = make('div', root, 'display:flex;gap:8px;align-items:center;flex-wrap:wrap');
    const title = make('strong', top); title.textContent = inpaintText("Образец");
    const button = (row, label, fn) => {
        const el = make('button', row, 'color:#f1f5f7;background:#34404b;border:1px solid #738594;border-radius:4px;padding:5px 9px;cursor:pointer');
        el.type = 'button'; el.textContent = label; el.onclick = fn; return el;
    };
    let full = false;
    const expandButton = button(top, inpaintText("Развернуть образец"), () => setExpanded(!full));
    function setExpanded(next) {
        full = next; expandButton.textContent = full ? inpaintText("Показать оба изображения") : inpaintText("Развернуть образец"); expand(full);
    }
    const bar = make('div', root, 'display:flex;gap:5px;align-items:center;flex-wrap:wrap');
    let tool = 'square', selection = null, gesture = null, pending = null, current = '', image = null;
    let vertices = [];
    let zoom = 1, dx = 0, dy = 0, frameId = 0, sample = null;
    const square = button(bar, inpaintText("Квадрат"), () => selectTool('square'));
    const lasso = button(bar, inpaintText("Лассо"), () => selectTool('lasso'));
    const finish = button(bar, inpaintText("Замкнуть контур"), () => finishLasso());
    const clear = button(bar, inpaintText("Вся картинка"), () => commit(null));
    const minus = button(bar, '−', () => setZoom(zoom / 1.4));
    minus.setAttribute('aria-label', inpaintText("Отдалить образец"));
    const fit = button(bar, inpaintText("Вписать"), () => {zoom=1; dx=dy=0; draw();});
    const plus = button(bar, '+', () => setZoom(zoom * 1.4));
    plus.setAttribute('aria-label', inpaintText("Приблизить образец"));
    const percent = make('output', bar);
    const view = make('div', root, 'position:relative;flex:1;min-height:90px;overflow:hidden;touch-action:none;background:repeating-conic-gradient(#777 0% 25%,#999 0% 50%) 0/20px 20px;cursor:crosshair');
    view.setAttribute('aria-label',inpaintText("Выбор участка на образце"));
    const overlay = make('canvas', view, 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none');
    const bottom = make('div', root, 'display:flex;align-items:center;gap:9px;min-height:64px');
    const thumb = make('div', bottom, 'flex:none');
    const info = make('div',bottom,'font-size:12px');
    const fileName = make('strong', info);
    const message = make('div', info); message.setAttribute('role','status');

    function selectTool(next) {
        tool = next;
        vertices=[];pending=null;finish.hidden=true;draw();
        for (const [el, active] of [[square,tool==='square'],[lasso,tool==='lasso']]) {
            el.setAttribute('aria-pressed',String(active)); el.style.background = active?'#285e76':'#34404b';
        }
        hint();
    }
    function hint() {
        if (!image) return;
        message.textContent = (selection ? inpaintText("Выбран фрагмент. ") : inpaintText("Выбрана вся картинка. ")) +
            (tool==='square' ? inpaintText("Кликните для квадрата или растяните его мышью.") : inpaintText("Обведите деталь мышью или отметьте её края кликами и замкните контур.")) +
            inpaintText(" Колесо — масштаб, зажатое колесо — перемещение.");
    }
    function refreshThumb() {
        sample = selection && image ? cutReference(image, selection) : null;
        thumb.replaceChildren();
        if (sample) {
            sample.style.cssText='width:64px;height:64px;display:block;background:#7f7f7f';
            sample.setAttribute('aria-label',inpaintText("Фрагмент для генерации")); thumb.append(sample);
        }
        clear.disabled = !selection; hint();
    }
    function commit(next) {
        if (locked()) return;
        vertices=[];pending=null;finish.hidden=true;
        selection = next; refreshThumb(); change(selection); draw();
    }
    function transform() {
        const w=view.clientWidth, h=view.clientHeight;
        const s=Math.min(w/image.naturalWidth,h/image.naturalHeight)*zoom;
        return {s,x:(w-image.naturalWidth*s)/2+dx,y:(h-image.naturalHeight*s)/2+dy};
    }
    function constrain() {
        if (!image || !view.clientWidth || !view.clientHeight) return;
        const {s}=transform();
        const maxX=zoom===1?0:(image.naturalWidth*s+view.clientWidth)/2-16;
        const maxY=zoom===1?0:(image.naturalHeight*s+view.clientHeight)/2-16;
        dx=clamp(dx,-maxX,maxX); dy=clamp(dy,-maxY,maxY);
    }
    function draw() {
        if (frameId) return;
        frameId=requestAnimationFrame(()=>{
            frameId=0;
            const w=view.clientWidth, h=view.clientHeight;
            if (!image || !w || !h) return;
            constrain();
            const {s,x,y}=transform();
            Object.assign(image.style,{width:image.naturalWidth*s+'px',height:image.naturalHeight*s+'px',left:x+'px',top:y+'px'});
            const dpr=window.devicePixelRatio||1;
            if(overlay.width!==Math.round(w*dpr)||overlay.height!==Math.round(h*dpr)){
                overlay.width=Math.round(w*dpr);overlay.height=Math.round(h*dpr);
            }
            const ctx=overlay.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
            const points=pending?.points || (vertices.length ? vertices : selection?.points);
            if(points?.length) {
                ctx.beginPath();points.forEach(([px,py],i)=> i?ctx.lineTo(x+px*s,y+py*s):ctx.moveTo(x+px*s,y+py*s));
                ctx.closePath();ctx.strokeStyle='#162025';ctx.lineWidth=4;ctx.stroke();
                ctx.strokeStyle='#ffda66';ctx.lineWidth=2;ctx.stroke();
            }
            percent.textContent=Math.round(zoom*100)+'%';
        });
    }
    function setZoom(next,x=view.clientWidth/2,y=view.clientHeight/2) {
        if (!image || gesture) return;
        next=clamp(next,1,16);
        const ratio=next/zoom, cx=x-view.clientWidth/2, cy=y-view.clientHeight/2;
        dx=cx-(cx-dx)*ratio;dy=cy-(cy-dy)*ratio;zoom=next;constrain();draw();
    }
    function point(e, clip=true) {
        const r=view.getBoundingClientRect(), {s,x,y}=transform();
        const px=(e.clientX-r.left-x)/s, py=(e.clientY-r.top-y)/s;
        if(!clip && (px<0 || py<0 || px>image.naturalWidth || py>image.naturalHeight)) return null;
        return [clamp(px,0,image.naturalWidth),clamp(py,0,image.naturalHeight)];
    }
    function squareAt(a,b,click) {
        const w=image.naturalWidth,h=image.naturalHeight;
        let size=click?Math.min(128,w,h):Math.min(Math.max(Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1])),w,h);
        const x=clamp(click?a[0]-size/2:b[0]<a[0]?a[0]-size:a[0],0,w-size);
        const y=clamp(click?a[1]-size/2:b[1]<a[1]?a[1]-size:a[1],0,h-size);
        return {kind:'square',points:[[x,y],[x+size,y],[x+size,y+size],[x,y+size]]};
    }
    view.onwheel=e=>{
        e.preventDefault();e.stopPropagation();const r=view.getBoundingClientRect();
        setZoom(zoom*Math.exp(-clamp(e.deltaY*(e.deltaMode===1?16:1),-240,240)*.003),e.clientX-r.left,e.clientY-r.top);
    };
    view.onauxclick=e=>{if(e.button===1)e.preventDefault();};
    view.onpointerdown=e=>{
        if(!image || gesture || locked() || (e.button!==0&&e.button!==1))return;
        const a=point(e,false);if(!a && e.button===0)return;
        e.preventDefault();e.stopPropagation();view.setPointerCapture(e.pointerId);
        gesture={id:e.pointerId,pan:e.button===1,dragged:false,a,sx:e.clientX,sy:e.clientY,dx,dy};
        if(gesture.pan){view.style.cursor='grabbing';return;}
        pending=tool==='square'?squareAt(a,a,true):{kind:'lasso',points:[...vertices,a]};draw();
    };
    function advance(e) {
        if (!gesture || e.pointerId!==gesture.id) return;
        if(gesture.pan){dx=gesture.dx+e.clientX-gesture.sx;dy=gesture.dy+e.clientY-gesture.sy;constrain();draw();return;}
        const p=point(e);
        // A hand-drawn loop often finishes exactly where it began.
        if(Math.hypot(e.clientX-gesture.sx,e.clientY-gesture.sy)>=3)gesture.dragged=true;
        if(tool==='square') pending=squareAt(gesture.a,p,Math.hypot(e.clientX-gesture.sx,e.clientY-gesture.sy)<3);
        else {
            const pts=pending.points,last=pts[pts.length-1];
            if(Math.hypot(last[0]-p[0],last[1]-p[1])*transform().s>=1 && pts.length<12000)pts.push(p);
        }
        draw();
    }
    view.onpointermove=advance;
    function finishLasso() {
        if(vertices.length<3)return;
        const next={kind:'lasso',points:vertices};acceptRegion(next);
    }
    function acceptRegion(next) {
        if(next.points.length<3)return;
        const [x,y,r,b]=bounds(next.points);
        const area = Math.abs(next.points.reduce((sum,[px,py],i,pts)=>{
            const [nx,ny]=pts[(i+1)%pts.length];return sum+px*ny-nx*py;
        },0))/2;
        if(r-x>=1&&b-y>=1&&area>=1){commit(next);return;}
        message.textContent=inpaintText("Участок слишком узкий. Обведите площадь вокруг детали.");
    }
    function stop(e,accept) {
        if(!gesture || e.pointerId!==gesture.id)return;
        if(accept)advance(e);
        const wasClick=!gesture.pan&&!gesture.dragged;
        const next=pending;gesture=pending=null;view.style.cursor='crosshair';
        if(view.hasPointerCapture(e.pointerId))view.releasePointerCapture(e.pointerId);
        if(accept&&next){
            if(next.kind==='lasso'&&wasClick){
                if(vertices.length<12000)vertices.push(point(e));
                finish.hidden=false;finish.disabled=vertices.length<3;clear.disabled=false;
                message.textContent=inpaintText("Точек: ")+vertices.length+inpaintText(". Добавьте точки и нажмите «Замкнуть контур».");
            }else acceptRegion(next);
        }
        draw();
    }
    view.onpointerup=e=>stop(e,true);view.onpointercancel=e=>stop(e,false);view.onlostpointercapture=e=>stop(e,false);
    const observer=new ResizeObserver(draw);observer.observe(view);selectTool('square');
    let loading=null;
    return {
        root, get busy(){return !!gesture;}, get unfinished(){return vertices.length>0;},
        focusSelection(){selectTool('lasso');setExpanded(true);},
        collapse(){if(full)setExpanded(false);},
        update(file, savedSelection, visible) {
            root.style.display=visible?'flex':'none';
            if(!visible && full)setExpanded(false);
            if(!visible && vertices.length){vertices=[];pending=null;finish.hidden=true;hint();draw();}
            if(!visible || (file===current && selection===savedSelection))return;
            selection=savedSelection;
            if(file===current){refreshThumb();draw();return;}
            current=file;vertices=[];finish.hidden=true;pending=gesture=null; image?.remove();image=null;loading=null;thumb.replaceChildren();sample=null;
            overlay.getContext('2d').clearRect(0,0,overlay.width,overlay.height);
            zoom=1;dx=dy=0;percent.textContent='100%';
            const loc=referenceLocation(file);fileName.textContent=loc.filename;message.textContent=inpaintText("Открываю образец…");
            const next=new Image();loading=next;next.alt=inpaintText("Образец: ")+loc.filename;
            next.style.cssText='display:block;position:absolute;max-width:none;max-height:none;min-width:0;min-height:0;pointer-events:none;user-select:none;object-fit:contain';
            next.onload=()=>{if(loading!==next)return;image=next;view.prepend(image);refreshThumb();draw();};
            next.onerror=()=>{if(loading===next)message.textContent=inpaintText("Не удалось открыть образец. Загрузите его заново.");};
            next.src=apiURL('/view?'+new URLSearchParams(loc));
        },
        blob() {
            if(!sample)throw new Error(inpaintText("Дождитесь загрузки выбранного фрагмента."));
            return new Promise((resolve,reject)=>sample.toBlob(blob=>blob?resolve(blob):reject(new Error(inpaintText("Не удалось подготовить фрагмент."))),'image/png'));
        },
        dispose(){loading=null;observer.disconnect();cancelAnimationFrame(frameId);}
    };
}
