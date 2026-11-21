"""Local texture and silhouette warps in straight RGBA images."""
import math
import numpy as np

DEFORMATION_MODES=('surface','shrink','contour','free_edge')

def validate_deformations(operations, shape):
    if not isinstance(operations,list) or len(operations)>128:
        raise ValueError('Сохраните результат и продолжите: доступно до 128 деформаций за проход.')
    result=[]
    for item in operations:
        if not isinstance(item,dict) or item.get('mode') not in DEFORMATION_MODES:
            raise ValueError('Неизвестный режим деформации.')
        op={'mode':item['mode']}
        for key in ('from','to'):
            p=item.get(key)
            if not isinstance(p,list) or len(p)!=2 or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in p):
                raise ValueError('Некорректная точка деформации.')
            if not 0<=p[0]<=shape[1]-1 or not 0<=p[1]<=shape[0]-1:
                raise ValueError('Деформация выходит за пределы изображения.')
            op[key]=list(map(float,p))
        for key,low,high in [('radius',.5,512),('strength',0,1)]:
            value=item.get(key)
            if not isinstance(value,(int,float)) or not math.isfinite(value) or not low<=value<=high:
                raise ValueError('Некорректный размер или сила деформации.')
            op[key]=float(value)
        if item.get('protect_png'):op['protect_png']=item['protect_png']
        result.append(op)
    return result


def warp_rgba(rgba, op, protected=None):
    h,w=rgba.shape[:2];radius=op['radius']
    contour_only=op['mode']=='contour'
    free_edge=op['mode']=='free_edge'
    dx=(op['to'][0]-op['from'][0])*op['strength'];dy=(op['to'][1]-op['from'][1])*op['strength']
    length=math.hypot(dx,dy)
    if length<1e-6:return rgba.copy()
    if length>radius*.45:dx*=radius*.45/length;dy*=radius*.45/length
    cx,cy=op['from'][0]+dx,op['from'][1]+dy
    x0,x1=max(0,math.floor(cx-radius)),min(w,math.ceil(cx+radius)+1)
    y0,y1=max(0,math.floor(cy-radius)),min(h,math.ceil(cy+radius)+1)
    yy,xx=np.mgrid[y0:y1,x0:x1].astype(np.float64)
    t=((xx-cx)**2+(yy-cy)**2)/radius**2
    weight=np.maximum(0,1-t)**2
    mx=np.clip(xx-dx*weight,0,w-1);my=np.clip(yy-dy*weight,0,h-1)
    ix=np.floor(mx).astype(np.int32);iy=np.floor(my).astype(np.int32)
    fx=mx-ix;fy=my-iy
    sample=np.zeros((*mx.shape,4),np.float64)
    # Premultiplied interpolation excludes hidden RGB from transparent pixels.
    for ox,oy,coeff in [(0,0,(1-fx)*(1-fy)),(1,0,fx*(1-fy)),(0,1,(1-fx)*fy),(1,1,fx*fy)]:
        p=rgba[np.minimum(iy+oy,h-1),np.minimum(ix+ox,w-1)].astype(np.float64)
        sample[...,3]+=p[...,3]*coeff
        if not contour_only:sample[...,:3]+=p[...,:3]*(p[...,3]*coeff)[...,None]
    alpha=sample[...,3]
    result=rgba.copy();patch=result[y0:y1,x0:x1]
    touched=t<1
    if not free_edge:
        touched&=patch[...,3]>0
    else:
        # Preserve hidden RGB where both source and destination stay transparent.
        touched&=(patch[...,3]>0)|(alpha>=.5)
    if protected is not None:touched&=protected[y0:y1,x0:x1]==0
    if not contour_only:
        rgb=sample[...,:3]/np.maximum(alpha[...,None],1e-12)
        color=touched&(alpha>1e-6)
        patch[color,:3]=np.floor(rgb[color]+.5).clip(0,255).astype(np.uint8)
    if op['mode'] in ('shrink','contour','free_edge'):
        warped_alpha=np.floor(alpha+.5).clip(0,255).astype(np.uint8)
        if not free_edge:
            warped_alpha=np.minimum(patch[...,3],warped_alpha)
        patch[touched,3]=warped_alpha[touched]
        # Alpha-only editing preserves RGB even where pixels become invisible.
        if not contour_only:patch[touched&(patch[...,3]==0),:3]=0
    return result


def apply_deformations(rgba,operations):
    from .unified import decode_canvas
    for op in validate_deformations(operations,rgba.shape[:2]):
        protected=decode_canvas(op['protect_png'],rgba.shape[:2]) if op.get('protect_png') else None
        rgba=warp_rgba(rgba,op,protected)
    return rgba


def apply_geometry_payload(rgba,payload,sha):
    from .unified import edit_data
    return apply_deformations(rgba,edit_data(payload,sha,rgba.shape[:2]).get('deformations',[]))
