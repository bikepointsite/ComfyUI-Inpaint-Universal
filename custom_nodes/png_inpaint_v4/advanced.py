"""V4 local tools. No GPU, model downloads, or network work at import time."""
import base64
import io
import math
import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt
from .unified import edit_data, decode_canvas
from .edge_finish import finish_edge, apply_edge_pixels, write_edge_pixels

MAPS = ('protect', 'guide', 'strength', 'dodge', 'burn', 'heal')


def decode_tools(payload, sha, shape):
    data = edit_data(payload, sha, shape)
    result = {'ui_language':data.get('ui_language','en')}
    strokes = data.get('light_strokes', {})
    if not isinstance(strokes, dict) or strokes.keys() - {'dodge', 'burn'}:
        raise ValueError('Некорректные слои накопленной светотени.')
    for key in MAPS:
        encoded = data[key + '_base_png'] if key in strokes else data.get(key + '_png')
        result[key] = (decode_canvas(encoded, shape).astype(np.float32)/255 if encoded
                       else np.full(shape, 1. if key == 'strength' else 0., np.float32))
    encoded_edge = data.get('edge_finish_png')
    result['edge_pixels'] = data.get('edge_pixels')
    result['edge_finish'] = decode_canvas(encoded_edge, shape).astype(np.float32)/255 if encoded_edge else None
    result['edge_finish_smooth'] = data.get('edge_finish_smooth', False)
    if not isinstance(result['edge_finish_smooth'], bool):
        raise ValueError('Некорректная настройка сглаживания прозрачности.')
    for key in ('donor', 'heal_anchor', 'reference_donor'):
        point = data.get(key)
        if point is not None:
            if (not isinstance(point, list) or len(point) != 2 or
                not all(isinstance(v,(int,float)) and math.isfinite(v) for v in point) or
                not 0 <= point[0] < shape[1] or not 0 <= point[1] < shape[0]):
                raise ValueError('Точка донора выходит за пределы изображения.')
            point = [float(v) for v in point]
        result[key] = point
    for key, default, maximum in [('light_amount', .25, 1.), ('heal_amount', 1., 1.), ('donor_size',128,512), ('edge_finish_amount', .8, 1.)]:
        value = data.get(key, default)
        if not isinstance(value,(int,float)) or not math.isfinite(value) or not 0 <= value <= maximum:
            raise ValueError('Некорректная сила локальной кисти.')
        result[key] = float(value)
    result['heal_mode'] = data.get('heal_mode','texture')
    result['heal_edge_sampling'] = data.get('heal_edge_sampling') is True
    # Earlier V4.1 editors only wrote the edge-sampling flag. Their open
    # sessions and saved light masks can use the same updated brush.
    result['light_to_edge'] = data.get('light_to_edge', result['heal_edge_sampling']) is True
    if strokes:
        result['stroke_exposure'] = accumulated_exposure(strokes, result['protect'])
    result['editor_mode'] = data.get('editor_mode')
    result['mode_maps'] = data.get('mode_maps',{})
    if not isinstance(result['mode_maps'],dict): raise ValueError('Некорректные сохранённые слои режимов.')
    result['reference_file'] = data.get('reference_file','')
    if not isinstance(result['reference_file'],str): raise ValueError('Некорректное имя образца.')
    result['reference_size'] = data.get('reference_size',data.get('donor_size',128))
    if not isinstance(result['reference_size'],(int,float)) or not math.isfinite(result['reference_size']) or not 1<=result['reference_size']<=512:
        raise ValueError('Размер образца должен быть от 1 до 512 пикселей.')
    if 'reference_donor' not in data: result['reference_donor']=result['donor']
    if result['heal_mode'] not in ('texture','clone'):
        raise ValueError('Неизвестный режим донора.')
    return result


def tools_for_mode(tools,mode):
    if not tools.get('editor_mode') or tools['editor_mode']==mode: return tools
    saved=tools.get('mode_maps',{}).get(mode,{})
    if not isinstance(saved,dict): raise ValueError('Некорректные слои выбранного режима.')
    maps={}
    for key,default in [('guide',0.),('strength',1.)]:
        encoded=saved.get(key)
        maps[key]=decode_canvas(encoded,tools[key].shape).astype(np.float32)/255 if encoded else np.full_like(tools[key],default)
    return dict(tools,**maps)


def protected_mask(mask, tools, rgba, *, allow_extension=False):
    """Every touched protection pixel is a strict lock, including brush antialias."""
    locked = tools['protect'] > 0
    if not allow_extension:
        locked = locked | (rgba[..., 3] == 0)
    return np.where(locked, 0., mask).astype(np.float32)


def soft_weight(mask, radius=5, *, fade_at_canvas_edge=True):
    support = mask > 0
    if not support.any(): return np.zeros_like(mask)
    if fade_at_canvas_edge:
        distance = distance_transform_edt(np.pad(support,1))[1:-1,1:-1]
    elif support.all():
        return mask.copy()
    else:
        distance = distance_transform_edt(support)
    radius = min(radius, max(1., float(distance.max())))
    t = np.clip(distance/radius,0,1)
    return (mask * t*t*(3-2*t)).astype(np.float32)


def accumulated_exposure(layers, protect):
    height, width = protect.shape
    total = np.zeros_like(protect)
    for key, strokes in layers.items():
        if not isinstance(strokes, list):
            raise ValueError('Некорректные мазки светотени.')
        plane = np.zeros_like(protect)
        for stroke in strokes:
            if not isinstance(stroke, dict):
                raise ValueError('Некорректный мазок светотени.')
            x, y, encoded = stroke.get('x'), stroke.get('y'), stroke.get('png')
            if (type(x) is not int or type(y) is not int or x < 0 or y < 0
                    or not isinstance(encoded, str) or len(encoded) > 48_000_000):
                raise ValueError('Некорректная область мазка светотени.')
            with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as patch:
                w, h = patch.size
                if patch.format != 'PNG' or x+w > width or y+h > height:
                    raise ValueError('Маска мазка вышла за пределы изображения.')
                coverage = patch if 'A' in patch.getbands() else patch.convert('RGBA')
                mask = np.asarray(coverage.getchannel('A'), dtype=np.float32) / 255
            region = np.s_[y:y+h, x:x+w]
            if stroke.get('erase') is True:
                plane[region] *= 1-mask
                continue
            amount = stroke.get('amount')
            if not isinstance(amount, (float, int)) or not 0 <= amount <= 1:
                raise ValueError('Некорректная сила мазка светотени.')
            mask[protect[region] > 0] = 0
            # Internal crop edges border zero coverage. Actual canvas edges
            # continue the stroke, as in the V4.1 non-accumulating brush.
            t, b, l, r = int(y > 0), int(y+h < height), int(x > 0), int(x+w < width)
            padded = np.pad(mask, ((t,b), (l,r)))
            weights = soft_weight(padded, 48, fade_at_canvas_edge=False)
            plane[region] += weights[t:t+h, l:l+w] * amount
        total += plane if key == 'dodge' else -plane
    return total


def apply_local(rgba, tools, summary=None, commit_edge=False):
    """Apply local retouch, then finish the accepted silhouette on the resulting surface."""
    result = rgba.copy()
    touched = np.zeros(rgba.shape[:2], bool)
    if 'stroke_exposure' in tools or any(tools[key].any() for key in ('heal', 'dodge', 'burn')):
        touched = _apply_surface_tools(result, tools)
    before = result.copy() if commit_edge and tools.get('edge_finish') is not None else None
    apply_edge_pixels(result, touched, tools.get('edge_pixels'))
    if tools.get('edge_finish') is not None:
        edge_changes = finish_edge(result, tools['edge_finish'], tools['protect'],
                                   tools.get('edge_finish_amount', .8), tools.get('edge_finish_smooth', False))
        if summary is not None:
            summary['edge_finish_pixels'] = int(np.count_nonzero(edge_changes))
            if commit_edge:
                summary['edge_pixels'] = write_edge_pixels(tools.get('edge_pixels'), before, result, edge_changes)
        touched |= edge_changes
    return result, touched


def _heal_patch(rgba, left, top, width, height, component):
    """Read a local premultiplied patch, treating positions outside the PNG as empty."""
    # A Gaussian with sigma 5 uses 20 px of context on either side.
    margin = 0 if component == 'clone' else 20
    x, y = left - margin, top - margin
    patch = np.zeros((height + 2*margin, width + 2*margin, 4), np.float32)
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(rgba.shape[1], x + patch.shape[1]), min(rgba.shape[0], y + patch.shape[0])
    if x0 < x1 and y0 < y1:
        patch[y0-y:y1-y, x0-x:x1-x] = rgba[y0:y1, x0:x1]
    patch /= 255
    patch[..., :3] *= patch[..., 3:]
    if component == 'clone':
        return patch

    core = np.s_[margin:margin+height, margin:margin+width]
    blurred = cv2.GaussianBlur(patch, (41, 41), 5, borderType=cv2.BORDER_CONSTANT)[core]
    tone = blurred[..., :3]
    np.divide(tone, blurred[..., 3:], out=tone, where=blurred[..., 3:] > 0)
    if component == 'tone':
        return tone
    detail = patch[core]
    detail[..., :3] -= tone * detail[..., 3:]
    return detail


def _apply_edge_heal(rgba, heal, out, tools):
    x, y, width, height = cv2.boundingRect((heal > 0).astype(np.uint8))
    rect = np.s_[y:y+height, x:x+width]
    dx = tools['donor'][0] - tools['heal_anchor'][0]
    dy = tools['donor'][1] - tools['heal_anchor'][1]
    ix, iy = math.floor(dx), math.floor(dy)
    fx, fy = dx - ix, dy - iy
    texture = tools['heal_mode'] == 'texture'
    patch = _heal_patch(rgba, x+ix, y+iy, width+1, height+1, 'detail' if texture else 'clone')
    # Interpolate premultiplied colour and coverage together. Hidden RGB has zero weight.
    rows = patch[:, :-1] * (1-fx) + patch[:, 1:] * fx
    donor = rows[:-1] * (1-fy) + rows[1:] * fy
    coverage = donor[..., 3:]
    brush = heal[rect]
    visible = coverage[..., 0] > 0
    if not np.any((brush > 0) & visible):
        raise ValueError('Под штрихом нет видимых пикселей образца. Выберите фактуру на краю или внутри поверхности.')
    color = donor[..., :3]
    np.divide(color, coverage, out=color, where=coverage > 0)
    if texture:
        color += _heal_patch(rgba, x, y, width, height, 'tone')
    weight = soft_weight(brush)[..., None] * tools['heal_amount'] * coverage
    out[rect] += (np.clip(color, 0, 1) - out[rect]) * weight
    brush[~visible] = 0  # Also exclude skipped pixels from the result's touched mask.


def _apply_surface_tools(rgba, tools):
    source = rgba[...,:3].astype(np.float32)/255
    out = source.copy()
    allowed = (rgba[...,3] > 0) & (tools['protect'] <= 0)
    heal = tools['heal'] * allowed
    if heal.any():
        if tools['donor'] is None or tools['heal_anchor'] is None:
            raise ValueError('Для лечения выберите донора Alt+кликом и закрасьте дефект.')
        if tools.get('heal_edge_sampling'):
            _apply_edge_heal(rgba, heal, out, tools)
        else:
            dx,dy = np.subtract(tools['donor'],tools['heal_anchor'])
            yy,xx = np.mgrid[:heal.shape[0],:heal.shape[1]].astype(np.float32)
            mx,my = (xx+dx).astype(np.float32),(yy+dy).astype(np.float32)
            valid = (mx>=0)&(my>=0)&(mx<=heal.shape[1]-1)&(my<=heal.shape[0]-1)
            donor_alpha = cv2.remap(rgba[...,3],mx,my,cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)
            if np.any((heal>0)&(~valid | (donor_alpha<128))):
                raise ValueError('Донор попал на прозрачный край. Выберите участок внутри поверхности или уменьшите область лечения.')
            donor = cv2.remap(source,mx,my,cv2.INTER_LINEAR,borderMode=cv2.BORDER_REFLECT_101)
            if tools['heal_mode'] == 'texture':
                # Transfer detail while retaining the target's broad color and illumination.
                donor = donor - cv2.GaussianBlur(donor,(0,0),5) + cv2.GaussianBlur(source,(0,0),5)
            weight = soft_weight(heal)[...,None] * tools['heal_amount']
            out = out*(1-weight)+donor.clip(0,1)*weight
    # Feather the V4.1 brush across the silhouette. Only the final write is
    # clipped to visible pixels. Keep the falloff around explicitly protected details.
    light_to_edge = tools.get('light_to_edge', False)
    light_area = (tools['protect'] <= 0) if light_to_edge else allowed
    dodge = soft_weight(tools['dodge'] * light_area, 48, fade_at_canvas_edge=not light_to_edge)
    burn = soft_weight(tools['burn'] * light_area, 48, fade_at_canvas_edge=not light_to_edge)
    exposure = (dodge - burn) * tools['light_amount']
    if 'stroke_exposure' in tools:
        exposure = np.clip(exposure + tools['stroke_exposure'], -32, 32)
    linear = np.where(out <= .04045, out/12.92, ((out+.055)/1.055)**2.4)
    linear = (linear * np.exp2(exposure[...,None])).clip(0,1)
    out = np.where(linear <= .0031308, linear*12.92, 1.055*linear**(1/2.4)-.055)
    touched = ((heal>0)|(exposure!=0)) & allowed
    rgba[touched,:3] = np.rint(out[touched]*255).clip(0,255).astype(np.uint8)
    return touched


def selection_distance(selected, surface=None):
    if surface is None:
        return distance_transform_edt(np.pad(selected, 1))[1:-1, 1:-1]
    # Transparent space and the image border are not brush boundaries.
    unselected_surface = surface & ~selected
    if not unselected_surface.any():
        return np.full(selected.shape, np.finfo(np.float32).max, dtype=np.float32)
    return distance_transform_edt(~unselected_surface)


def differential_mask(binary, strength_map, gentleness, protection, surface=None):
    if gentleness > 0:
        distance=selection_distance(binary > 0, surface)
        t=np.clip(distance/(4+28*gentleness),0,1)
        falloff=.20+.80*t*t*(3-2*t)
    else: falloff=1.
    result=(binary*strength_map*falloff).clip(0,1).astype(np.float32)
    result[protection>0]=0
    return result


def differential_preparation(original, prepared, noise_mask):
    # Weak DD regions must start from the accepted surface, not a neutral/LaMa
    # replacement that the low-denoise tail has too little time to reconstruct.
    weight=np.clip((noise_mask-.25)/.75,0,1)[...,None]
    return (original*(1-weight)+prepared*weight).astype(np.float32)


def variant_settings(seed, amount, count, strategy, spread):
    # Independent candidates, never result -> result chaining.
    for index in range(count):
        offset = 0 if count == 1 else (index-(count-1)/2)*spread
        yield ((seed+index*1009) % (2**64) if strategy == 'Разные seed' else seed,
               amount if strategy == 'Разные seed' else float(np.clip(amount+offset,.05,1.)))


def donor_reference(rgba, tools):
    point=tools.get('reference_donor',tools.get('donor'))
    if point is None: raise ValueError('В редакторе выберите «Использовать образец» и укажите чистый участок.')
    h,w=rgba.shape[:2]
    x,y=min(w-1,round(point[0])),min(h-1,round(point[1]))
    side=round(tools.get('reference_size',tools.get('donor_size',128)))
    left=x-side//2
    top=y-side//2
    x0,x1=max(0,left),min(w,left+side)
    y0,y1=max(0,top),min(h,top+side)
    from .core import flatten_rgba
    return flatten_rgba(rgba[y0:y1,x0:x1]).astype(np.float32)/255
