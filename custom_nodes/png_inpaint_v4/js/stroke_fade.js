// Find the distance travelled along the centreline nearest a covered pixel.
// Bounding boxes skip distant runs of a curve, even on a wide brush.
function segmentBounds(segments, first, end) {
    const node = {first, end};
    if (end - first <= 8) {
        node.left = node.top = Infinity;
        node.right = node.bottom = -Infinity;
        for (let i = first; i < end; i++) {
            const s = segments[i];
            node.left = Math.min(node.left, s.x, s.x + s.dx);
            node.right = Math.max(node.right, s.x, s.x + s.dx);
            node.top = Math.min(node.top, s.y, s.y + s.dy);
            node.bottom = Math.max(node.bottom, s.y, s.y + s.dy);
        }
    } else {
        const mid = first + Math.floor((end - first) / 2);
        const a = node.a = segmentBounds(segments, first, mid);
        const b = node.b = segmentBounds(segments, mid, end);
        node.left = Math.min(a.left, b.left); node.right = Math.max(a.right, b.right);
        node.top = Math.min(a.top, b.top); node.bottom = Math.max(a.bottom, b.bottom);
    }
    return node;
}

function boxDistance(x, y, box) {
    const dx = Math.max(0, box.left - x, x - box.right);
    const dy = Math.max(0, box.top - y, y - box.bottom);
    return dx*dx + dy*dy;
}

export function fadeStrokeEnd(pixels, left, top, points, holdPercent) {
    if (holdPercent >= 100 || points.length < 2) return;
    const segments = [];
    let length = 0;
    for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i - 1];
        const dx = points[i][0] - x, dy = points[i][1] - y;
        const span = Math.hypot(dx, dy);
        if (!span) continue;
        segments.push({x, y, dx, dy, span, invSquare:1/(span*span), start:length});
        length += span;
    }
    if (!length) return; // A single dab has no direction.
    const root = segmentBounds(segments, 0, segments.length);
    const stack = [];
    const hold = length * holdPercent / 100;
    for (let row = 0; row < pixels.height; row++) {
        const y = top + row + .5;
        for (let col = 0; col < pixels.width; col++) {
            const alpha = (row * pixels.width + col) * 4 + 3;
            if (!pixels.data[alpha]) continue;
            const x = left + col + .5;
            let nearest = Infinity, along = Infinity;
            stack.push(root);
            while (stack.length) {
                const node = stack.pop();
                if (boxDistance(x,y,node) > nearest) continue;
                if (node.a) {
                    // Visit the nearer half first to tighten the search radius.
                    if (boxDistance(x,y,node.a) < boxDistance(x,y,node.b)) stack.push(node.b,node.a);
                    else stack.push(node.a,node.b);
                    continue;
                }
                for (let j = node.first; j < node.end; j++) {
                    const s = segments[j], vx = x - s.x, vy = y - s.y;
                    const t = Math.max(0, Math.min(1, (vx*s.dx + vy*s.dy) * s.invSquare));
                    const rx = vx - t*s.dx, ry = vy - t*s.dy;
                    const distance = rx*rx + ry*ry, position = s.start + t*s.span;
                    if (distance < nearest || (distance === nearest && position < along)) {
                        nearest = distance; along = position;
                    }
                }
            }
            if (along <= hold) continue;
            const t = Math.min(1, (along - hold) / (length - hold));
            pixels.data[alpha] = Math.round(pixels.data[alpha] * (1 - t*t*(3 - 2*t)));
        }
    }
}
