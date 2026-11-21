// All geometry is in image pixels. Preview and pointer handling live in mask_editor.
const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
const mix = (a,b,t) => [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];

export class BrushStabilizer {
    constructor(start, radius, spacing=1) {
        this.point=start.slice(); this.input=start.slice();
        this.radius=Math.max(0,radius); this.spacing=Math.max(.1,spacing);
    }
    move(next) {
        const length=distance(this.input,next);
        if (!length) return [];
        if (!this.radius) {this.input=next.slice();this.point=next.slice();return [this.point.slice()];}
        // Integrate by travelled distance, not event count: slow mice and coalesced
        // pointer events get comparable smoothing. Subdivision also avoids gaps.
        const count=Math.max(1,Math.ceil(length/this.spacing));
        const alpha=1-Math.exp(-length/count/this.radius), out=[];
        for(let i=1;i<=count;i++) {
            this.point=mix(this.point,mix(this.input,next,i/count),alpha);
            out.push(this.point.slice());
        }
        this.input=next.slice(); return out;
    }
    finish(next) {
        const out=this.move(next);
        // The release point is deliberate: complete the trailing part to it.
        if(distance(this.point,next)>.001) out.push(next.slice());
        this.input=next.slice();this.point=next.slice();return out;
    }
}

export function sampleCurve(input, spacing=1) {
    const points=input.filter((p,i)=>!i||distance(p,input[i-1])>.001).map(p=>p.slice());
    if(points.length<3) return points;
    const out=[points[0]], step=Math.max(.25,spacing);
    // Centripetal Catmull-Rom interpolates the handles and avoids the loops that
    // uniform splines can produce with closely spaced points on sharp turns.
    for(let i=0;i<points.length-1;i++) {
        const b=points[i],c=points[i+1];
        const a=points[i-1]||[2*b[0]-c[0],2*b[1]-c[1]];
        const d=points[i+2]||[2*c[0]-b[0],2*c[1]-b[1]];
        const t0=0,t1=Math.sqrt(distance(a,b)),t2=t1+Math.sqrt(distance(b,c)),t3=t2+Math.sqrt(distance(c,d));
        const at=t=>{
            const a1=mix(a,b,(t-t0)/(t1-t0)),a2=mix(b,c,(t-t1)/(t2-t1)),a3=mix(c,d,(t-t2)/(t3-t2));
            return mix(mix(a1,a2,(t-t0)/(t2-t0)),mix(a2,a3,(t-t1)/(t3-t1)),(t-t1)/(t2-t1));
        };
        const count=Math.max(4,Math.ceil((distance(a,b)+distance(b,c)*2+distance(c,d))/step));
        for(let j=1;j<=count;j++) out.push(j===count?c.slice():at(t1+(t2-t1)*j/count));
    }
    return out;
}

export class CurveDraft {
    points=[]; selected=-1; history=[];
    remember() {this.history.push({points:this.points.map(p=>p.slice()),selected:this.selected});if(this.history.length>100)this.history.shift();}
    add(point) {this.remember();this.points.push(point.slice());this.selected=this.points.length-1;}
    select(index) {this.selected=index;}
    move(index,point) {this.points[index]=point.slice();}
    remove() {
        if(this.selected<0)return;
        this.remember();this.points.splice(this.selected,1);this.selected=Math.min(this.selected,this.points.length-1);
    }
    undo() {
        const saved=this.history.pop();if(!saved)return false;
        this.points=saved.points;this.selected=saved.selected;return true;
    }
    clear() {this.points=[];this.selected=-1;this.history=[];}
    hit(point,radius) {
        let index=-1,best=radius;
        this.points.forEach((p,i)=>{const d=distance(p,point);if(d<=best){best=d;index=i;}});return index;
    }
}
