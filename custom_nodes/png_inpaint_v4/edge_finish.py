"""Retouch a painted strip along the current foreground silhouette, in straight RGBA."""
import base64
import io
import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates
from scipy.spatial import cKDTree


def read_edge_pixels(record, shape):
    """A cropped, lossless signed RGBA adjustment, independent of editable masks."""
    if record is None:
        return None
    if not isinstance(record, dict):
        raise ValueError('Повреждены сохранённые пиксели доводки края.')
    x, y = record.get('x'), record.get('y')
    if type(x) is not int or type(y) is not int or not (0 <= x < shape[1] and 0 <= y < shape[0]):
        raise ValueError('Область доводки выходит за пределы изображения.')
    with Image.open(io.BytesIO(base64.b64decode(record['png'], validate=True))) as image:
        w, h = image.size
        # Four signed channels stored side by side in a single 16-bit grayscale PNG.
        if (image.format != 'PNG' or image.mode not in ('I;16', 'I') or w % 4
                or x + w//4 > shape[1] or y+h > shape[0]):
            raise ValueError('Некорректный размер или формат доводки края.')
        values = np.asarray(image).reshape(h, w//4, 4)
        if values.max() > 510 or np.any(values[..., 3] > 255):
            raise ValueError('Некорректные значения доводки края.')
        return y, x, values.astype(np.int16) - 255


def write_edge_pixels(previous, before, after, changed):
    if not changed.any():
        return previous
    ys, xs = np.nonzero(changed)
    top, left, bottom, right = ys.min(), xs.min(), ys.max()+1, xs.max()+1
    old = read_edge_pixels(previous, after.shape[:2])
    if old is not None:
        y, x, values = old
        top, left = min(top, y), min(left, x)
        bottom, right = max(bottom, y+values.shape[0]), max(right, x+values.shape[1])
    delta = np.zeros((bottom-top, right-left, 4), np.int16)
    if old is not None:
        delta[y-top:y-top+values.shape[0], x-left:x-left+values.shape[1]] = values
    delta[ys-top, xs-left] = after[ys, xs].astype(np.int16) - before[ys, xs]
    return _pack_edge(top, left, delta)


def _pack_edge(top, left, delta):
    if not np.any(delta):
        return None
    encoded = (delta.clip(-255, 255) + 255).astype('<u2').reshape(delta.shape[0], -1)
    buf = io.BytesIO()
    Image.fromarray(encoded).save(buf, format='PNG', compress_level=3)
    return {'x': int(left), 'y': int(top), 'png': base64.b64encode(buf.getvalue()).decode()}


def erase_edge_pixels(record, paint, protect):
    patch = read_edge_pixels(record, paint.shape)
    if patch is None:
        return None
    y, x, delta = patch
    roi = np.s_[y:y+delta.shape[0], x:x+delta.shape[1]]
    retain = 1. - paint[roi] * (protect[roi] <= 0)
    return _pack_edge(y, x, np.rint(delta * retain[..., None]).astype(np.int16))


def apply_edge_pixels(result, touched, record):
    patch = read_edge_pixels(record, result.shape[:2])
    if patch is None:
        return
    y, x, delta = patch
    roi = np.s_[y:y+delta.shape[0], x:x+delta.shape[1]]
    target = result[roi]
    active = np.any(delta != 0, axis=2) & (target[..., 3] > 0)
    target[active] = np.clip(target[active].astype(np.int16) + delta[active], 0, 255).astype(np.uint8)
    touched[roi] |= active


def _blur(array, sigma):
    return cv2.GaussianBlur(array, (0, 0), sigma, borderType=cv2.BORDER_REPLICATE)


def _sample(array, y, x):
    return map_coordinates(array, [y, x], order=1, mode='nearest', prefilter=False)


def finish_edge(result, mark, protection, amount, smooth_alpha):
    """Write only selected pixels. Return their actual change mask for the final compositor."""
    changed = np.zeros(result.shape[:2], bool)
    if mark is None or (amount <= 0 and not smooth_alpha):
        return changed
    rows = np.flatnonzero(np.any(mark, axis=1))
    if not rows.size:
        return changed
    cols = np.flatnonzero(np.any(mark, axis=0))
    # Bound temporary RGB/gradient buffers even for widely separated strokes on a large PNG.
    tile = 512
    multiple = rows[-1]-rows[0] >= tile or cols[-1]-cols[0] >= tile
    source = result.copy() if multiple else result
    for top in range(rows[0], rows[-1]+1, tile):
        bottom = min(top+tile, rows[-1]+1)
        for left in range(cols[0], cols[-1]+1, tile):
            right = min(left+tile, cols[-1]+1)
            if mark[top:bottom, left:right].any():
                _finish_tile(source, result, mark, protection, amount, smooth_alpha, changed, top, bottom, left, right)
    return changed


def _finish_tile(source, result, mark, protection, amount, smooth_alpha, changed, top, bottom, left, right):
    # Include intact contour samples plus room for sampling inward from each donor.
    margin = 140
    y0, x0 = max(0, top-margin), max(0, left-margin)
    roi = np.s_[y0:bottom+margin, x0:right+margin]
    patch = source[roi]
    output = result[roi]
    paint = mark[roi]
    alpha = patch[..., 3]
    solid = (alpha >= 128).astype(np.uint8)
    kernel = np.ones((3, 3), np.uint8)
    boundary = solid > cv2.erode(solid, kernel, borderType=cv2.BORDER_REPLICATE)
    if not boundary.any():
        return
    inside = cv2.distanceTransform(solid, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    outside = cv2.distanceTransform(1-solid, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
    depth = inside - outside
    affected = (paint > 0) & (protection[roi] <= 0) & (alpha > 0) & (depth < 12) & (depth >= -4)
    y, x = np.nonzero(affected[top-y0:bottom-y0, left-x0:right-x0])
    if not y.size:
        return
    y += top-y0
    x += left-x0
    before = patch[y, x].copy()
    # Feather across the ends of the stroke before clipping it to the silhouette.
    support = cv2.copyMakeBorder((paint > 0).astype(np.uint8), 1, 1, 1, 1, cv2.BORDER_REPLICATE)
    reach = cv2.distanceTransform(support, cv2.DIST_L2, 3)[1:-1, 1:-1]
    stroke = paint[y, x] * np.clip(reach[y, x] / 3., .3, 1.)
    if amount > 0:
        coverage = alpha.astype(np.float32) / 255.
        denominator = _blur(coverage, 1.1)
        rgb = patch[..., :3].astype(np.float32)
        surface = _blur(rgb * coverage[..., None], 1.1) / np.maximum(denominator[..., None], 1e-6)
        distance = _blur(np.clip(depth, -16, 16), 1.5)
        nx = cv2.Sobel(distance, cv2.CV_32F, 1, 0, ksize=3, borderType=cv2.BORDER_REPLICATE)
        ny = cv2.Sobel(distance, cv2.CV_32F, 0, 1, ksize=3, borderType=cv2.BORDER_REPLICATE)
        norm = np.maximum(np.hypot(nx, ny), 1e-6)
        nx /= norm
        ny /= norm

        def inward(yy, xx, target_depth):
            step = np.maximum(0., target_depth - depth[yy, xx])
            sy, sx = yy + ny[yy, xx]*step, xx + nx[yy, xx]*step
            value = np.column_stack([_sample(surface[..., c], sy, sx) for c in range(3)])
            # A narrow fold or strand may have another surface across a gap.
            valid = (_sample(depth, sy, sx) >= target_depth*.65) & (
                _sample(depth, (yy+sy)*.5, (xx+sx)*.5) >= 1.)
            return value, valid

        inner, valid = inward(y, x, 8.)
        deeper, deep_valid = inward(y, x, 13.)
        # Without a matching intact edge, gently continue the local light gradient.
        delta = np.clip((inner-deeper)*1.25, -16, 16) * deep_valid[:, None]
        # Connect translucent fringe pixels to the same foreground component as their inward sample.
        _, components = cv2.connectedComponents(solid, connectivity=8)
        probe = np.maximum(3., 2.-depth[y, x])
        iy = np.clip(np.rint(y + ny[y, x]*probe).astype(int), 0, solid.shape[0]-1)
        ix = np.clip(np.rint(x + nx[y, x]*probe).astype(int), 0, solid.shape[1]-1)
        target_component = np.where(solid[y, x] > 0, components[y, x], components[iy, ix])
        by, bx = np.nonzero(boundary & (cv2.dilate(paint, kernel) == 0))
        if by.size:
            donor_inner, usable = inward(by, bx, 8.)
            by, bx, donor_inner = by[usable], bx[usable], donor_inner[usable]
            donor_delta = np.clip(surface[by, bx]-donor_inner, -40, 40)
            # Match position, interior material colour, and edge direction.
            def features(yy, xx, color):
                return np.column_stack((yy*.45, xx*.45, color*.85, ny[yy, xx]*23, nx[yy, xx]*23))

            for label in np.unique(target_component[valid]):
                if not label:
                    continue
                samples = components[by, bx] == label
                if not samples.any():
                    continue
                target = (target_component == label) & valid
                tree = cKDTree(features(by[samples], bx[samples], donor_inner[samples]))
                distances, ids = tree.query(features(y[target], x[target], inner[target]),
                                            k=[1, 2, 3, 4], distance_upper_bound=55.)
                weights = np.maximum(0., 1.-distances/55.)**2
                contrasts = donor_delta[samples]
                values = contrasts[np.minimum(ids, len(contrasts)-1)]
                total = weights.sum(axis=1)
                estimate = (weights[..., None]*values).sum(axis=1) / np.maximum(total[:, None], 1e-9)
                confidence = np.clip(total, 0, 1)[:, None]
                delta[target] += confidence * (estimate-delta[target])

        t = np.clip((12.-np.maximum(depth[y, x], 1.))/11., 0, 1)
        falloff = t*t*(3-2*t)
        # Correct the broad tone while preserving fine foreground texture.
        adjustment = np.clip(inner + delta - surface[y, x], -46, 46)
        blend = (amount * stroke * falloff * valid)[:, None]
        output[y, x, :3] = np.rint(before[:, :3]+blend*adjustment).clip(0, 255).astype(np.uint8)

    if smooth_alpha:
        filtered = cv2.GaussianBlur(alpha.astype(np.float32), (3, 3), .7, borderType=cv2.BORDER_REPLICATE)
        drop = np.maximum(0., before[:, 3]-filtered[y, x])
        narrow = np.abs(depth[y, x]) <= 1.42
        output[y, x, 3] = np.rint(before[:, 3]-drop*stroke*narrow).astype(np.uint8)
    changed[y+y0, x+x0] = np.any(before != output[y, x], axis=1)
