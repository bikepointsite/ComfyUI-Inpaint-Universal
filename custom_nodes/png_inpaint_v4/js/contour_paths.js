import { t as inpaintText } from './language.js';
// Geometry comes only from alpha > 0, never from RGB or image recognition.
export function traceAlphaContours(rgba,width,height,limit=200000){
    const edges=[],starts=new Map(),stride=width+1;
    const filled=(x,y)=>x>=0&&y>=0&&x<width&&y<height&&rgba[(y*width+x)*4+3]>0;
    function edge(x,y,dir){
        if(edges.length>=limit)throw new Error(inpaintText("Слишком много отдельных границ альфы. Для этого PNG используйте кисть прозрачности."));
        const key=y*stride+x,index=edges.length;
        const dx=[1,0,-1,0][dir],dy=[0,1,0,-1][dir];
        edges.push({x,y,dir,start:key,end:(y+dy)*stride+x+dx});
        if(!starts.has(key))starts.set(key,[]);starts.get(key).push(index);
    }
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(filled(x,y)){
        if(!filled(x,y-1))edge(x,y,0);
        if(!filled(x+1,y))edge(x+1,y,1);
        if(!filled(x,y+1))edge(x+1,y+1,2);
        if(!filled(x-1,y))edge(x,y+1,3);
    }
    const seen=new Uint8Array(edges.length),loops=[],priority=[1,0,3,2];
    for(let i=0;i<edges.length;i++)if(!seen[i]){
        const path=[];let index=i;
        while(index!==undefined&&!seen[index]){
            const e=edges[index];seen[index]=1;path.push([e.x,e.y]);
            if(e.end===edges[i].start)break;
            const candidates=(starts.get(e.end)||[]).filter(j=>!seen[j]);
            index=candidates.sort((a,b)=>priority.indexOf((edges[a].dir-e.dir+4)%4)-priority.indexOf((edges[b].dir-e.dir+4)%4))[0];
        }
        if(path.length>=4)loops.push(path);
    }
    return loops;
}

export function nearestVertex(paths,p){
    let best=null;
    paths.forEach((path,loop)=>path.forEach((q,index)=>{
        const distance=Math.hypot(p[0]-q[0],p[1]-q[1]);
        if(!best||distance<best.distance)best={loop,index,point:q,distance};
    }));return best;
}

// Classify whole connected components, not their faint antialiased outer pixels.
// A real object with an alpha=1 fringe remains selectable if its interior is opaque.
// This affects only the UI; all original loops still participate in cut validation.
export function strongContourIndices(loops,rgba,width,height,threshold=8){
    const labels=new Int32Array(width*height),queue=new Int32Array(width*height),maxima=[0];
    let count=0;
    for(let start=0;start<labels.length;start++){
        if(labels[start]||!rgba[start*4+3])continue;
        const label=++count;let head=0,tail=1,maximum=0;queue[0]=start;labels[start]=label;
        const push=p=>{if(!labels[p]&&rgba[p*4+3]){labels[p]=label;queue[tail++]=p;}};
        while(head<tail){
            const p=queue[head++],x=p%width;maximum=Math.max(maximum,rgba[p*4+3]);
            if(x)push(p-1);if(x+1<width)push(p+1);if(p>=width)push(p-width);if(p+width<labels.length)push(p+width);
        }maxima[label]=maximum;
    }
    const indices=[];
    loops.forEach((loop,i)=>{
        const [a,b]=loop,dx=b[0]-a[0],dy=b[1]-a[1];
        // Filled cells lie to the right of each directed edge, also around holes.
        const x=Math.floor((a[0]+b[0])/2-dy*.25),y=Math.floor((a[1]+b[1])/2+dx*.25);
        if(maxima[labels[y*width+x]]>threshold)indices.push(i);
    });
    // Entirely translucent art must remain editable without discovering a setting.
    return indices.length?indices:loops.map((_,i)=>i);
}

export function displayContourIndices(loops,strong,minArea=9){
    const area=loop=>Math.abs(loop.reduce((sum,a,i)=>{
        const b=loop[(i+1)%loop.length];return sum+a[0]*b[1]-b[0]*a[1];
    },0)/2);
    const shown=strong.filter(i=>area(loops[i])>=minArea);
    return shown.length?shown:strong;
}

export function selectArc(loop,start,end,other=false){
    const forward=(end-start+loop.length)%loop.length;
    let direction=forward<=loop.length-forward?1:-1;if(other)direction*=-1;
    const indices=[],points=[];let i=start;
    for(let n=0;n<=loop.length;n++){
        indices.push(i);points.push(loop[i].slice());if(i===end)break;i=(i+direction+loop.length)%loop.length;
    }
    return {points,indices,direction};
}

const smooth=t=>t*t*(3-2*t);
export function bendArc(base,handles){
    const knots=[{index:0,offset:[0,0]},...handles.slice().sort((a,b)=>a.index-b.index),{index:base.length-1,offset:[0,0]}];
    let segment=0;
    return base.map((p,i)=>{
        while(segment+1<knots.length-1&&i>knots[segment+1].index)segment++;
        const a=knots[segment],b=knots[segment+1],t=smooth((i-a.index)/Math.max(1,b.index-a.index));
        return [p[0]+a.offset[0]+(b.offset[0]-a.offset[0])*t,p[1]+a.offset[1]+(b.offset[1]-a.offset[1])*t];
    });
}

export function insideAlpha(p,rgba,width,height){
    const [x,y]=p;if(x<0||y<0||x>width||y>height)return false;
    const xs=[Math.floor(x)],ys=[Math.floor(y)];
    if(Math.abs(x-Math.round(x))<1e-5)xs.push(Math.round(x)-1);
    if(Math.abs(y-Math.round(y))<1e-5)ys.push(Math.round(y)-1);
    return xs.some(xx=>ys.some(yy=>xx>=0&&yy>=0&&xx<width&&yy<height&&rgba[(yy*width+xx)*4+3]>0));
}

function nearAlpha(p,rgba,width,height,tolerance){
    if(insideAlpha(p,rgba,width,height))return true;
    if(!tolerance)return false;
    const [x,y]=p,cellX=Math.floor(x),cellY=Math.floor(y);
    for(let yy=Math.max(0,cellY-1);yy<=Math.min(height-1,cellY+1);yy++){
        for(let xx=Math.max(0,cellX-1);xx<=Math.min(width-1,cellX+1);xx++){
            if(!rgba[(yy*width+xx)*4+3])continue;
            const dx=Math.max(xx-x,0,x-xx-1),dy=Math.max(yy-y,0,y-yy-1);
            if(Math.hypot(dx,dy)<=tolerance)return true;
        }
    }return false;
}

const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function properCross(a,b,c,d){
    if(Math.max(a[0],b[0])<Math.min(c[0],d[0])||Math.max(c[0],d[0])<Math.min(a[0],b[0])||
        Math.max(a[1],b[1])<Math.min(c[1],d[1])||Math.max(c[1],d[1])<Math.min(a[1],b[1]))return false;
    return cross(a,b,c)*cross(a,b,d)<-1e-8&&cross(c,d,a)*cross(c,d,b)<-1e-8;
}
function strictlyInside(p,polygon){
    let inside=false;
    for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
        const a=polygon[j],b=polygon[i];
        if(Math.abs(cross(a,b,p))<1e-6&&p[0]>=Math.min(a[0],b[0])-1e-6&&p[0]<=Math.max(a[0],b[0])+1e-6&&p[1]>=Math.min(a[1],b[1])-1e-6&&p[1]<=Math.max(a[1],b[1])+1e-6)return false;
        if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    }return inside;
}
export function validArc(points,original,rgba,width,height,loops,loopIndex,selectedIndices,full=false,options={}){
    if(points.length!==original.length||points.some(p=>!p.every(Number.isFinite)))return false;
    if(points[0].some((v,i)=>v!==original[0][i])||points.at(-1).some((v,i)=>v!==original.at(-1)[i]))return false;
    for(let i=1;i<points.length;i++){
        const a=points[i-1],b=points[i],steps=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/.5));
        for(let j=0;j<=steps;j++)if(!nearAlpha([a[0]+(b[0]-a[0])*j/steps,a[1]+(b[1]-a[1])*j/steps],rgba,width,height,Math.min(.75,options.pixelTolerance||0)))return false;
    }
    if(!full)return true;
    for(let i=1;i<points.length;i++)for(let j=i+2;j<points.length;j++)if(properCross(points[i-1],points[i],points[j-1],points[j]))return false;
    const polygon=[...original,...points.slice().reverse()],selected=new Set(selectedIndices);
    const xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
    // Reject cuts that would swallow another, unselected edge or an inner hole.
    for(let l=0;l<loops.length;l++){
      if(l!==loopIndex&&options.ignoreMicroHoles){
        const twiceArea=loops[l].reduce((sum,a,i)=>{const b=loops[l][(i+1)%loops[l].length];return sum+a[0]*b[1]-b[0]*a[1];},0);
        // Only microscopic inner holes: independent islands and larger holes stay protected.
        if(twiceArea<0&&Math.abs(twiceArea)<18)continue;
      }
      for(let i=0;i<loops[l].length;i++){
        if(l===loopIndex&&selected.has(i))continue;const p=loops[l][i];
        if(p[0]>minX&&p[0]<maxX&&p[1]>minY&&p[1]<maxY&&strictlyInside(p,polygon))return false;
      }
    }
    return true;
}

export function smoothArc(points,rgba,width,height){
    let result=points.map(p=>p.slice());
    for(let pass=0;pass<18;pass++){
        const previous=result;result=previous.map((p,i)=>{
            if(!i||i===previous.length-1)return p.slice();
            const t=i/(previous.length-1),weight=.45*Math.sin(Math.PI*t)**2;
            const q=[p[0]+((previous[i-1][0]+previous[i+1][0])/2-p[0])*weight,p[1]+((previous[i-1][1]+previous[i+1][1])/2-p[1])*weight];
            return insideAlpha(q,rgba,width,height)?q:p.slice();
        });
    }return result;
}
