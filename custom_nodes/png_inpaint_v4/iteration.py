"""Session-only previews, lossless iteration, and explicit final PNG saving."""
import asyncio
import hashlib
import io
import json
import threading
import uuid
from pathlib import Path

import folder_paths
import nodes
from aiohttp import web
from .messages import request_message
from PIL import Image
from PIL.PngImagePlugin import PngInfo
from server import PromptServer

from .unified import source_data, decode_mask, apply_alpha_erase
from .core import clean_rgba


def output_path(descriptor):
    if not isinstance(descriptor, dict) or descriptor.get('type') not in ('temp', 'output'):
        raise ValueError('Нужен временный или сохранённый PNG результата.')
    filename, subfolder = descriptor.get('filename'), descriptor.get('subfolder', '')
    if not isinstance(filename, str) or not filename or Path(filename).name != filename or any(c in filename for c in '/\\:'):
        raise ValueError('Некорректное имя результата.')
    if not isinstance(subfolder, str):
        raise ValueError('Некорректная папка результата.')
    root = Path(folder_paths.get_directory_by_type(descriptor['type'])).resolve()
    path = (root / subfolder / filename).resolve()
    if not path.is_relative_to(root) or not path.is_file() or path.suffix.lower() != '.png':
        raise ValueError('PNG результата недоступен. Временные результаты удаляются при перезапуске ComfyUI.')
    return path


def checked_result(descriptor, expected_sha):
    path = output_path(descriptor)
    data = path.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    if not isinstance(expected_sha, str) or sha != expected_sha:
        raise ValueError('Файл результата изменился. Создайте или откройте актуальный результат.')
    with Image.open(io.BytesIO(data)) as image:
        if image.format != 'PNG' or image.mode != 'RGBA':
            raise ValueError('Нужен RGBA PNG с сохранённой прозрачностью, не картинка сравнения.')
        if image.width * image.height > 32_000_000:
            raise ValueError('PNG превышает 32 мегапикселя.')
        image.load()
        width, height = image.size
    return path, data, sha, width, height


def promote_output(descriptor, expected_sha):
    path, _, sha, width, height = checked_result(descriptor, expected_sha)
    kind = descriptor['type']
    root = Path(folder_paths.get_directory_by_type(kind)).resolve()
    relative = path.relative_to(root)
    # ComfyUI's annotated path loads the same file. No duplicate is created in input.
    return {'image': f'{relative.as_posix()} [{kind}]', 'filename': path.name,
            'subfolder': relative.parent.as_posix() if relative.parent != Path('.') else '',
            'type': kind, 'source_sha256': sha,
            'width': width, 'height': height}


_save_lock = threading.Lock()
_saved_results = {}


def save_result(descriptor, expected_sha, filename_prefix='Inpaint_V4/Result'):
    path, data, sha, width, height = checked_result(descriptor, expected_sha)
    if descriptor['type'] == 'output':
        return {**promote_output(descriptor, sha), 'sha256': sha, 'already_saved': True}
    if not isinstance(filename_prefix, str) or not filename_prefix.strip() or len(filename_prefix) > 1024:
        raise ValueError('Укажите имя результата в поле «Имя файла при сохранении».')
    prefix = filename_prefix.replace('\\', '/').strip()
    if any(c in prefix for c in '<>:"|?*\x00') or '..' in Path(prefix).parts:
        raise ValueError('Некорректное имя или папка результата.')
    with _save_lock:
        root = Path(folder_paths.get_output_directory()).resolve()
        # Resolve inside the lock: on Windows a simultaneous mkdir can change
        # resolve() to the extended-length spelling midway through parent lookup.
        # Check junctions before ComfyUI creates any folders.
        if not (root / prefix).resolve().is_relative_to(root) or Path(prefix).is_absolute():
            raise ValueError('Сохранение разрешено только внутри output.')
        key = (str(root), prefix, sha)
        target = _saved_results.get(key)
        already_saved = bool(target and target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == sha)
        if not already_saved:
            directory, name, counter, _, _ = folder_paths.get_save_image_path(prefix, str(root), width, height)
            while True:
                target = (Path(directory) / f'{name.replace("%batch_num%", "0")}_{counter:05}_.png').resolve()
                if not target.is_relative_to(root):
                    raise ValueError('Сохранение разрешено только внутри output.')
                try:
                    stream = target.open('xb')  # Never overwrite an existing user file.
                    break
                except FileExistsError:
                    counter += 1
            try:
                with stream:
                    stream.write(data)  # Byte copy retains full RGBA and workflow metadata.
            except OSError:
                target.unlink(missing_ok=True)
                raise
            _saved_results[key] = target
        relative = target.relative_to(root)
        saved = {'filename': target.name, 'subfolder': relative.parent.as_posix() if relative.parent != Path('.') else '', 'type': 'output'}
        return {**promote_output(saved, sha), 'sha256': sha, 'already_saved': already_saved}


@PromptServer.instance.routes.post('/png-inpaint-v4/continue-edit')
async def continue_edit(request):
    try:
        body = await request.json()
        result = await asyncio.to_thread(promote_output, body.get('image'), body.get('sha256'))
        return web.json_response(result)
    except (ValueError, KeyError, OSError, TypeError, AttributeError) as exc:
        return web.json_response({'error':request_message(exc,request)}, status=400)


@PromptServer.instance.routes.post('/png-inpaint-v4/save-result')
async def save_result_route(request):
    try:
        body = await request.json()
        result = await asyncio.to_thread(save_result, body.get('image'), body.get('sha256'),
                                        body.get('filename_prefix', 'Inpaint_V4/Result'))
        return web.json_response(result)
    except (ValueError, KeyError, OSError, TypeError, AttributeError) as exc:
        return web.json_response({'error':request_message(exc,request)}, status=400)


def make_alpha_result(image, mask_data, source_node_id, workflow=None):
    """Render an alpha-only edit directly; never enqueue a graph or load a model."""
    rgba, sha = source_data(image)
    mask = decode_mask(mask_data, sha, rgba.shape[:2], allow_empty=True)
    if mask.any():
        raise ValueError('В маске Inpaint есть выделение. Для генерации используйте «Запустить»; для одной прозрачности очистите маску Inpaint.')
    from .advanced import decode_tools, apply_local
    from .geometry import apply_geometry_payload
    geometry=apply_geometry_payload(rgba,mask_data,sha)
    result, _ = apply_local(apply_alpha_erase(geometry, mask_data, sha), decode_tools(mask_data,sha,rgba.shape[:2]))
    metadata = PngInfo()
    if workflow is not None:
        if not isinstance(workflow, dict):
            raise ValueError('Некорректный workflow.')
        metadata.add_text('workflow', json.dumps(workflow, ensure_ascii=False))
    metadata.add_text('inpaint_alpha', json.dumps({'source_image':image, 'source_sha256':sha,
                                                'source_node_id':str(source_node_id)}))
    root = Path(folder_paths.get_temp_directory()).resolve()
    directory = (root / 'InpaintV4Session').resolve()
    if not directory.is_relative_to(root):
        raise ValueError('Временный результат должен находиться внутри temp.')
    directory.mkdir(parents=True, exist_ok=True)
    filename = 'alpha_' + uuid.uuid4().hex + '.png'
    path = directory / filename
    try:
        Image.fromarray(result).save(path, format='PNG', pnginfo=metadata, compress_level=4)
    except OSError:
        path.unlink(missing_ok=True)
        raise
    ref = {'filename':filename, 'subfolder':'InpaintV4Session', 'type':'temp',
           'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    return {'images':[ref], 'source_node_id':str(source_node_id), 'manual_alpha':True, 'local_tools':True}


@PromptServer.instance.routes.post('/png-inpaint-v4/alpha-result')
async def alpha_result_route(request):
    try:
        body = await request.json()
        result = await asyncio.to_thread(make_alpha_result, body['image'], body['mask_data'],
                                        body['source_node_id'], body.get('workflow'))
        return web.json_response(result)
    except (ValueError, KeyError, OSError, TypeError, AttributeError) as exc:
        return web.json_response({'error':request_message(exc,request)}, status=400)


class PNGV4InpaintResult(nodes.SaveImage):
    def __init__(self):
        super().__init__()
        self.output_dir = folder_paths.get_temp_directory()
        self.type = 'temp'

    @classmethod
    def INPUT_TYPES(cls):
        spec = super().INPUT_TYPES()
        spec['hidden']['unique_id'] = 'UNIQUE_ID'
        spec['required']['filename_prefix'][1]['default'] = 'Inpaint_V4/Result'
        return spec

    DESCRIPTION = 'Промежуточные PNG хранятся в temp до перезапуска ComfyUI. «Сохранить результат» записывает финальный RGBA PNG в output.'

    def save_images(self, images, filename_prefix='Inpaint_V4/Result', prompt=None,
                    extra_pnginfo=None, unique_id=None):
        if images.ndim != 4 or images.shape[-1] != 4:
            raise ValueError('Подключите transparent_png, а не before_after: результат должен содержать alpha.')
        source_id = None
        if prompt and unique_id is not None:
            own = prompt.get(str(unique_id), {})
            edge = own.get('inputs', {}).get('images')
            if isinstance(edge, list) and len(edge) == 2 and edge[1] == 0:
                engine = prompt.get(str(edge[0]), {})
                source = engine.get('inputs', {}).get('original_rgba')
                if engine.get('class_type') == 'PNGV4UniversalInpaint' and isinstance(source, list) and source[1] == 2:
                    candidate = prompt.get(str(source[0]), {})
                    if candidate.get('class_type') == 'PNGV4AlphaInpaintSource':
                        source_id = str(source[0])
        result = super().save_images(images, 'InpaintV4Session/result_' + uuid.uuid4().hex, prompt, extra_pnginfo)
        refs = [dict(image, sha256=hashlib.sha256(output_path(image).read_bytes()).hexdigest())
                for image in result['ui']['images']]
        result['ui']['inpaint_result'] = [{'images': refs, 'source_node_id': source_id, 'filename_prefix': filename_prefix}]
        return result
