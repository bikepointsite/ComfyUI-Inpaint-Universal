import numpy as np
import torch
from .core import clean_rgba, flatten_rgba, restore_rgba


def to_rgba(image, transparency):
    if tuple(image.shape[:3]) != tuple(transparency.shape):
        # Native LoadImage uses a 64x64 zero mask for opaque images.
        if torch.count_nonzero(transparency) == 0:
            transparency = torch.zeros(image.shape[:3], device=image.device)
        else:
            raise ValueError('Image and transparency sizes must match')
    rgb = np.rint(image.detach().cpu().numpy()[..., :3] * 255).clip(0,255).astype(np.uint8)
    alpha = np.rint((1-transparency.detach().cpu().numpy())*255).clip(0,255).astype(np.uint8)
    return np.concatenate([rgb,alpha[...,None]],axis=-1)


class PNGV4AlphaPrepare:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'image': ('IMAGE',), 'transparency': ('MASK',),
            'matte_gray': ('INT', {'default':127,'min':0,'max':255})}}
    RETURN_TYPES = ('IMAGE','IMAGE')
    RETURN_NAMES = ('clean_transparent_png','opaque_working_copy')
    FUNCTION = 'prepare'
    CATEGORY = 'image/alpha tools'

    def prepare(self,image,transparency,matte_gray):
        rgba=to_rgba(image,transparency)
        clean=np.stack([clean_rgba(x) for x in rgba])
        work=np.stack([flatten_rgba(x,matte_gray) for x in rgba])
        return torch.from_numpy(clean.astype(np.float32)/255),torch.from_numpy(work.astype(np.float32)/255)


class PNGV4AlphaRestore:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {'original_image': ('IMAGE',), 'original_transparency': ('MASK',),
            'edited_working_copy': ('IMAGE',), 'matte_gray': ('INT', {'default':127,'min':0,'max':255})}}
    RETURN_TYPES = ('IMAGE',)
    RETURN_NAMES = ('restored_transparent_png',)
    FUNCTION = 'restore'
    CATEGORY = 'image/alpha tools'

    def restore(self,original_image,original_transparency,edited_working_copy,matte_gray):
        rgba=to_rgba(original_image,original_transparency)
        edited=np.rint(edited_working_copy.detach().cpu().numpy()[...,:3]*255).clip(0,255).astype(np.uint8)
        if rgba.shape[0]!=edited.shape[0]:
            raise ValueError('Original and edited batch sizes must match')
        result=np.stack([restore_rgba(a,b,matte_gray) for a,b in zip(rgba,edited)])
        return (torch.from_numpy(result.astype(np.float32)/255),)


NODE_CLASS_MAPPINGS={'PNGV4AlphaPrepare':PNGV4AlphaPrepare,'PNGV4AlphaRestore':PNGV4AlphaRestore}
NODE_DISPLAY_NAME_MAPPINGS={'PNGV4AlphaPrepare':'PNG · Clean hidden colors + prepare brush copy','PNGV4AlphaRestore':'PNG · Restore original transparency'}

from .unified import PNGV4AlphaInpaintSource, PNGV4AlphaInpaintFinish
WEB_DIRECTORY = 'js'
NODE_CLASS_MAPPINGS.update({'PNGV4AlphaInpaintSource':PNGV4AlphaInpaintSource,'PNGV4AlphaInpaintFinish':PNGV4AlphaInpaintFinish})
NODE_DISPLAY_NAME_MAPPINGS.update({'PNGV4AlphaInpaintSource':'PNG · Upload and brush clothing','PNGV4AlphaInpaintFinish':'PNG · Finish transparent inpaint'})

from .universal import NODE_CLASS_MAPPINGS as UNIVERSAL_NODES, NODE_DISPLAY_NAME_MAPPINGS as UNIVERSAL_NAMES
NODE_CLASS_MAPPINGS.update(UNIVERSAL_NODES)
NODE_DISPLAY_NAME_MAPPINGS.update(UNIVERSAL_NAMES)
from .iteration import PNGV4InpaintResult
from .prompt_assistant import PNGV4InpaintPromptAssistant
from . import smart_select
NODE_CLASS_MAPPINGS.update({'PNGV4InpaintResult': PNGV4InpaintResult, 'PNGV4InpaintPromptAssistant': PNGV4InpaintPromptAssistant})
NODE_DISPLAY_NAME_MAPPINGS.update({'PNGV4InpaintResult': 'Inpaint · Результат → продолжить редактирование',
                                 'PNGV4InpaintPromptAssistant': 'Inpaint · Русский запрос → промпт (Grok)'})

# Distinct catalog labels as well as IDs: installing V4 never replaces a V3 node.
NODE_DISPLAY_NAME_MAPPINGS = {key: 'V4 · ' + name for key,name in NODE_DISPLAY_NAME_MAPPINGS.items()}
for node_class in NODE_CLASS_MAPPINGS.values():
    node_class.CATEGORY = 'image/Inpaint V4'
