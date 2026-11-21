// Fit an editable A–B section in image coordinates. The current alpha supplies
// the interior side. Final containment and neighbouring loops are checked by
// the contour editor before showing or applying the candidate.
function interiorSide(arc, rgba, width, height, fallback) {
    const alpha = (x, y) => x >= 0 && x < width && y >= 0 && y < height
        ? rgba[(Math.floor(y) * width + Math.floor(x)) * 4 + 3] : 0;
    let vote = 0;
    for (let i = 1; i < arc.length; i++) {
        const a = arc[i - 1], b = arc[i];
        const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
        if (!d) continue;
        const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
        vote += d * (alpha(x - dy/d, y + dx/d) - alpha(x + dy/d, y - dx/d));
    }
    return Math.sign(vote) || fallback;
}

function fitSpan(points, inward, radius, straight) {
    const a = points[0], b = points.at(-1);
    if (points.length <= 2) return points.slice();
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const tx = (b[0] - a[0]) / (length || 1), ty = (b[1] - a[1]) / (length || 1);
    const nx = -ty * inward, ny = tx * inward;
    const count = Math.max(2, Math.ceil(length));
    const edge = new Float64Array(count + 1).fill(-Infinity);
    const distance = new Float64Array(points.length);
    let furthest = 0, backtrack = 0, sideways = 0;
    let lastU = 0, lastV = 0;
    for (let i = 0; i < points.length; i++) {
        const [x, y] = points[i];
        const u = (x-a[0])*tx + (y-a[1])*ty, v = (x-a[0])*nx + (y-a[1])*ny;
        if (i) distance[i] = distance[i-1] + Math.hypot(x-points[i-1][0], y-points[i-1][1]);
        backtrack = Math.max(backtrack, furthest-u, u-length);
        furthest = Math.max(furthest, u);
        sideways = Math.max(sideways, Math.abs(v));
        // A hook may cross the same column several times. Keep the innermost
        // crossing so the new line can trim the hook without filling its notch.
        const column = Math.max(0, Math.min(count, Math.round(u*count/(length || 1))));
        edge[column] = Math.max(edge[column], v);
        const scale = count/(length || 1);
        for (let j = Math.max(0,Math.ceil(Math.min(lastU,u)*scale)); j <= Math.min(count,Math.max(lastU,u)*scale); j++) {
            const f = u === lastU ? 0 : (j/scale-lastU)/(u-lastU);
            edge[j] = Math.max(edge[j], lastV+(v-lastV)*f);
        }
        lastU = u; lastV = v;
    }
    const total = distance.at(-1);
    if (!total) return points.slice();
    // Broad turns need multiple local axes. A straight-line fallback is only
    // for small irregularities, never a detour around a deep opening.
    if (length < 1 || backtrack > Math.max(2,radius) || sideways > Math.max(radius*2,length*.55)) {
        if (straight) return null;
        const mid = Math.floor(points.length/2);
        return fitSpan(points.slice(0,mid+1),inward,radius,false).concat(fitSpan(points.slice(mid),inward,radius,false).slice(1));
    }
    edge[0] = edge[count] = 0;
    const span = Math.max(1, Math.min(count, Math.round(radius*count/length)));
    const baseline = new Float64Array(count+1);
    if (!straight) {
        // A symmetric triangular average follows broad curvature. Odd reflection
        // at the ends preserves the slope into A and B.
        for (let j=1; j<count; j++) {
            let sum=0;
            for (let k=-span; k<=span; k++) {
                const p=j+k;
                const v=p<0 ? -edge[-p] : p>count ? -edge[2*count-p] : edge[p];
                sum += v*(span+1-Math.abs(k));
            }
            baseline[j]=sum/((span+1)**2);
        }
    }
    const lift = new Float64Array(count+1);
    for (let i=1; i<count; i++) {
        const deficit=edge[i]-baseline[i];
        if (deficit<=0) continue;
        if (straight && deficit>Math.min(16,Math.max(2,length*.16))) return null;
        // Spread corrections around inward notches as smooth shoulders.
        for (let j=Math.max(1,i-span+1); j<Math.min(count,i+span); j++) {
            const weight=(1+Math.cos(Math.PI*(j-i)/span))/2;
            lift[j]=Math.max(lift[j], deficit*weight);
        }
    }
    for (let i=1; i<count; i++) baseline[i]+=lift[i];
    // Preserve index correspondence for subsequent dragging and pinned handles.
    return points.map((p,i)=>{
        if (!i || i===points.length-1) return p.slice();
        const t=distance[i]/total, pos=t*count, j=Math.min(count-1,Math.floor(pos));
        const v=baseline[j]+(baseline[j+1]-baseline[j])*(pos-j);
        return [a[0]+tx*t*length+nx*v, a[1]+ty*t*length+ny*v];
    });
}

export function fitInwardContour({points, arc, rgba, width, height, radius, pins, straight}) {
    const side=interiorSide(arc.points,rgba,width,height,arc.direction);
    const stops=[0,...new Set(pins.filter(i=>i>0 && i<points.length-1)),points.length-1].sort((a,b)=>a-b);
    const result=[points[0].slice()];
    for (let i=1; i<stops.length; i++) {
        const span=fitSpan(points.slice(stops[i-1],stops[i]+1),side,radius,straight);
        if (!span) return null;
        for (let j=1; j<span.length; j++) result.push(span[j]);
    }
    return result;
}
