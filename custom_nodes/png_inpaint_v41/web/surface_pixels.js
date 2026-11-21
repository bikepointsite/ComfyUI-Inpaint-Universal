import { t as inpaintText } from '/extensions/png_inpaint_v4/language.js';
// The source and local-preview endpoints normalize images to non-interlaced
// 8-bit RGBA PNG. Read those straight RGB bytes before changing alpha. A 2D
// canvas round-trip would reduce a channel with alpha 1 to just 0 or 255.
export async function readSurfacePixels(url, width, height) {
    const png = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const header = new DataView(png.buffer);
    if (png.length < 33 || header.getUint32(0) !== 0x89504e47 ||
        header.getUint32(12) !== 0x49484452 || header.getUint32(16) !== width ||
        header.getUint32(20) !== height || png[24] !== 8 || png[25] !== 6 || png[28] !== 0) {
        throw new Error(inpaintText("Не удалось прочитать RGBA-предпросмотр PNG."));
    }
    const chunks = [];
    for (let at = 8; at + 12 <= png.length;) {
        const size = header.getUint32(at), type = header.getUint32(at + 4);
        if (size > png.length - at - 12) throw new Error(inpaintText("Повреждён блок предпросмотра PNG."));
        if (type === 0x49444154) chunks.push(png.subarray(at + 8, at + 8 + size)); // IDAT
        if (type === 0x49454e44) break; // IEND
        at += 12 + size;
    }
    const stream = new Blob(chunks).stream().pipeThrough(new DecompressionStream("deflate"));
    const rows = new Uint8Array(await new Response(stream).arrayBuffer());
    const stride = width * 4;
    if (rows.length !== height * (stride + 1)) throw new Error(inpaintText("Неверная длина RGBA-предпросмотра."));
    const pixels = new Uint8Array(height * stride);
    for (let y = 0; y < height; y++) {
        const src = y * (stride + 1), dst = y * stride, filter = rows[src];
        pixels.set(rows.subarray(src + 1, src + stride + 1), dst);
        if (!filter) continue;
        if (filter > 4) throw new Error(inpaintText("Неизвестный фильтр предпросмотра PNG."));
        for (let x = 0; x < stride; x++) {
            const i = dst + x;
            const left = x >= 4 ? pixels[i - 4] : 0, up = y ? pixels[i - stride] : 0;
            if (filter === 1) pixels[i] += left;
            else if (filter === 2) pixels[i] += up;
            else if (filter === 3) pixels[i] += (left + up) >> 1;
            else {
                const corner = y && x >= 4 ? pixels[i - stride - 4] : 0;
                const l = Math.abs(up - corner), u = Math.abs(left - corner);
                const c = Math.abs(left + up - 2 * corner);
                pixels[i] += l <= u && l <= c ? left : u <= c ? up : corner;
            }
        }
    }
    return new ImageData(new Uint8ClampedArray(pixels.buffer), width, height);
}
