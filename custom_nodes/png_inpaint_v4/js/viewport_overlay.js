// Draw UI vectors at screen resolution, independently of the PNG's raster size.
// Only allocate the visible portion: zooming a large PNG never creates a huge canvas.
export function prepareViewportOverlay(overlay, image, area, ratio = globalThis.devicePixelRatio || 1) {
    const r = image.getBoundingClientRect(), a = area.getBoundingClientRect();
    const ax = a.left + (area.clientLeft || 0), ay = a.top + (area.clientTop || 0);
    const left = Math.max(r.left, ax), top = Math.max(r.top, ay);
    const width = Math.max(0, Math.min(r.right, ax + area.clientWidth) - left);
    const height = Math.max(0, Math.min(r.bottom, ay + area.clientHeight) - top);
    const c = overlay.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, overlay.width, overlay.height);
    overlay.style.display = width && height ? 'block' : 'none';
    if (!width || !height) return null;
    const x = left - r.left, y = top - r.top;
    Object.assign(overlay.style, {left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`});
    const bw = Math.ceil(width * ratio), bh = Math.ceil(height * ratio);
    if (overlay.width !== bw) overlay.width = bw;
    if (overlay.height !== bh) overlay.height = bh;
    const sx = r.width / image.width, sy = r.height / image.height;
    // Account for rounded backing dimensions so source coordinates stay aligned.
    const dx = bw / width, dy = bh / height;
    c.setTransform(dx * sx, 0, 0, dy * sy, -x * dx, -y * dy);
    return {context: c, scale: sx};
}
