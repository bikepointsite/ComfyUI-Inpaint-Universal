import { fadeStrokeEnd } from './stroke_fade.js';

const layers = ['dodge', 'burn'];
export const isLightLayer = key => layers.includes(key);

// The visible draft is independent of the image preview. Pointer moves only
// append segments to this transparent canvas. One release commits one mask.
export class LightBrush {
    constructor(frame, makeCanvas, maps) {
        this.makeCanvas = makeCanvas;
        this.maps = maps;
        this.layers = {};
        this.draft = makeCanvas();
        this.draft.setAttribute('aria-hidden', 'true');
        Object.assign(this.draft.style, {position:'absolute', inset:'0', width:'100%', height:'100%',
            pointerEvents:'none', opacity:'.32', display:'none'});
        frame.append(this.draft);
        this.ctx = this.draft.getContext('2d');
        this.bounds = null;
    }

    async load(data) {
        for (const key of layers) {
            const strokes = data.light_strokes?.[key];
            if (!strokes?.length) continue;
            const base = this.makeCanvas();
            const image = new Image();
            image.src = 'data:image/png;base64,' + data[key + '_base_png'];
            await image.decode();
            base.getContext('2d').drawImage(image, 0, 0);
            this.layers[key] = {base, strokes, encoded:data[key + '_base_png']};
        }
    }

    serialize() {
        const data = {}, strokes = {};
        for (const [key, state] of Object.entries(this.layers)) {
            data[key + '_base_png'] = state.encoded ??= state.base.toDataURL('image/png').split(',')[1];
            strokes[key] = state.strokes;
        }
        if (Object.keys(strokes).length) data.light_strokes = strokes;
        return data;
    }

    snapshot(keys) {
        const saved = keys.map(key => {
            const state = this.layers[key];
            if (!state) return [key, null];
            const base = this.makeCanvas();
            base.getContext('2d').drawImage(state.base, 0, 0);
            return [key, {base, strokes:state.strokes, encoded:state.encoded}];
        });
        return () => { for (const [key, state] of saved) {
            if (state) this.layers[key] = state;
            else delete this.layers[key];
        }};
    }

    draw(points, last, diameter, key, erase, holdPercent=100) {
        if (!points.length) return;
        const ctx = this.ctx, start = last || points[0], pad = diameter / 2 + 2;
        if (!this.bounds) {
            this.holdPercent = holdPercent;
            this.fadePath = !erase && holdPercent < 100 ? [start] : null;
            this.draft.style.display = 'block';
            // The mask itself is always white; only the on-screen indicator changes.
            this.draft.style.filter = key === 'burn' && !erase ? 'invert(1)' : 'none';
            this.bounds = [start[0]-pad, start[1]-pad, start[0]+pad, start[1]+pad];
        }
        ctx.lineWidth = diameter;
        ctx.strokeStyle = ctx.fillStyle = 'white';
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(...start);
        for (const point of points) {
            const [x,y] = point;
            if (this.fadePath) {
                const previous = this.fadePath.at(-1);
                if (previous[0] !== x || previous[1] !== y) this.fadePath.push(point);
            }
            ctx.lineTo(x, y);
            const b = this.bounds;
            b[0] = Math.min(b[0], x-pad); b[1] = Math.min(b[1], y-pad);
            b[2] = Math.max(b[2], x+pad); b[3] = Math.max(b[3], y+pad);
        }
        ctx.stroke();
        if (!last) {
            ctx.beginPath(); ctx.arc(...start, diameter/2, 0, Math.PI*2); ctx.fill();
        }
    }

    finish(commit) {
        if (!this.bounds) return;
        const [left, top, right, bottom] = this.bounds;
        const x = Math.max(0, Math.floor(left)), y = Math.max(0, Math.floor(top));
        const w = Math.min(this.draft.width, Math.ceil(right)) - x;
        const h = Math.min(this.draft.height, Math.ceil(bottom)) - y;
        if (w > 0 && h > 0) {
            if (commit) {
                const patch = document.createElement('canvas');
                patch.width = w; patch.height = h;
                const context = patch.getContext('2d', {willReadFrequently:true});
                context.drawImage(this.draft, x, y, w, h, 0, 0, w, h);
                if (this.fadePath?.length > 1) {
                    const pixels = context.getImageData(0, 0, w, h);
                    fadeStrokeEnd(pixels, x, y, this.fadePath, this.holdPercent);
                    context.putImageData(pixels, 0, 0);
                }
                commit(patch, x, y);
            }
            this.ctx.clearRect(x, y, w, h);
        }
        this.draft.style.display = 'none';
        this.fadePath = null;
        this.bounds = null;
    }

    apply(key, patch, x, y, accumulate, erase, amount) {
        const visible = this.maps[key];
        let state = this.layers[key];
        if (accumulate && !erase && !state) {
            const base = this.makeCanvas();
            base.getContext('2d').drawImage(visible.canvas, 0, 0);
            state = this.layers[key] = {base, strokes:[]};
        }
        if (state && (erase || accumulate)) {
            const png = patch.toDataURL('image/png').split(',')[1];
            state.strokes = [...state.strokes, {x, y, png, ...(erase ? {erase:true} : {amount})}];
        }
        if (erase) {
            const c = patch.getContext('2d');
            c.globalCompositeOperation = 'source-in';
            c.fillStyle = 'black'; c.fillRect(0, 0, patch.width, patch.height);
            c.globalCompositeOperation = 'source-over';
        }
        const coverage = erase ? null : patch.getContext('2d').getImageData(0, 0, patch.width, patch.height).data;
        function updateMask(context) {
            if (erase) {
                context.drawImage(patch, x, y);
                return;
            }
            // A union must be idempotent even at antialiased subpixel edges.
            const mask = context.getImageData(x, y, patch.width, patch.height);
            for (let i=0; i<coverage.length; i+=4) {
                const v = Math.max(mask.data[i], coverage[i+3]);
                mask.data[i] = mask.data[i+1] = mask.data[i+2] = v;
            }
            context.putImageData(mask, x, y);
        }
        updateMask(visible.context);
        if (state && (erase || !accumulate)) {
            updateMask(state.base.getContext('2d', {willReadFrequently:true}));
            state.encoded=null;
        }
    }

    applySelection(key, pixels, accumulate, amount) {
        let left=pixels.width, top=pixels.height, right=-1, bottom=-1;
        for (let y=0; y<pixels.height; y++) for (let x=0; x<pixels.width; x++) {
            if (!pixels.data[(y*pixels.width+x)*4]) continue;
            left=Math.min(left,x); right=Math.max(right,x); top=Math.min(top,y); bottom=y;
        }
        if (right<left) return;
        const patch=document.createElement('canvas');
        patch.width=right-left+1; patch.height=bottom-top+1;
        const c=patch.getContext('2d'), alpha=c.createImageData(patch.width,patch.height);
        alpha.data.fill(255);
        for (let y=0; y<patch.height; y++) for (let x=0; x<patch.width; x++) {
            alpha.data[(y*patch.width+x)*4+3]=pixels.data[((top+y)*pixels.width+left+x)*4];
        }
        c.putImageData(alpha,0,0);
        this.apply(key,patch,left,top,accumulate,false,amount);
    }
}
