"""Local character retouching, with an explicit edit boundary and independent alpha.

LaMa fills removed details before diffusion; soft surface retouch keeps the original
latent instead. Only the explicit accessory mode can extend the accepted silhouette.
"""
import json
import re
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from scipy.ndimage import distance_transform_edt

import folder_paths
from .core import clean_rgba, flatten_rgba, restore_rgba
from .advanced import apply_local, protected_mask, differential_mask, differential_preparation, selection_distance, variant_settings, donor_reference, tools_for_mode

ADD_OBJECT = 'Добавить предмет за контур'
MODES = ['Ретушь: мелкая деталь / татуировка', 'Удалить и восстановить',
         'Заменить одежду / предмет', 'Изменить форму / пропорции', 'Перекрасить без генерации',
         'Мягкая ретушь кожи / поверхности', ADD_OBJECT]
SOFT_RETOUCH = MODES[5]
SILHOUETTES = ['Авто: менять только при касании края', 'Сохранить исходный силуэт', 'Обновить силуэт внутри маски']
PRESETS = {
    MODES[0]: dict(strength=.48, context=384, factor=2.2, feather=5, fill='lama'),
    MODES[1]: dict(strength=.86, context=640, factor=1.8, feather=10, fill='lama'),
    MODES[2]: dict(strength=.92, context=768, factor=1.7, feather=10, fill='neutral'),
    MODES[3]: dict(strength=.80, context=768, factor=1.8, feather=10, fill='original'),
    MODES[4]: dict(strength=0, context=384, factor=1.5, feather=2, fill='original'),
    SOFT_RETOUCH: dict(strength=.28, context=512, factor=2., feather=16, fill='original'),
    ADD_OBJECT: dict(strength=.95, context=448, factor=2., feather=4, fill='neutral'),
}


def tensor(a):
    return torch.from_numpy(np.ascontiguousarray(a, dtype=np.float32))[None]


def surface_mask(rgba, mask):
    """Surface repair stays inside the existing subject; its alpha is never changed."""
    foreground = rgba[..., 3] > 127
    distance = distance_transform_edt(np.pad(foreground, 1))[1:-1, 1:-1]
    t = np.clip((distance - 2.) / 6., 0, 1)
    return (mask * t * t * (3 - 2 * t)).astype(np.float32)


def feather_inside(mask, pixels, surface=None):
    """Feather inward; adapt to thin selections so they are not all translucent."""
    support = mask > 0
    distance = selection_distance(support, surface)
    radius = min(float(pixels), max(1., float(np.quantile(distance[support], .9))))
    t = np.clip(distance / radius, 0, 1)
    return (mask * t * t * (3 - 2 * t)).astype(np.float32)


def edge_retouch_crop(rgba, mask, padding):
    """Continue straight foreground colors across the silhouette in the VAE input."""
    visible = rgba[..., 3] > 0
    rgb = rgba[..., :3].copy()
    if visible.all():
        return rgb, mask
    rgb[~visible] = 127
    distance, nearest = distance_transform_edt(~visible, return_indices=True)
    band = (~visible) & (distance <= padding)
    donors = tuple(axis[band] for axis in nearest)
    rgb[band] = rgb[donors]
    sampling = mask.copy()
    sampling[band] = mask[donors]
    return rgb, sampling


def crop_box(mask, minimum, factor):
    ys, xs = np.where(mask > 0)
    h, w = mask.shape
    side = max(minimum, round(max(xs.max()-xs.min()+1, ys.max()-ys.min()+1) * factor))
    cw, ch = min(w, side), min(h, side)
    x = int(np.clip((xs.min()+xs.max()+1-cw)//2, 0, w-cw))
    y = int(np.clip((ys.min()+ys.max()+1-ch)//2, 0, h-ch))
    return x, y, cw, ch


def fit_crop(rgb, mask, target):
    """Letterbox instead of stretching anatomy on narrow or landscape images."""
    h, w = mask.shape
    scale = target / max(h, w)
    nw, nh = max(1, round(w*scale)), max(1, round(h*scale))
    left, top = (target-nw)//2, (target-nh)//2
    image = np.full((target, target, 3), 127/255, np.float32)
    m = np.zeros((target, target), np.float32)
    image[top:top+nh, left:left+nw] = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_CUBIC)
    m[top:top+nh, left:left+nw] = cv2.resize(mask, (nw, nh), interpolation=cv2.INTER_LINEAR)
    return image.clip(0, 1), m.clip(0, 1), (left, top, nw, nh)


_lama = None
def lama_fill(rgb, mask):
    global _lama
    path = Path(folder_paths.models_dir) / 'inpaint/big-lama.pt'
    if not path.is_file():
        raise ValueError('Не найдена модель LaMa: models/inpaint/big-lama.pt')
    if _lama is None:
        _lama = torch.jit.load(str(path), map_location='cpu').eval()
    # A 512px preparation is enough; diffusion reconstructs the final texture.
    side = 512
    image = torch.from_numpy(cv2.resize(rgb, (side, side))).permute(2, 0, 1)[None].float()
    m = torch.from_numpy(cv2.resize((mask>.05).astype(np.float32), (side, side), interpolation=cv2.INTER_NEAREST))[None, None]
    with torch.inference_mode():
        output = _lama(image, m)
    if isinstance(output, dict):
        output = output['inpainted']
    filled = output[0].permute(1, 2, 0).cpu().numpy()
    filled = cv2.resize(filled, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_CUBIC)
    return np.where((mask>.05)[..., None], filled, rgb).clip(0, 1)


_biref = None
def segment_alpha(rgb, *, calibrated=False):
    """BiRefNet Lite ONNX, on CPU to leave the 8GB GPU for diffusion.

    Pre/post-processing follows rembg's BiRefNet session (MIT).
    https://github.com/danielgatis/rembg/blob/main/rembg/sessions/birefnet_general.py
    """
    global _biref
    import onnxruntime as ort
    path = Path(folder_paths.models_dir) / 'inpaint/birefnet-general-lite.onnx'
    if not path.is_file():
        raise ValueError('Не найдена модель контура: models/inpaint/birefnet-general-lite.onnx')
    if _biref is None:
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 4
        opts.inter_op_num_threads = 1
        opts.enable_cpu_mem_arena = False
        _biref = ort.InferenceSession(str(path), sess_options=opts, providers=['CPUExecutionProvider'])
    im = np.asarray(Image.fromarray(rgb).resize((1024, 1024), Image.Resampling.LANCZOS), dtype=np.float32)
    im /= 255. if calibrated else max(float(im.max()), 1.)
    im = (im - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
    logits = _biref.run(None, {_biref.get_inputs()[0].name: im.transpose(2, 0, 1)[None]})[0][0, 0]
    pred = 1 / (1 + np.exp(-np.clip(logits, -80, 80)))
    if not calibrated:
        span = float(pred.max()-pred.min())
        if span < 1e-6:
            raise ValueError('Модель не выделила силуэт. Используйте сохранение исходной прозрачности.')
        pred = (pred-pred.min())/span
    return cv2.resize(pred, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_LINEAR).clip(0, 1)


def recolor(rgba, mask, color, strength, feather):
    if not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
        raise ValueError('Цвет задаётся как #RRGGBB, например #c52b35.')
    rgb = rgba[..., :3].astype(np.float32)/255
    goal = np.array([int(color[i:i+2], 16)/255 for i in (1, 3, 5)], np.float32)
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)
    target = cv2.cvtColor(goal.reshape(1, 1, 3), cv2.COLOR_RGB2LAB)[0, 0]
    selected = (mask > .5) & (rgba[..., 3] > 0)
    if not selected.any():
        raise ValueError('Для перекраски выделите видимую ткань, а не прозрачный фон.')
    changed = lab.copy()
    # Shift luminance while retaining its spatial detail. This also colors black fabric.
    changed[..., 0] = np.clip(lab[..., 0] + target[0]-np.median(lab[..., 0][selected]), 0, 100)
    changed[..., 1:] = target[1:]
    new_rgb = cv2.cvtColor(changed, cv2.COLOR_LAB2RGB).clip(0, 1)
    a = feather_inside(mask, feather)[..., None] * strength
    out = clean_rgba(rgba)
    out[..., :3] = np.rint((rgb*(1-a)+new_rgb*a)*255).clip(0, 255).astype(np.uint8)
    out[mask<=0] = clean_rgba(rgba)[mask<=0]
    out[out[..., 3]==0, :3] = 0
    return out


def warp_region(rgb, mask, width_percent, height_percent):
    """Optional local geometry guide, confined to the selected region."""
    if width_percent == 100 and height_percent == 100:
        return rgb
    ys, xs = np.where(mask > 0)
    cx, cy = (xs.min()+xs.max())/2, (ys.min()+ys.max())/2
    yy, xx = np.mgrid[:mask.shape[0], :mask.shape[1]].astype(np.float32)
    weight = feather_inside(mask, max(8, min(np.ptp(xs), np.ptp(ys))*.15))
    mx = xx + ((xx-cx)/(width_percent/100)-(xx-cx))*weight
    my = yy + ((yy-cy)/(height_percent/100)-(yy-cy))*weight
    return cv2.remap(rgb, mx.astype(np.float32), my.astype(np.float32), cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT_101).clip(0, 1)


def finish(rgba, generated, mask, feather, update_alpha, alpha_prediction=None):
    weight = feather_inside(mask, feather)
    original_work = flatten_rgba(rgba).astype(np.float32)
    edited = np.rint(original_work*(1-weight[..., None]) + generated.astype(np.float32)*weight[..., None]).clip(0, 255).astype(np.uint8)
    out = restore_rgba(rgba, edited)
    if update_alpha:
        prediction = segment_alpha(generated) if alpha_prediction is None else alpha_prediction
        old = rgba[..., 3].astype(np.float32)/255
        opaque = float(np.quantile(old[old>.5], .95)) if (old>.5).any() else 1.
        new = prediction * opaque
        alpha = np.rint((old*(1-weight)+new*weight)*255).clip(0, 255).astype(np.uint8)
        a = alpha.astype(np.float32)[..., None]/255
        foreground = np.rint((edited.astype(np.float32)-127*(1-a))/np.maximum(a, 1/255)).clip(0, 255).astype(np.uint8)
        out = np.dstack((foreground, alpha))
    out[mask<=0] = clean_rgba(rgba)[mask<=0]
    out[out[..., 3]==0, :3] = 0
    return out


class PNGV4UniversalInpaint:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {
            'original_rgba': ('IMAGE',), 'brush_mask': ('MASK',), 'tools': ('V4_TOOLS',),
            'variants': ([1,3], {'default':1}),
            'variant_strategy': (['Разные seed','Разная сила'],),
            'variant_spread': ('FLOAT', {'default':.08,'min':.01,'max':.25,'step':.01}),
            'differential': ('BOOLEAN', {'default':True}),
            'edge_gentleness': ('FLOAT', {'default':.5,'min':0.,'max':1.,'step':.05}),
            'guide_control': (['Выкл','Рисунок + контекст','Только рисунок'], {'default':'Рисунок + контекст'}),
            'guide_weight': ('FLOAT', {'default':.65,'min':.0,'max':1.5,'step':.05}),
            'reference_mode': (['Выкл','Исходный фрагмент','Донор из кисти','Подключённое изображение','Загруженный образец'],),
            'reference_weight': ('FLOAT', {'default':.35,'min':0.,'max':1.,'step':.05}),
            'mode': (MODES,),
            'prompt': ('STRING', {'multiline':True, 'default':'plain fabric, continuous fabric folds, matching material and lighting'}),
            'negative': ('STRING', {'multiline':True, 'default':'low quality, blurry, text, watermark, deformed anatomy, extra limbs, mismatched lighting'}),
            'seed': ('INT', {'default':181127, 'min':0, 'max':0xffffffffffffffff}),
            'resolution': ([768, 1024], {'default':1024}),
            'steps': ('INT', {'default':28, 'min':8, 'max':60}),
            'cfg': ('FLOAT', {'default':5., 'min':1., 'max':12., 'step':.5}),
            'strength': ('FLOAT', {'default':0., 'min':0., 'max':1., 'step':.01, 'tooltip':'Сила изменения: меньше — ближе к исходнику, больше — сильнее перерисовка. 0 включает значение выбранного режима; оно показано в подсказке ноды.'}),
            'detail_pass': ('BOOLEAN', {'default':True, 'tooltip':'Короткая локальная доводка текстуры. Не используется при перекраске.'}),
            'silhouette': (SILHOUETTES, {'tooltip': 'Настройка старых workflow. Расширение силуэта включается режимом «Добавить предмет за контур».'}),
            'feather_pixels': ('INT', {'default':0, 'min':0, 'max':48, 'tooltip':'0 = автоматически по режиму. Переход всегда внутри выделения.'}),
            'context_pixels': ('INT', {'default':0, 'min':0, 'max':2048, 'step':64, 'tooltip':'0 = автоматически по режиму; это окружение, а не дополнительная область правки.'}),
            'target_color': ('STRING', {'default':'#c52b35', 'tooltip':'Только для режима перекраски.'}),
            'color_strength': ('FLOAT', {'default':1., 'min':0., 'max':1., 'step':.05}),
            'width_percent': ('INT', {'default':100, 'min':65, 'max':135, 'tooltip':'Только для формы внутри фиксированного контура: 100 = без деформации; 90 = локальное сжатие рисунка по ширине.'}),
            'height_percent': ('INT', {'default':100, 'min':65, 'max':135, 'tooltip':'Только для формы внутри фиксированного контура: 100 = без деформации.'}),
        }, 'optional': {
            'reference_image': ('IMAGE', {'lazy':True}), 'model': ('MODEL', {'lazy':True}), 'clip': ('CLIP', {'lazy':True}),
            'vae': ('VAE', {'lazy':True}), 'patch': ('INPAINT_PATCH', {'lazy':True}),
            'positive_prompt': ('STRING', {'forceInput': True, 'tooltip': 'Позитив из подключённого помощника; имеет приоритет над ручным полем.'}),
            'negative_prompt': ('STRING', {'forceInput': True, 'tooltip': 'Негатив из подключённого помощника; имеет приоритет над ручным полем.'}),
            'retouch_to_edge': ('BOOLEAN', {'default': False, 'tooltip': 'Мягко исправляет цвет и фактуру под красной маской до последнего полупрозрачного пикселя. Сохраняет контур PNG.'}),
        }}
    RETURN_TYPES = ('IMAGE', 'IMAGE', 'STRING')
    RETURN_NAMES = ('transparent_png', 'before_after', 'report')
    FUNCTION = 'run'
    CATEGORY = 'image/alpha tools'

    def check_lazy_status(self, mode, model=None, clip=None, vae=None, patch=None, brush_mask=None, reference_mode='Выкл', reference_image=None, **kwargs):
        if mode == MODES[4] or (brush_mask is not None and not bool(brush_mask.any())):
            return []
        needed = [('model',model),('clip',clip),('vae',vae)]
        if reference_mode == 'Подключённое изображение': needed.append(('reference_image',reference_image))
        if mode != SOFT_RETOUCH:
            needed.append(('patch',patch))
        return [name for name, value in needed if value is None]

    def run(self, original_rgba, brush_mask, tools, **kwargs):
        from .messages import message
        try:
            return self._run_variants(original_rgba, brush_mask, tools, **kwargs)
        except (ValueError, RuntimeError) as exc:
            translated = message(exc, tools.get('ui_language','en'))
            if translated == str(exc):
                raise
            raise type(exc)(translated) from exc

    def _run_variants(self, original_rgba, brush_mask, tools, variants=1, variant_strategy='Разные seed',
            variant_spread=.08, differential=True, edge_gentleness=.5,
            guide_control='Рисунок + контекст', guide_weight=.65,
            reference_mode='Выкл', reference_weight=.35, reference_image=None, **kwargs):
        original=np.rint(original_rgba.detach().cpu().numpy()[0]*255).clip(0,255).astype(np.uint8)
        tools=tools_for_mode(tools,kwargs['mode'])
        if kwargs['mode']==MODES[4]: differential=False
        baseline,local=apply_local(original,tools)
        extending = kwargs['mode'] == ADD_OBJECT
        mask=protected_mask(brush_mask.detach().cpu().numpy()[0],tools,baseline, allow_extension=extending)
        if differential: mask[tools['strength']<=0]=0
        if extending and mask.any():
            from .silhouette import validate_attachment
            validate_attachment(baseline[..., 3], mask)
        count=int(variants) if mask.any() and kwargs['mode']!=MODES[4] else 1
        default=PRESETS[kwargs['mode']]['strength']
        if kwargs['mode']==MODES[3] and (kwargs['width_percent']!=100 or kwargs['height_percent']!=100): default=.48
        amount=kwargs['strength'] or default
        images=[];comparisons=[];reports=[]
        for current_seed,current_amount in variant_settings(kwargs['seed'],amount,count,variant_strategy,variant_spread):
            params=dict(kwargs,seed=current_seed,strength=current_amount)
            response=self._run_one(tensor(baseline.astype(np.float32)/255),tensor(mask),
                tools=tools,differential=differential,edge_gentleness=edge_gentleness,
                guide_control=guide_control,guide_weight=guide_weight,reference_mode=reference_mode,
                reference_weight=reference_weight,reference_image=reference_image,**params)
            output=response['result'][0]
            result=np.rint(output[0].cpu().numpy()*255).clip(0,255).astype(np.uint8)
            # Lock against the accepted source, even after VAE and color matching.
            locked=(tools['protect']>0)|((mask<=0)&~local)
            result[locked]=baseline[locked]
            if not extending:
                result[...,3]=baseline[...,3]
            images.append(tensor(result.astype(np.float32)/255))
            previews=[]
            for im in (original,result):
                preview=Image.fromarray(flatten_rgba(im));preview.thumbnail((512,640))
                previews.append(np.asarray(preview,dtype=np.float32)/255)
            comparisons.append(tensor(np.concatenate(previews,axis=1)))
            report=json.loads(response['result'][2]);report.update(seed=current_seed,denoise=current_amount if mask.any() else 0)
            reports.append(report)
        if extending and mask.any() and not any(r['added_pixels'] for r in reports):
            raise ValueError('Предмет за контуром не выделился. Захватите кистью место крепления и оставьте на прозрачной стороне место для всего предмета. Попробуйте другой seed.')
        report=json.dumps({'version':4,'variants':reports,'seconds':round(sum(r['seconds'] for r in reports),2),
            'alpha':'добавлен предмет внутри выделения' if extending and mask.any() else 'исходная, точно; ручные альфа-правки учтены','differential':bool(differential),
            'protected_pixels':int((tools['protect']>0).sum()),'local_pixels':int(local.sum())},ensure_ascii=False)
        return {'ui':{'text':[report]},'result':(torch.cat(images),torch.cat(comparisons),report)}

    def _run_one(self, original_rgba, brush_mask, mode, prompt, negative, seed, resolution,
            steps, cfg, strength, detail_pass, silhouette, feather_pixels, context_pixels,
            target_color, color_strength, width_percent, height_percent,
            model=None, clip=None, vae=None, patch=None, positive_prompt=None, negative_prompt=None,
            tools=None,differential=True,edge_gentleness=.5,guide_control='Выкл',guide_weight=.65,
            reference_mode='Выкл',reference_weight=.35,reference_image=None,retouch_to_edge=False):
        started = time.perf_counter()
        if positive_prompt is not None:
            prompt = positive_prompt
        if negative_prompt is not None:
            negative = negative_prompt
        if original_rgba.shape[0] != 1 or original_rgba.shape[-1] != 4 or tuple(brush_mask.shape) != tuple(original_rgba.shape[:3]):
            raise ValueError('Один RGBA PNG и маска должны иметь одинаковый размер.')
        rgba = np.rint(original_rgba.detach().cpu().numpy()[0]*255).clip(0,255).astype(np.uint8)
        mask = brush_mask.detach().cpu().numpy()[0].astype(np.float32)
        if not np.isfinite(mask).all():
            raise ValueError('Некорректная маска правки.')
        if not (mask > 0).any():
            # The source permits an empty generation mask only when alpha was edited.
            # Preserve its manually corrected alpha without loading a model or using a prompt.
            result = clean_rgba(rgba)
            preview = Image.fromarray(flatten_rgba(result)); preview.thumbnail((512, 640))
            preview = np.asarray(preview, dtype=np.float32) / 255
            report = json.dumps({'mode':'Ручная правка прозрачности', 'denoise':0,
                'detail_pass':False, 'alpha':'ручная правка из первой ноды, точно',
                'outside_mask':'RGB сохранены; скрытые RGB очищены',
                'seconds':round(time.perf_counter()-started, 2)}, ensure_ascii=False)
            return {'ui':{'text':[report]}, 'result':(tensor(result.astype(np.float32)/255),
                    tensor(np.concatenate((preview, preview), axis=1)), report)}
        import nodes
        from comfy import model_management
        mask = mask.clip(0,1)
        soft_retouch = mode == SOFT_RETOUCH
        edge_retouch = soft_retouch and retouch_to_edge
        protected_pixels = 0
        if soft_retouch and not edge_retouch:
            original_support = mask > 0
            mask = surface_mask(rgba, mask)
            protected_pixels = int(np.count_nonzero(original_support & (mask == 0)))
            if not (mask > 0).any():
                raise ValueError('Мягкая ретушь работает внутри видимой поверхности. Выделите кожу или ткань, а не фон и тонкий контур.')
        preset = PRESETS[mode]
        feather = feather_pixels or preset['feather']
        denoise = strength or preset['strength']
        update_alpha = mode == ADD_OBJECT
        box = None
        if mode == MODES[4]:
            result = recolor(rgba, mask, target_color, color_strength, feather)
        else:
            if any(v is None for v in (model,clip,vae)) or (not soft_retouch and patch is None):
                raise ValueError('Подключите модель SDXL, CLIP, VAE и Fooocus patch.')
            if not prompt.strip():
                if update_alpha:
                    raise ValueError('Опишите предмет, например «красный атласный бант на краю платья».')
                raise ValueError('Опишите, что должно остаться вместо выделенной детали.')
            # Fooocus is an SDXL patch, not compatible with SD1.5 / Flux / distilled models.
            from comfy.model_base import SDXL
            if not isinstance(model.model, SDXL):
                raise ValueError('Этот workflow использует обычную SDXL-модель. Выберите King Cake / Key Lime, не SD1.5 или Flux.')
            box = crop_box(mask, context_pixels or preset['context'], preset['factor'])
            x,y,w,h = box
            crop = np.s_[y:y+h, x:x+w]
            crop_mask = mask[crop]
            if edge_retouch:
                # Extend context by two latent pixels at the working resolution.
                padding = max(1, int(np.ceil(16 * max(w, h) / int(resolution))))
                crop_rgb, sampling_brush = edge_retouch_crop(rgba[crop], crop_mask, padding)
            else:
                crop_rgb, sampling_brush = flatten_rgba(rgba[crop]), crop_mask
            crop_rgb = crop_rgb.astype(np.float32)/255
            original, edit_mask, fit = fit_crop(crop_rgb, sampling_brush, int(resolution))
            sampling_mask = cv2.dilate((edit_mask>.01).astype(np.float32), np.ones((9,9),np.uint8))
            def fit_map(value):
                return fit_crop(crop_rgb,value[crop],int(resolution))[1]
            protect=fit_map(tools['protect'])
            sampling_mask[protect>0]=0
            surface = fit_map((rgba[..., 3] > 0).astype(np.float32)) > 0 if edge_retouch and differential else None
            noise_mask=differential_mask(sampling_mask,fit_map(tools['strength']),edge_gentleness,protect,surface) if differential else sampling_mask
            preparation = original.copy()
            if preset['fill']=='lama':
                print('[Universal Inpaint] LaMa prefill', flush=True)
                preparation = lama_fill(original, sampling_mask)
            elif preset['fill']=='neutral':
                preparation = np.where(sampling_mask[..., None]>.5, .5, original).astype(np.float32)
            elif mode == MODES[3]:
                preparation = warp_region(original, edit_mask, width_percent, height_percent)
                if width_percent != 100 or height_percent != 100:
                    denoise = strength or .48
            if differential:
                preparation=differential_preparation(original,preparation,noise_mask)
            model_management.throw_exception_if_processing_interrupted()
            if update_alpha:
                prompt += ', attached accessory, plain neutral gray backdrop'
                negative = ', '.join(filter(None, [negative, 'scenery, cast shadow on backdrop, checkerboard pattern']))
            pos = nodes.CLIPTextEncode().encode(clip, prompt)[0]
            neg = nodes.CLIPTextEncode().encode(clip, negative)[0]

            if reference_mode!='Выкл' and reference_weight>0:
                if reference_mode=='Донор из кисти': reference=tensor(donor_reference(rgba,tools))
                elif reference_mode=='Загруженный образец':
                    from .unified import source_data
                    if not tools.get('reference_file'): raise ValueError('Загрузите картинку в разделе «Использовать образец» редактора.')
                    ref,_=source_data(tools['reference_file'])
                    reference=tensor(flatten_rgba(ref).astype(np.float32)/255)
                elif reference_mode=='Подключённое изображение':
                    if reference_image is None: raise ValueError('Подключите изображение-референс к reference_image.')
                    reference=reference_image[...,:3]
                else: reference=tensor(original)
                if not hasattr(self,'_iploader'): self._iploader=nodes.NODE_CLASS_MAPPINGS['IPAdapterUnifiedLoader']()
                model,ipadapter=self._iploader.load_models(model,'PLUS (high strength)')
                model=nodes.NODE_CLASS_MAPPINGS['IPAdapterAdvanced']().apply_ipadapter(model,ipadapter,
                    image=reference,weight=reference_weight,start_at=0.,end_at=.8,weight_type='linear',
                    combine_embeds='concat',attn_mask=tensor(edit_mask),embeds_scaling='V only')[0]
            guide=fit_map(tools['guide'])
            if guide_control!='Выкл' and guide_weight>0 and guide.any():
                from comfy.controlnet import load_controlnet
                path=folder_paths.get_full_path('controlnet','xinsir_scribble_sdxl_1.0.safetensors')
                if not path: raise ValueError('Не найдена xinsir_scribble_sdxl_1.0.safetensors в models/controlnet.')
                if not hasattr(self,'_control'): self._control=load_controlnet(path)
                hint=guide.copy()
                if guide_control=='Рисунок + контекст':
                    edges=cv2.Canny(np.rint(original*255).astype(np.uint8),80,160).astype(np.float32)/255
                    hint=np.maximum(hint,edges*(sampling_mask<=0))
                hint=np.repeat(hint[...,None],3,axis=2)
                pos,neg=nodes.ControlNetApplyAdvanced().apply_controlnet(pos,neg,self._control,tensor(hint),guide_weight,0.,.8,vae=vae)

            def patch_differential(current_model):
                if not differential: return current_model
                from comfy_extras.nodes_differential_diffusion import DifferentialDiffusion
                return DifferentialDiffusion.execute(current_model)[0]

            def sample(pixels, amount, count, current_seed):
                if soft_retouch:
                    # Masked img2img retains the original surface in the initial latent.
                    # No LaMa, neutral fill or Fooocus patch erases its structure.
                    initial = {'samples': vae.encode(tensor(pixels)), 'noise_mask': tensor(noise_mask)}
                    latent = nodes.common_ksampler(patch_differential(model),current_seed,count,cfg,'dpmpp_2m','karras',pos,neg,initial,denoise=amount)[0]
                else:
                    conditioned = nodes.NODE_CLASS_MAPPINGS['INPAINT_VAEEncodeInpaintConditioning'].execute(pos,neg,vae,tensor(pixels),tensor(sampling_mask))
                    patched = nodes.NODE_CLASS_MAPPINGS['INPAINT_ApplyFooocusInpaint'].execute(model,patch,conditioned[2])[0]
                    initial=dict(conditioned[3],noise_mask=tensor(noise_mask))
                    latent = nodes.common_ksampler(patch_differential(patched),current_seed,count,cfg,'dpmpp_2m','karras',conditioned[0],conditioned[1],initial,denoise=amount)[0]
                decoded = vae.decode(latent['samples'])
                # Estimate correction only from unchanged surroundings, never from the new fabric/skin.
                matched = nodes.NODE_CLASS_MAPPINGS['INPAINT_ColorMatch'].execute(decoded,tensor(original),tensor(sampling_mask),.35)[0]
                return matched[0].detach().cpu().numpy().clip(0,1)

            print(f'[Universal Inpaint] {mode}: strength={denoise}', flush=True)
            generated = sample(preparation, denoise, steps, seed)
            if detail_pass:
                # Preserve the clean source context between passes rather than accumulating VAE drift.
                refine_input = np.where(sampling_mask[...,None]>.5, generated, original)
                generated = sample(refine_input, .10 if soft_retouch else .18, 12, (seed+1) % (2**64))
            left,top,nw,nh = fit
            generated = generated[top:top+nh,left:left+nw]
            region = cv2.resize(generated,(w,h),interpolation=cv2.INTER_CUBIC).clip(0,1)
            if edge_retouch:
                # Unmatting generated RGB would amplify even a one-level error at very low alpha.
                result = clean_rgba(rgba)
                weight = feather_inside(crop_mask, feather, rgba[crop][..., 3] > 0)[..., None]
                rgb = result[crop][..., :3]
                rgb[:] = np.rint(rgb * (1 - weight) + region * 255 * weight).astype(np.uint8)
            else:
                candidate = flatten_rgba(rgba)
                painted = crop_mask > 0
                candidate[crop][painted] = np.rint(region[painted]*255).astype(np.uint8)
                if update_alpha:
                    from .silhouette import composite_attachment
                    prediction = segment_alpha(candidate[crop], calibrated=True)
                    result = clean_rgba(rgba)
                    result[crop] = composite_attachment(rgba[crop], candidate[crop], crop_mask,
                                                         feather_inside(mask, feather)[crop], prediction)
                else:
                    result = finish(rgba,candidate,mask,feather,False)
        clean = clean_rgba(rgba)
        if not np.array_equal(result[mask<=0],clean[mask<=0]):
            raise RuntimeError('Ошибка защиты: изменены пиксели за пределами маски.')
        if not update_alpha and not np.array_equal(result[...,3],rgba[...,3]):
            raise RuntimeError('Ошибка защиты исходной прозрачности.')
        # Compact preview, with alpha composited explicitly so hidden RGB never appears.
        previews = []
        for image in (rgba,result):
            image = Image.fromarray(flatten_rgba(image))
            image.thumbnail((512,640))
            previews.append(np.asarray(image,dtype=np.float32)/255)
        comparison = np.concatenate(previews,axis=1)
        info = {'mode':mode,'denoise':denoise,'detail_pass':bool(detail_pass and mode!=MODES[4]),
                'controlnet':bool(guide_control!='Выкл' and guide_weight>0 and tools['guide'].any()),
                'reference':reference_mode,
                'alpha':'обновлена только внутри маски' if update_alpha else 'исходная, точно',
                'outside_mask':'RGBA сохранены; RGB полностью прозрачных пикселей очищены',
                'crop':box,'seconds':round(time.perf_counter()-started,2)}
        if soft_retouch:
            info.update(surface_preserved=True, preparation='original pixels; no LaMa or Fooocus',
                        protected_edge_pixels=protected_pixels, retouch_to_edge=edge_retouch)
        if update_alpha:
            info['added_pixels'] = int(np.count_nonzero((result[..., 3] > 0) & (rgba[..., 3] == 0)))
        report = json.dumps(info,ensure_ascii=False,indent=2)
        print('[Universal Inpaint]', report, flush=True)
        return {'ui':{'text':[report]},'result':(tensor(result.astype(np.float32)/255),tensor(comparison),report)}


NODE_CLASS_MAPPINGS = {'PNGV4UniversalInpaint':PNGV4UniversalInpaint}
NODE_DISPLAY_NAME_MAPPINGS = {'PNGV4UniversalInpaint':'Inpaint · Универсальная правка персонажа'}
