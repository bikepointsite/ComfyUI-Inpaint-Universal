"""Local SAM selection. CPU inference and one-image embedding cache; no downloads."""
import asyncio
import base64
import hashlib
import io
import json
import math
import threading
import time
from pathlib import Path
import numpy as np
from PIL import Image
from aiohttp import web
from .messages import request_message
from scipy.ndimage import distance_transform_edt
import folder_paths
from server import PromptServer
from .unified import source_data, apply_alpha_erase
from .geometry import apply_geometry_payload

_lock=threading.Lock()
_predictor=None
_cache_key=None


def selection_prompts(body,shape):
    points=body.get('points',[]);box=body.get('box')
    if not isinstance(points,list) or len(points)>64:raise ValueError('Допустимо до 64 точек выделения.')
    coords=[];labels=[]
    for p in points:
        if not isinstance(p,list) or len(p)!=3 or p[2] not in (0,1) or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in p):
            raise ValueError('Некорректная точка выделения.')
        if not 0<=p[0]<shape[1] or not 0<=p[1]<shape[0]:raise ValueError('Точка вне изображения.')
        coords.append(p[:2]);labels.append(p[2])
    if box is not None:
        if not isinstance(box,list) or len(box)!=4 or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in box):
            raise ValueError('Некорректная рамка выделения.')
        x0,y0,x1,y1=box
        if not 0<=x0<x1<=shape[1]-1 or not 0<=y0<y1<=shape[0]-1:raise ValueError('Рамка вне изображения.')
        if any(label and not(x0<=p[0]<=x1 and y0<=p[1]<=y1) for p,label in zip(coords,labels)):
            raise ValueError('Включающие точки должны находиться внутри рамки.')
    if 1 not in labels and box is None:raise ValueError('Поставьте точку «Включить» или задайте рамку.')
    feather=body.get('feather',2)
    if not isinstance(feather,(int,float)) or not math.isfinite(feather) or not 0<=feather<=16:raise ValueError('Сглаживание должно быть от 0 до 16 px.')
    return np.array(coords,np.float32) if coords else None,np.array(labels,np.int32) if labels else None,np.array(box,np.float32) if box else None,float(feather)


def refine_selection(mask,alpha,box,feather):
    support=np.asarray(mask,dtype=bool)&(alpha>0)
    if box is not None:
        yy,xx=np.ogrid[:support.shape[0],:support.shape[1]]
        support&=(xx>=box[0])&(xx<=box[2])&(yy>=box[1])&(yy<=box[3])
    if feather>0:
        distance=distance_transform_edt(np.pad(support,1))[1:-1,1:-1]
        t=np.clip(distance/feather,0,1);return np.floor(255*t*t*(3-2*t)+.5).astype(np.uint8)
    return support.astype(np.uint8)*255


def predict_selection(body):
    global _predictor,_cache_key
    started=time.perf_counter()
    rgba,sha=source_data(body['image'])
    if body.get('source_sha256')!=sha:raise ValueError('Исходник изменился. Откройте редактор заново.')
    payload=body.get('mask_data')
    if payload:
        rgba=apply_alpha_erase(apply_geometry_payload(rgba,payload,sha),payload,sha)
    points,labels,box,feather=selection_prompts(body,rgba.shape[:2])
    key=hashlib.sha256(rgba.tobytes()).hexdigest()
    alpha=rgba[...,3:4].astype(np.float32)/255
    rgb=np.floor(rgba[...,:3]*alpha+127*(1-alpha)+.5).astype(np.uint8)
    with _lock:
        if _predictor is None:
            try:from segment_anything import sam_model_registry,SamPredictor
            except ImportError as exc:raise ValueError('Не установлен segment_anything для умного выделения.') from exc
            checkpoint=Path(folder_paths.models_dir)/'sams/sam_vit_b_01ec64.pth'
            if not checkpoint.is_file():raise ValueError('Не найдена модель models/sams/sam_vit_b_01ec64.pth.')
            model=sam_model_registry['vit_b'](checkpoint=str(checkpoint)).eval().cpu()
            _predictor=SamPredictor(model)
        import torch
        with torch.inference_mode():
            cached=key==_cache_key
            if not cached:_predictor.set_image(rgb);_cache_key=key
            masks,scores,_=_predictor.predict(point_coords=points,point_labels=labels,box=box,multimask_output=True)
    candidates=[]
    for index in np.argsort(scores)[::-1]:
        mask=refine_selection(masks[index],rgba[...,3],box,feather)
        if not mask.any():continue
        buf=io.BytesIO();Image.fromarray(mask).save(buf,format='PNG')
        candidates.append({'png':base64.b64encode(buf.getvalue()).decode(),'score':round(float(scores[index]),4),'pixels':int(np.count_nonzero(mask))})
    if not candidates:raise ValueError('Область не найдена. Уточните точки или рамку.')
    return {'source_sha256':sha,'candidates':candidates,'seconds':round(time.perf_counter()-started,2),'cached':cached,'device':'cpu'}


@PromptServer.instance.routes.post('/png-inpaint-v4/smart-select')
async def smart_select(request):
    try:return web.json_response(await asyncio.to_thread(predict_selection,await request.json()))
    except (ValueError,KeyError,TypeError,OSError,RuntimeError) as exc:
        return web.json_response({'error':request_message(exc,request)},status=400)
