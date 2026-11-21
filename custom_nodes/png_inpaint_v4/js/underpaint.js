import { t as inpaintText } from './language.js';
// A straight-alpha paint layer behind the sprite. Keep the display background
// and mask overlays out of both the eyedropper and the saved PNG.
export class Underpaint {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.pixels = null;
        this.png = undefined;
    }

    restore(pixels) {
        this.pixels = pixels;
        this.png = undefined;
    }

    snapshot() {
        return this.pixels?.slice() ?? null;
    }

    async load(png) {
        if (!png) return;
        const image = new Image();
        image.src = 'data:image/png;base64,' + png;
        await image.decode();
        if (image.width !== this.width || image.height !== this.height) throw new Error(inpaintText("Неверный размер слоя дорисовки."));
        const ctx = this.context();
        ctx.drawImage(image, 0, 0);
        this.restore(ctx.getImageData(0, 0, this.width, this.height).data);
        this.png = png;
    }

    context() {
        const canvas = document.createElement('canvas');
        canvas.width = this.width;
        canvas.height = this.height;
        return canvas.getContext('2d');
    }

    encode() {
        if (!this.pixels) return undefined;
        if (this.png === undefined) {
            const ctx = this.context();
            ctx.putImageData(new ImageData(this.pixels, this.width, this.height), 0, 0);
            this.png = ctx.canvas.toDataURL('image/png').split(',')[1];
        }
        return this.png;
    }

    composite(image, cut, src = this.pixels) {
        if (!src) return image;
        const dst = image.data;
        for (let i = 0; i < dst.length; i += 4) {
            if (dst[i+3] === 255 || !src[i+3]) continue;
            const backAlpha = cut ? Math.round(src[i+3] * (1 - cut.data[i]/255)) : src[i+3];
            const a = dst[i+3] * 255, b = backAlpha * (255 - dst[i+3]), sum = a + b;
            if (!b) continue;
            for (let c = 0; c < 3; c++) dst[i+c] = Math.round((dst[i+c]*a + src[i+c]*b) / sum);
            dst[i+3] = Math.round(sum / 255);
        }
        return image;
    }

    // brush is only the dirty rectangle. A clone stroke samples a frozen,
    // unadorned image so drawing cannot feed pixels back into its own donor.
    stroke(x, y, brush, {surface, protect, color, offset, erase = false, grayMask = false}) {
        if (!this.pixels && erase) return;
        const {width, height, data} = brush;
        for (let j = 0; j < height; j++) for (let k = 0; k < width; k++) {
            const i = ((y+j)*this.width + x+k)*4;
            let coverage = data[(j*width+k)*4 + (grayMask ? 0 : 3)];
            if (!coverage || protect?.[i]) continue;
            if (erase) {
                this.pixels[i+3] = Math.round(this.pixels[i+3] * (1 - coverage/255));
                continue;
            }
            if (surface[i+3] === 255 || this.pixels?.[i+3] === 255) continue;
            let sample = color, index = 0;
            if (offset) {
                const sx = x+k+offset[0], sy = y+j+offset[1];
                if (sx < 0 || sx >= this.width || sy < 0 || sy >= this.height) continue;
                sample = surface;
                index = (sy*this.width+sx)*4;
                coverage = Math.round(coverage * sample[index+3]/255);
                if (!coverage) continue;
            }
            this.pixels ??= new Uint8ClampedArray(this.width*this.height*4);
            const a = this.pixels[i+3]*255, b = coverage*(255-this.pixels[i+3]), total = a+b;
            for (let c = 0; c < 3; c++) this.pixels[i+c] = Math.round((this.pixels[i+c]*a + sample[index+c]*b)/total);
            this.pixels[i+3] = Math.round(total/255);
        }
        this.png = undefined;
    }
}
