const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
export function nearestPath(points,p){let best=null;points.forEach((q,index)=>{const d=dist(q,p);if(!best||d<best.distance)best={index,distance:d,point:q};});return best;}
export function bendPolyline(points,index,delta,reach=.55,pins=[]){
 if(points.length<2)return points.map(p=>p.slice());
 const s=[0];for(let i=1;i<points.length;i++)s.push(s.at(-1)+dist(points[i],points[i-1]));
 const total=s.at(-1),center=s[index],radius=Math.max(2,total*reach),fixed=[0,...pins,points.length-1].sort((a,b)=>a-b);
 const left=fixed.filter(i=>i<index).at(-1)??0,right=fixed.find(i=>i>index)??points.length-1;
 const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
 return points.map((p,i)=>{
  if(i<=left||i>=right||fixed.includes(i))return p.slice();
  const d=Math.abs(s[i]-center)/radius;if(d>=1)return p.slice();
  const taper=i<index?smooth((s[i]-s[left])/Math.max(.0001,center-s[left])):smooth((s[right]-s[i])/Math.max(.0001,s[right]-center));
  const weight=(1-d*d)**3*taper;return [p[0]+delta[0]*weight,p[1]+delta[1]*weight];
 });
}
export class ElasticCurve {
 points=[];path=[];indices=[];selected=-1;history=[];
 remember(){this.history.push(structuredClone({points:this.points,path:this.path,indices:this.indices,selected:this.selected}));if(this.history.length>100)this.history.shift();}
 sync(){this.points=this.indices.map(i=>this.path[i].slice());}
 add(p){
  this.remember();if(!this.path.length){this.path=[p.slice()];this.indices=[0];}
  else{const a=this.path.at(-1),length=dist(a,p);if(length<.01)return;const prev=this.path[Math.max(0,this.path.length-10)],v=[a[0]-prev[0],a[1]-prev[1]],n=Math.hypot(...v)||1;
   const start=this.path.length<2?[p[0]-a[0],p[1]-a[1]]:v.map(x=>x/n*length),end=[p[0]-a[0],p[1]-a[1]],count=Math.max(4,Math.ceil(length));
   for(let i=1;i<=count;i++){const t=i/count,t2=t*t,t3=t2*t;this.path.push(i===count?p.slice():[0,1].map(k=>(2*t3-3*t2+1)*a[k]+(t3-2*t2+t)*start[k]+(-2*t3+3*t2)*p[k]+(t3-t2)*end[k]));}this.indices.push(this.path.length-1);
  }this.selected=this.indices.length-1;this.sync();
 }
 select(i){this.selected=i;}
 hit(p,r){const h=nearestPath(this.points,p);return h&&h.distance<=r?h.index:-1;}
 move(i,p){
  const index=this.indices[i],old=this.path[index],delta=[p[0]-old[0],p[1]-old[1]],left=this.indices[i-1]??0,right=this.indices[i+1]??this.path.length-1;
  this.path=this.path.map((q,j)=>{if(j<left||j>right)return q;const d=j<=index?(index===left?1:(j-left)/(index-left)):(right===index?1:(right-j)/(right-index));const t=d*d*(3-2*d);return [q[0]+delta[0]*t,q[1]+delta[1]*t];});this.sync();
 }
 bend(base,index,delta,reach){this.path=bendPolyline(base,index,delta,reach);this.sync();}
 sample(){return this.path;}
 remove(){if(this.selected<0)return;this.remember();this.indices.splice(this.selected,1);if(this.indices.length<2){this.path=this.indices.length?[this.path[this.indices[0]].slice()]:[];this.indices=this.path.length?[0]:[];}else{const first=this.indices[0],last=this.indices.at(-1);this.path=this.path.slice(first,last+1);this.indices=this.indices.map(i=>i-first);}this.selected=Math.min(this.selected,this.indices.length-1);this.sync();}
 undo(){const s=this.history.pop();if(!s)return false;Object.assign(this,s);return true;}
 clear(){this.points=[];this.path=[];this.indices=[];this.selected=-1;this.history=[];}
}

// Both arc tools use the same anchor editing, span selection and undo history.
class AnchoredArcs {
    points = []; shapes = []; path = []; indices = []; selected = -1; history = [];

    remember() {
        this.history.push(structuredClone({points: this.points, shapes: this.shapes, selected: this.selected}));
        if (this.history.length > 100) this.history.shift();
    }

    rebuild() {
        this.path = this.points.length ? [this.points[0].slice()] : [];
        this.indices = this.points.length ? [0] : [];
        for (const [i, shape] of this.shapes.entries()) {
            const a = this.points[i], b = this.points[i + 1], length = dist(a, b);
            const ux = length ? (b[0] - a[0]) / length : 0, uy = length ? (b[1] - a[1]) / length : 0;
            if (length) this.sampleInterior(length, shape, (x, y) => {
                this.path.push([a[0] + ux*x - uy*y, a[1] + uy*x + ux*y]);
            });
            this.path.push(b.slice());
            this.indices.push(this.path.length - 1);
        }
    }

    add(p) {
        if (this.points.length && dist(p, this.points.at(-1)) < .01) return;
        this.remember();
        if (this.points.length) this.shapes.push(this.straightShape());
        this.points.push(p.slice());
        this.selected = this.points.length - 1;
        this.rebuild();
    }

    hit(p, radius) {
        const hit = nearestPath(this.points, p);
        return hit && hit.distance <= radius ? hit.index : -1;
    }
    select(i) { this.selected = i; }
    move(i, p) { this.points[i] = p.slice(); this.rebuild(); }
    sample() { return this.path; }

    bend(base, index, delta) {
        const end = this.indices.findIndex(i => i >= index);
        if (end < 1 || !base[index]) return;
        const a = this.points[end - 1], b = this.points[end], length = dist(a, b);
        if (length < .01) return;
        const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length;
        const project = p => {
            const dx = p[0] - a[0], dy = p[1] - a[1];
            return [(dx*ux + dy*uy) / length, (dy*ux - dx*uy) / length];
        };
        const target = project([base[index][0] + delta[0], base[index][1] + delta[1]]);
        const middle = Math.floor((this.indices[end - 1] + this.indices[end]) / 2);
        this.shapes[end - 1] = this.bentShape(target, project(base[middle]), project(base[index]), Math.hypot(...delta) / length);
        this.rebuild();
    }

    remove() {
        const i = this.selected;
        if (i < 0) return;
        this.remember();
        if (i > 0 && i < this.points.length - 1) this.shapes.splice(i - 1, 2, this.straightShape());
        else this.shapes.splice(Math.max(0, i - 1), 1);
        this.points.splice(i, 1);
        this.selected = Math.min(i, this.points.length - 1);
        this.rebuild();
    }
    undo() {
        const state = this.history.pop();
        if (!state) return false;
        Object.assign(this, state);
        this.rebuild();
        return true;
    }
    clear() { this.points = []; this.shapes = []; this.selected = -1; this.history = []; this.rebuild(); }
}

// Signed bulge is measured in half-chords. One is a semicircle.
export class CircularArcCurve extends AnchoredArcs {
    straightShape() { return 0; }
    sampleInterior(length, bulge, append) {
        const steps = Math.max(4, Math.ceil(length * Math.PI / 2)), half = length / 2;
        const angle = 4 * Math.atan(bulge);
        const radius = Math.abs(bulge) > 1e-8 ? half * (1 + bulge*bulge) / (2*bulge) : 0;
        for (let j = 1; j < steps; j++) {
            const t = j / steps, phi = (t - .5) * angle;
            if (radius) append(half + radius*Math.sin(phi), half*bulge - 2*radius*Math.sin(phi/2)**2);
            else append(length*t, 0);
        }
    }
    bentShape([along, rise]) {
        const x = Math.max(-1, Math.min(1, 2*along - 1)), y = 2*rise;
        if (Math.abs(y) < 1e-12) return 0;
        const c = (x*x + y*y - 1) / (2*y), radius = Math.hypot(1, c);
        return Math.sign(y) * Math.min(1, c*y < 0 ? 1/(radius + Math.abs(c)) : radius + Math.abs(c));
    }
}

// Two quarter ellipses meet at the dragged peak with a shared horizontal
// tangent (in chord coordinates). Neither endpoint has a flat lead-in.
export class OvalArcCurve extends AnchoredArcs {
    straightShape() { return {peak: .5, rise: 0}; }
    sampleInterior(length, {peak, rise}, append) {
        // Sample the peak exactly and keep sample indices stable while dragging.
        const halfSteps = Math.max(8, Math.ceil(length * Math.PI / 4));
        for (let j = 1; j < 2*halfSteps; j++) {
            if (!rise) { append(length * j/(2*halfSteps), 0); continue; }
            const left = j <= halfSteps, angle = (left ? j : 2*halfSteps - j) * Math.PI / (2*halfSteps);
            const dx = 2 * Math.sin(angle/2)**2;
            append(length * (left ? peak*dx : 1 - (1 - peak)*dx), length*rise*Math.sin(angle));
        }
    }
    bentShape([along, height], [originalPeak, originalRise], [grab], travel) {
        const inside = x => Math.max(.001, Math.min(.999, x));
        const x = inside(along);
        // A fresh line peaks under the pointer. Re-grabbing an existing flank
        // shifts the peak progressively, so a click or tiny drag cannot snap it.
        const blend = Math.abs(originalRise) < 1e-10 ? 1 : Math.min(1, travel / Math.abs(originalRise));
        const peak = inside(originalPeak + (along - grab) + (grab - originalPeak)*blend);
        const width = x < peak ? peak : 1 - peak;
        const offset = (x - peak) / width;
        return {peak, rise: height / Math.sqrt(1 - offset*offset)};
    }
}
