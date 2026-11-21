import { t as inpaintText } from '/extensions/png_inpaint_v4/language.js';
import { sampleCurve } from "/extensions/png_inpaint_v4/brush_paths.js";

const dist = (a,b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
const clamp = (x,lo,hi) => Math.max(lo,Math.min(hi,x));

function nearest(points, p, start=0) {
    let index=start, distance=Infinity;
    for(let i=start;i<points.length;i++) {
        const d=dist(points[i],p);
        if(d<distance){index=i;distance=d;}
    }
    return {index,distance};
}

function resample(points, spacing) {
    if(points.length<2)return points.slice();
    const out=[points[0]];
    let left=spacing;
    for(let i=1;i<points.length;i++){
        const a=points[i-1],b=points[i],length=dist(a,b);
        for(;left<=length;left+=spacing)
            out.push([a[0]+(b[0]-a[0])*left/length,a[1]+(b[1]-a[1])*left/length]);
        left-=length;
    }
    if(dist(out.at(-1),points.at(-1))>.01)out.push(points.at(-1));
    return out;
}

function normalAt(path,i) {
    const a=path[Math.max(0,i-1)],b=path[Math.min(path.length-1,i+1)];
    const length=dist(a,b)||1;
    return [(a[1]-b[1])/length,(b[0]-a[0])/length];
}

// Compare the strips on either side of the user's stroke. Premultiplied
// colour ignores hidden PNG RGB. Alpha contributes a separate silhouette edge.
function boundaryScore(image,x,y,nx,ny) {
    const {width,height,data}=image;
    const pixel=(x,y)=>4*(clamp(Math.round(y),0,height-1)*width+clamp(Math.round(x),0,width-1));
    let colour=0,texture=0,alpha=0;
    for(const reach of [1.25,3.5]){
        let dr=0,dg=0,db=0,da=0,lv=0,rv=0,oldL=0,oldR=0;
        for(let k=-2;k<=2;k++){
            const cx=x-ny*k,cy=y+nx*k;
            const l=pixel(cx-nx*reach,cy-ny*reach),r=pixel(cx+nx*reach,cy+ny*reach);
            const la=data[l+3]/255,ra=data[r+3]/255;
            dr+=data[l]*la-data[r]*ra;dg+=data[l+1]*la-data[r+1]*ra;db+=data[l+2]*la-data[r+2]*ra;
            da+=la-ra;
            const luma=(data[l]+2*data[l+1]+data[l+2])*la/4;
            const ruma=(data[r]+2*data[r+1]+data[r+2])*ra/4;
            if(k>-2){lv+=Math.abs(luma-oldL);rv+=Math.abs(ruma-oldR);}
            oldL=luma;oldR=ruma;
        }
        const weight=reach<2?.7:.3;
        colour+=weight*Math.hypot(dr,dg,db)/8.66;
        alpha+=weight*Math.abs(da)*51;
        texture+=weight*Math.abs(lv-rv)/4;
    }
    return colour+alpha+texture*.6;
}

// Dynamic programming selects one continuous edge through a narrow band.
// Candidate transitions penalise jumps between parallel seams or fur strands.
function findBoundary(base, image, mask, pinnedSamples) {
    const normals=base.map((_,i)=>normalAt(base,i));
    const displacement=new Float32Array(base.length);
    const radius=10, width=radius*2+1;
    const inside=(x,y)=>!mask || (x>=0&&y>=0&&x<mask.width&&y<mask.height&&
        mask.data[4*(Math.floor(y)*mask.width+Math.floor(x))]>0);
    let inSearchArea=false;
    let hasEdge=false;
    const parents=new Int8Array(base.length*width);
    let previous=new Float64Array(width),next=new Float64Array(width);
    for(let i=0;i<base.length;i++){
        const [x,y]=base[i],[nx,ny]=normals[i];
        for(let j=0;j<width;j++){
            const delta=j-radius,cx=x+nx*delta,cy=y+ny*delta;
            let score= -Math.abs(delta)*1.9;
            if(cx>=0&&cy>=0&&cx<image.width&&cy<image.height&&inside(cx,cy)){
                const contrast=boundaryScore(image,cx,cy,nx,ny);
                score+=contrast;
                inSearchArea=true;
                if(contrast>0)hasEdge=true;
            }else if(delta!==0)score=-1e6;
            let best=previous[j],which=j;
            for(let k=Math.max(0,j-3);k<=Math.min(width-1,j+3);k++){
                const cost=previous[k]-3*(k-j)**2;
                if(cost>best){best=cost;which=k;}
            }
            parents[i*width+j]=which;
            next[j]=score+(i?best:0);
        }
        [previous,next]=[next,previous];
    }
    let j=previous.indexOf(Math.max(...previous));
    for(let i=base.length-1;i>=0;i--){
        displacement[i]=j-radius;j=parents[i*width+j];
    }
    // A manually moved handle wins over a nearby high-contrast edge locally.
    const influence=new Float32Array(base.length).fill(1);
    for(const at of pinnedSamples){
        for(let i=Math.max(0,at-7);i<=Math.min(base.length-1,at+7);i++)
            influence[i]=Math.min(influence[i],Math.abs(i-at)/7);
    }
    const path=base.map(([x,y],i)=>{
        let d=0;
        for(let k=-2;k<=2;k++)d+=displacement[clamp(i+k,0,base.length-1)]*(3-Math.abs(k))/9;
        const [nx,ny]=normals[i];
        d*=influence[i];
        if(mask&&!inside(x+nx*d,y+ny*d))d=0;
        return [x+nx*d,y+ny*d];
    });
    return {path,inSearchArea,hasEdge};
}

function anchorIndices(path, points) {
    let start=0;
    return points.map(p=>{start=nearest(path,p,start).index;return start;});
}

export function contourGeometry(anchors, options={}, image=null, mask=null, pins=new Set()) {
    const base=resample(sampleCurve(anchors,1.5),2);
    const indices=anchorIndices(base,anchors);
    const normals=base.map((_,i)=>normalAt(base,i));
    let path=base;
    if(options.snap&&image&&base.length>1)
        path=findBoundary(base,image,mask,[...pins].map(i=>indices[i])).path;
    if(options.offset)
        path=path.map(([x,y],i)=>[x+normals[i][0]*options.offset,y+normals[i][1]*options.offset]);
    return {base,path,normals,indices};
}

// Keep the fitted samples between two handles. Dragging a handle deforms the
// fitted segment smoothly without running the edge search again.
function deformSegment(samples, a, b) {
    const first=samples[0],last=samples.at(-1);
    return samples.map(([x,y],i)=>{
        const t=i/(samples.length-1), w=t*t*(3-2*t);
        return [x+(1-w)*(a[0]-first[0])+w*(b[0]-last[0]),
                y+(1-w)*(a[1]-first[1])+w*(b[1]-last[1])];
    });
}

export class SmoothContour {
    constructor(options, readImage, readMask) {
        this.options=options;this.readImage=readImage;this.readMask=readMask;
        this.clear();
    }
    clear(){
        this.points=[];this.pins=new Set();this.selected=-1;this.history=[];
        this.gesture=null;this.segments=[];this.searchBase=null;this.cache=null;this.message="";
    }
    remember(action="edit"){
        this.history.push({action,points:this.points.slice(),pins:new Set(this.pins),selected:this.selected,
            segments:this.segments.slice(),searchBase:this.searchBase});
        if(this.history.length>80)this.history.shift();
    }
    undo(){
        const previous=this.history.pop();
        if(!previous)return false;
        const {action,...state}=previous;
        Object.assign(this,state);this.gesture=null;this.cache=null;
        this.message=action==="snap"?inpaintText("Привязка отменена. Можно поправить линию или выбрать другую границу."):"";
        return true;
    }
    remove(){
        if(this.selected<0)return;
        this.remember();const at=this.selected;
        if(at===0)this.segments.shift();
        else if(at===this.points.length-1)this.segments.splice(at-1,1);
        else this.segments.splice(at-1,2,null);
        this.searchBase=null;this.message="";
        this.points.splice(at,1);
        this.pins=new Set([...this.pins].filter(i=>i!==at).map(i=>i>at?i-1:i));
        this.selected=Math.min(at,this.points.length-1);this.cache=null;
    }
    snapToBoundary(inMask){
        if(this.gesture||this.points.length<2)return;
        const {center,indices}=this.searchBase||this.geometry();
        if(center.length<2)return;
        const mask=inMask?this.readMask():null;
        const result=findBoundary(center,this.readImage(),mask,[...this.pins].map(i=>indices[i]));
        if(!result.inSearchArea||!result.hasEdge){
            this.message=!result.inSearchArea&&inMask?inpaintText("Рядом с линией нет маски правки. Закрасьте область поиска или выберите обычную привязку.")
                :inpaintText("Рядом с линией не нашлось границы")+(inMask?inpaintText(" внутри маски правки."):".");
            return;
        }
        // Both actions search from the same sketch until the user edits it.
        const current=this.geometry().center;
        if(current.length===result.path.length&&current.every((p,i)=>dist(p,result.path[i])<.001)){
            this.message=inpaintText("Линия уже совпадает с найденной границей.");
            return;
        }
        this.remember("snap");
        this.searchBase={center,indices};
        this.points=indices.map(i=>result.path[i]);
        this.segments=indices.slice(1).map((end,i)=>result.path.slice(indices[i],end+1));
        this.cache=null;
        this.message=inMask?inpaintText("Линия привязана к границе внутри маски правки."):inpaintText("Линия привязана к стыку рядом со штрихом.");
    }
    geometry(){
        const {offset}=this.options;
        if(!this.cache){
            const {base:free,indices:handles,normals}=contourGeometry(this.points);
            let center=free, indices=handles;
            if(this.segments.some(s=>s?.length>1)){
                center=[this.points[0]];indices=[0];
                for(let i=1;i<this.points.length;i++){
                    const s=this.segments[i-1];
                    const section=s?.length>1?deformSegment(s,this.points[i-1],this.points[i]).slice(1)
                        :free.slice(handles[i-1]+1,handles[i]+1);
                    for(const p of section)center.push(p);
                    indices.push(center.length-1);
                }
            }
            this.cache={center,indices,path:center,normals:center===free?normals:center.map((_,i)=>normalAt(center,i)),offset:0};
        }
        if(this.cache.offset!==offset){
            this.cache.offset=offset;
            this.cache.path=this.cache.center.map(([x,y],i)=>{
                const n=this.cache.normals?.[i]||[0,0];
                return [x+n[0]*offset,y+n[1]*offset];
            });
        }
        return this.cache;
    }
    sample(){return this.geometry().path;}
    displayPoints(){const g=this.geometry();return g.indices.map(i=>g.path[i]);}
    beginGesture(p,scale){
        const g=this.geometry(),handles=this.displayPoints();
        const handle=nearest(handles,p),line=nearest(g.path,p);
        this.remember();
        this.searchBase=null;this.message="";
        if(handle.distance<=8*scale){
            this.selected=handle.index;
            this.gesture={kind:"handle",start:p,anchor:this.points[this.selected],scale};
        }else if(line.distance<=8*scale){
            let at=g.indices.findIndex(i=>i>=line.index);if(at<0)at=this.points.length;
            this.pins=new Set([...this.pins].map(i=>i>=at?i+1:i));
            if(this.segments[at-1]?.length>1){
                this.segments.splice(at-1,1,g.center.slice(g.indices[at-1],line.index+1),g.center.slice(line.index,g.indices[at]+1));
            }else if(this.segments.length)this.segments.splice(Math.max(0,at-1),1,null,null);
            const anchor=g.center[line.index];this.points.splice(at,0,anchor);
            this.selected=at;this.gesture={kind:"handle",start:p,anchor,scale};
        }else{
            this.points.push(p);this.selected=this.points.length-1;
            this.gesture={kind:"trace",start:p,first:this.selected,last:p,scale};
        }
        this.cache=null;
    }
    moveGesture(p){
        const g=this.gesture;if(!g)return;
        if(!g.moved&&dist(g.start,p)<2*g.scale)return;
        g.moved=true;
        if(g.kind==="handle"){
            this.points[this.selected]=[g.anchor[0]+p[0]-g.start[0],g.anchor[1]+p[1]-g.start[1]];
            this.pins.add(this.selected);
        }else{
            if(dist(g.last,p)<.3)return;
            g.last=p;
            // Keep freehand samples sparse enough to edit the trace by its handles.
            const spacing=Math.max(6,12*g.scale);
            if(this.points.length===g.first+1||dist(this.points.at(-2),this.points.at(-1))>=spacing)this.points.push(p);
            else this.points[this.points.length-1]=p;
            this.selected=this.points.length-1;
        }
        this.cache=null;
    }
    endGesture(p){
        if(!this.gesture)return;
        if(!p){this.undo();return;}
        this.moveGesture(p);
        this.gesture=null;this.cache=null;
    }
}
