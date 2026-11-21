import { t as inpaintText } from '/extensions/png_inpaint_v4/language.js';
import { SmoothContour } from "./smooth_contour.js";

// Store the original grayscale planes only for tiles touched by this stroke.
// One undo restores all four editable generation masks together.
function maskStroke(maps) {
    const tile=96,saved=new Map();
    const {width,height}=maps.mask.canvas;
    const contexts=Object.values(maps);
    function capture(x,y){
        const key=y*width+x;
        if(saved.has(key))return;
        const w=Math.min(tile,width-x),h=Math.min(tile,height-y);
        const planes=contexts.map(ctx=>{
            const {data}=ctx.getImageData(x,y,w,h),plane=new Uint8Array(w*h);
            for(let i=0;i<plane.length;i++)plane[i]=data[i*4];
            return plane;
        });
        saved.set(key,{x,y,w,h,planes});
    }
    function paint(stamp,points,last,diameter){
        const pad=diameter/2+2;
        let minX=width,minY=height,maxX=0,maxY=0,from=last||points[0];
        for(const to of points){
            const x=Math.max(0,Math.floor(Math.min(from[0],to[0])-pad)),y=Math.max(0,Math.floor(Math.min(from[1],to[1])-pad));
            const right=Math.min(width,Math.ceil(Math.max(from[0],to[0])+pad)),bottom=Math.min(height,Math.ceil(Math.max(from[1],to[1])+pad));
            for(let ty=Math.floor(y/tile)*tile;ty<bottom;ty+=tile)
                for(let tx=Math.floor(x/tile)*tile;tx<right;tx+=tile)capture(tx,ty);
            minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,right);maxY=Math.max(maxY,bottom);
            from=to;
        }
        const w=maxX-minX,h=maxY-minY;if(w<=0||h<=0)return;
        const rect=[minX,minY,w,h,minX,minY,w,h];
        maps.strength.drawImage(stamp,...rect); // White restores the mode's full strength.
        const ink=stamp.getContext("2d");
        ink.save();ink.globalCompositeOperation="source-in";ink.fillStyle="black";
        ink.fillRect(minX,minY,w,h);ink.restore();
        for(const ctx of [maps.mask,maps.protect,maps.guide])ctx.drawImage(stamp,...rect);
    }
    function restore(){
        for(const {x,y,w,h,planes} of saved.values()){
            const img=maps.mask.createImageData(w,h);
            for(let k=0;k<contexts.length;k++){
                const plane=planes[k];
                for(let i=0;i<plane.length;i++){
                    const j=4*i;img.data[j]=img.data[j+1]=img.data[j+2]=plane[i];img.data[j+3]=255;
                }
                contexts[k].putImageData(img,x,y);
            }
        }
    }
    return {paint,restore};
}

export function installStrokeTools({dialog,pathMode,curveTypes,refresh,surface,maps}){
    const options={offset:0};
    let draft=null;
    pathMode.add(new Option(inpaintText("Плавный контур"),"contourStroke"));
    curveTypes.contourStroke=class extends SmoothContour {
        constructor(){
            super(options,surface,()=>maps.mask.getImageData(0,0,maps.mask.canvas.width,maps.mask.canvas.height));
            draft=this;
        }
    };
    dialog.contourStroke={
        options,refresh,
        snap(inMask){
            if(pathMode.value!=="contourStroke")return;
            draft?.snapToBoundary(inMask);
            refresh();
        },
        get pointCount(){return draft?.points.length||0;},
        get message(){return draft?.message||"";},
        get undoSnap(){return draft?.history.at(-1)?.action==="snap";},
    };
    let stroke=null;
    return {
        beginStroke(){
            stroke=dialog.dataset.eraseAll==="true"?maskStroke(maps):null;
            return stroke?.restore;
        },
        paintStroke(stamp,points,last,diameter){
            if(!stroke || dialog.dataset.eraseAll!=="true")return false;
            stroke.paint(stamp,points,last,diameter);return true;
        }
    };
}
