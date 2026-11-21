"""One source file, an independent inpaint mask, and explicit local alpha edits."""
import base64
import asyncio
import hashlib
import io
import json
from pathlib import Path

import folder_paths
import numpy as np
import torch
from aiohttp import web
from .messages import request_message
from PIL import Image, ImageOps
from scipy.ndimage import binary_erosion, binary_fill_holes, distance_transform_edt
from server import PromptServer
from .core import clean_rgba, flatten_rgba, restore_rgba


def source_data(name):
    path = Path(folder_paths.get_annotated_filepath(name)).resolve()
    roots = [Path(folder_paths.get_directory_by_type(t)).resolve() for t in ('input','output','temp')]
    if not any(path.is_relative_to(root) for root in roots) or not path.is_file():
        raise ValueError('Choose an uploaded image inside ComfyUI input/output/temp.')
    data = path.read_bytes()
    with Image.open(io.BytesIO(data)) as image:
        image = ImageOps.exif_transpose(image)
        if image.width * image.height > 32_000_000:
            raise ValueError('Image exceeds 32 megapixels; use a smaller source.')
        rgba = np.array(image.convert('RGBA'))
    return rgba, hashlib.sha256(data).hexdigest()


def edit_data(payload, sha, shape):
    if not payload:
        raise ValueError('Нарисуйте маску: нажмите «Выделить область кистью» в первой ноде.')
    data = json.loads(payload)
    if not isinstance(data, dict):
        raise ValueError('Некорректные данные редактора.')
    if data.get('source_sha256') != sha:
        raise ValueError('Изображение изменилось. Нарисуйте новую маску для текущего PNG.')
    if [data.get('height'),data.get('width')] != list(shape):
        raise ValueError('Размер маски не совпадает с исходником.')
    return data


def decode_canvas(encoded, shape):
    if not isinstance(encoded, str):
        raise ValueError('Некорректный PNG маски.')
    if len(encoded)>48_000_000:
        raise ValueError('Mask is too large.')
    with Image.open(io.BytesIO(base64.b64decode(encoded,validate=True))) as image:
        if image.size != (shape[1],shape[0]):
            raise ValueError('Mask PNG dimensions do not match source.')
        # The editor stores a black/white opaque canvas; RGB brightness is the mask.
        mask = np.array(image.convert('L'), dtype=np.uint8)
    return mask


def decode_mask(payload, sha, shape, allow_empty=False):
    data = edit_data(payload, sha, shape)
    mask = decode_canvas(data.get('png', ''), shape).astype(np.float32) / 255
    if not allow_empty and not np.any(mask>0):
        raise ValueError('Маска пуста: выделите область кистью и нажмите «Сохранить маску».')
    return mask


def opaque_region(rgba):
    """Only existing interior pixels; keep the exterior fringe and two-pixel rim exact.

    Enclosed translucent defects belong to the interior even below 50% opacity.
    Exterior-connected low-alpha pixels (including halos) are never added to it.
    Eight-connected background keeps diagonal openings open. Alpha-zero pixels
    remain zero, including internal holes: this tool repairs partial opacity only.
    """
    alpha = rgba[..., 3]
    interior = binary_fill_holes(alpha > 127, structure=np.ones((3, 3), bool))
    interior = binary_erosion(interior, structure=np.ones((3, 3), bool), iterations=2, border_value=0)
    return interior & (alpha > 0)


def edge_alpha_target(rgba):
    """Raise opacity inward from the exact nonzero support, never dilate it.

    The eight-connected outer pixel rim (including hole edges) is byte-exact.
    A fixed two-pixel inward ramp retains antialiasing without a cumulative blur.
    Alpha alone cannot distinguish a broad halo from translucent foreground:
    the caller must explicitly paint the desired foreground, not its halo.
    """
    alpha = rgba[..., 3]
    support = alpha > 0
    inner = binary_erosion(support, structure=np.ones((3, 3), bool), border_value=0)
    distance = distance_transform_edt(np.pad(support, 1))[1:-1, 1:-1]
    t = np.clip((distance - 1.) / 2., 0., 1.)
    target = np.maximum(alpha, np.floor(255 * t * t * (3 - 2 * t) + .5).astype(np.uint8))
    target[~inner] = alpha[~inner]
    return target


def add_underpaint(rgba, encoded):
    """Place the painted RGBA layer behind the edited sprite, in straight alpha."""
    if not encoded:
        return rgba
    with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as image:
        if image.format != 'PNG' or image.size != (rgba.shape[1], rgba.shape[0]):
            raise ValueError('Размер слоя дорисовки не совпадает с исходным PNG.')
        paint = np.asarray(image.convert('RGBA'), dtype=np.uint8)
    changed = (rgba[..., 3] < 255) & (paint[..., 3] > 0)
    if not changed.any():
        return rgba
    front = rgba[changed].astype(np.uint32)
    back = paint[changed].astype(np.uint32)
    a = front[:, 3:4] * 255
    b = back[:, 3:4] * (255 - front[:, 3:4])
    total = a + b
    result = rgba.copy()
    result[changed, :3] = (front[:, :3]*a + back[:, :3]*b + total//2) // total
    result[changed, 3] = ((total[:, 0] + 127) // 255)
    return result


def apply_alpha_erase(rgba, payload, sha):
    """Apply optional interior/edge opacity and erase maps; old payloads stay exact."""
    data = edit_data(payload, sha, rgba.shape[:2])
    erase_png = data.get('alpha_erase_png')
    opaque_png = data.get('alpha_opaque_png')
    edge_png = data.get('alpha_edge_png')
    if erase_png is None and opaque_png is None and edge_png is None:
        return add_underpaint(rgba, data.get('underpaint_png'))
    original = rgba[..., 3].astype(np.uint16)
    alpha = original.copy()
    if opaque_png is not None:
        opacity = decode_canvas(opaque_png, rgba.shape[:2]).astype(np.uint16)
        # Recompute the guard from the source, never trust a client-supplied region.
        opacity[~opaque_region(rgba)] = 0
        alpha = alpha + ((255 - alpha) * opacity + 127) // 255
    if edge_png is not None:
        edge = decode_canvas(edge_png, rgba.shape[:2]).astype(np.uint16)
        target = edge_alpha_target(rgba).astype(np.uint16)
        alpha = np.maximum(alpha, original + ((target - original) * edge + 127) // 255)
    if erase_png is not None:
        erased = decode_canvas(erase_png, rgba.shape[:2]).astype(np.uint16)
        alpha = (alpha * (255 - erased) + 127) // 255
    result = rgba.copy()
    # Integer rounding matches the editor. Zero maps preserve every alpha value.
    result[..., 3] = alpha.astype(np.uint8)
    return add_underpaint(result, data.get('underpaint_png'))


@PromptServer.instance.routes.post('/png-inpaint-v4/source-preview')
async def preview_source(request):
    try:
        data=await request.json()
        rgba,sha=source_data(data['image'])
        from .geometry import apply_deformations, DEFORMATION_MODES
        operations=[]
        if 'deformations' in data:
            if data.get('source_sha256')!=sha:raise ValueError('Исходник изменился. Откройте редактор заново.')
            operations=data['deformations']
        elif data.get('mask_data'):
            try:previous=json.loads(data['mask_data'])
            except (ValueError,TypeError):previous={}
            if isinstance(previous,dict) and previous.get('source_sha256')==sha:
                operations=previous.get('deformations',[])
        rgba=apply_deformations(rgba,operations)
        buf=io.BytesIO()
        Image.fromarray(rgba).save(buf,format='PNG')
        guard=io.BytesIO()
        allowed=Image.fromarray(opaque_region(rgba).astype(np.uint8)*255)
        Image.merge('LA',(Image.new('L',allowed.size,255),allowed)).save(guard,format='PNG')
        edge=io.BytesIO()
        edge_region=binary_erosion(rgba[...,3]>0,structure=np.ones((3,3),bool),border_value=0)
        Image.merge('LA',(Image.fromarray(edge_alpha_target(rgba)),
            Image.fromarray(edge_region.astype(np.uint8)*255))).save(edge,format='PNG')
        return web.json_response({'width':rgba.shape[1],'height':rgba.shape[0],
            'source_sha256':sha,'geometry_version':1,'geometry_modes':DEFORMATION_MODES,'smart_selection':True,'local_preview':True,'edge_finish':True,'edge_strokes':True,'underpaint':True,'accumulated_light':True,
            'preview':'data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode(),
            'opaque_region':'data:image/png;base64,'+base64.b64encode(guard.getvalue()).decode(),
            'edge_alpha_target':'data:image/png;base64,'+base64.b64encode(edge.getvalue()).decode()})
    except (ValueError,KeyError,TypeError,OSError) as exc:
        return web.json_response({'error':request_message(exc,request)},status=400)


def make_local_preview(data):
    from .advanced import decode_tools,apply_local
    from .geometry import apply_geometry_payload
    rgba,sha=source_data(data['image']);payload=data.get('mask_data','')
    rgba=apply_geometry_payload(rgba,payload,sha)
    rgba=apply_alpha_erase(rgba,payload,sha)
    summary={}
    tools=decode_tools(payload,sha,rgba.shape[:2])
    commit=data.get('commit_edge') is True
    if commit and data.get('erase_edge') is True:
        from .edge_finish import erase_edge_pixels
        if tools['edge_finish'] is None:
            raise ValueError('Пустой штрих ластика.')
        tools['edge_pixels']=erase_edge_pixels(tools['edge_pixels'],tools['edge_finish'],tools['protect'])
        tools['edge_finish']=None
        summary['edge_pixels']=tools['edge_pixels']
    rgba,_=apply_local(rgba,tools,summary,commit_edge=commit)
    buf=io.BytesIO();Image.fromarray(rgba).save(buf,format='PNG')
    return {'preview':'data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode(),**summary}


@PromptServer.instance.routes.post('/png-inpaint-v4/local-preview')
async def preview_local(request):
    try:
        return web.json_response(await asyncio.to_thread(make_local_preview,await request.json()))
    except (ValueError,KeyError,TypeError,OSError) as exc:
        return web.json_response({'error':request_message(exc,request)},status=400)


class PNGV4AlphaInpaintSource:
    @classmethod
    def INPUT_TYPES(cls):
        files=folder_paths.filter_files_content_types([p.name for p in Path(folder_paths.get_input_directory()).iterdir() if p.is_file()],['image'])
        return {'required': {'image':(sorted(files),{'image_upload':True}),
            'mask_data':('STRING',{'default':'','multiline':False})}}
    RETURN_TYPES=('IMAGE','MASK','IMAGE','V4_TOOLS')
    RETURN_NAMES=('working_image','brush_mask','original_rgba','tools')
    FUNCTION='load'
    CATEGORY='image/alpha tools'

    @classmethod
    def VALIDATE_INPUTS(cls,image,mask_data):
        # Combo values may contain uploaded subdirectories, like native LoadImage.
        try:
            source_data(image)
            return True
        except (ValueError,OSError) as exc:
            return str(exc)

    @classmethod
    def IS_CHANGED(cls,image,mask_data):
        _,sha=source_data(image)
        return sha+hashlib.sha256(mask_data.encode()).hexdigest()

    def load(self,image,mask_data):
        rgba,sha=source_data(image)
        from .geometry import apply_geometry_payload
        rgba=apply_geometry_payload(rgba,mask_data,sha)
        edited=apply_alpha_erase(rgba,mask_data,sha)
        from .advanced import decode_tools
        tools=decode_tools(mask_data,sha,rgba.shape[:2])
        mask=decode_mask(mask_data,sha,rgba.shape[:2],allow_empty=True)
        rgba=edited
        work=flatten_rgba(rgba,127)
        return (torch.from_numpy(work.astype(np.float32)/255)[None],
            torch.from_numpy(mask)[None],torch.from_numpy(rgba.astype(np.float32)/255)[None],tools)


class PNGV4AlphaInpaintFinish:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required':{'original_rgba':('IMAGE',),'edited_working_copy':('IMAGE',),'brush_mask':('MASK',)}}
    RETURN_TYPES=('IMAGE',)
    RETURN_NAMES=('transparent_png',)
    FUNCTION='finish'
    CATEGORY='image/alpha tools'

    def finish(self,original_rgba,edited_working_copy,brush_mask):
        source=np.rint(original_rgba.cpu().numpy()*255).clip(0,255).astype(np.uint8)
        edited=np.rint(edited_working_copy.cpu().numpy()*255).clip(0,255).astype(np.uint8)
        masks=brush_mask.cpu().numpy()
        if source.shape[-1]!=4 or edited.shape!=source.shape[:-1]+(3,) or masks.shape!=source.shape[:3]:
            raise ValueError('Original RGBA, edited RGB and brush mask must share dimensions and batch size.')
        result=[]
        for a,b,m in zip(source,edited,masks):
            restored=restore_rgba(a,b,127)
            original_clean=clean_rgba(a)
            restored[m<=0]=original_clean[m<=0]
            result.append(restored)
        return (torch.from_numpy(np.stack(result).astype(np.float32)/255),)
