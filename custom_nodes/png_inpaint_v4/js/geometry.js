// Same premultiplied inverse warp as geometry.py; no transparent RGB bleed.
export function warpRGBA(source, width, height, op, protectedPixels=null) {
    const result=new Uint8ClampedArray(source), radius=op.radius,contourOnly=op.mode==='contour';
    const freeEdge=op.mode==='free_edge';
    let dx=(op.to[0]-op.from[0])*op.strength,dy=(op.to[1]-op.from[1])*op.strength;
    const length=Math.hypot(dx,dy);
    if(length<1e-6)return result;
    if(length>radius*.45){dx*=radius*.45/length;dy*=radius*.45/length;}
    const cx=op.from[0]+dx,cy=op.from[1]+dy;
    for(let y=Math.max(0,Math.floor(cy-radius));y<Math.min(height,Math.ceil(cy+radius)+1);y++) {
        for(let x=Math.max(0,Math.floor(cx-radius));x<Math.min(width,Math.ceil(cx+radius)+1);x++) {
            const i=4*(y*width+x),t=((x-cx)**2+(y-cy)**2)/radius**2;
            if(t>=1||(!source[i+3]&&!freeEdge)||protectedPixels?.[i])continue;
            const weight=(1-t)**2,mx=Math.max(0,Math.min(width-1,x-dx*weight)),my=Math.max(0,Math.min(height-1,y-dy*weight));
            const ix=Math.floor(mx),iy=Math.floor(my),fx=mx-ix,fy=my-iy;
            let a=0,r=0,g=0,b=0;
            for(const [ox,oy,c] of [[0,0,(1-fx)*(1-fy)],[1,0,fx*(1-fy)],[0,1,(1-fx)*fy],[1,1,fx*fy]]) {
                const j=4*(Math.min(height-1,iy+oy)*width+Math.min(width-1,ix+ox)),v=source[j+3]*c;
                a+=v;if(!contourOnly){r+=source[j]*v;g+=source[j+1]*v;b+=source[j+2]*v;}
            }
            if(freeEdge&&!source[i+3]&&a<.5)continue;
            if(!contourOnly&&a>1e-6){result[i]=Math.floor(r/a+.5);result[i+1]=Math.floor(g/a+.5);result[i+2]=Math.floor(b/a+.5);}
            if(op.mode==='shrink'||contourOnly||freeEdge){
                result[i+3]=freeEdge?Math.floor(a+.5):Math.min(source[i+3],Math.floor(a+.5));
                if(!contourOnly&&!result[i+3])result[i]=result[i+1]=result[i+2]=0;
            }
        }
    }
    return result;
}
