"""Add a generated accessory to straight-alpha artwork on the editor's gray matte."""
import cv2
import numpy as np

from .core import clean_rgba, flatten_rgba


def attachment_surface(alpha):
    # Some sprites are translucent throughout. Ignore weak fringe pixels when
    # a more solid point of attachment is available.
    return alpha >= max(1, min(96, int(alpha.max())))


def validate_attachment(alpha, mask):
    painted = mask > 0
    count, labels = cv2.connectedComponents(painted.astype(np.uint8), connectivity=8)
    touches_sprite = np.bincount(labels[painted & attachment_surface(alpha)], minlength=count) > 0
    touches_background = np.bincount(labels[painted & (alpha == 0)], minlength=count) > 0
    if not (touches_sprite & touches_background).any():
        raise ValueError('Проведите красной кистью через край PNG: соедините место крепления на персонаже с областью предмета на прозрачном фоне.')


def composite_attachment(rgba, generated, mask, weight, prediction):
    original = flatten_rgba(rgba).astype(np.float32)
    generated = generated.astype(np.float32)
    old_alpha = rgba[..., 3].astype(np.float32) / 255.
    # Remove low-confidence background while retaining a soft subpixel edge.
    matte = np.clip((prediction - .10) / .84, 0., 1.)
    # The diffusion pass can introduce slight gray drift, including inside bow
    # loops. Gate *new* opacity by an actual visible change from the known matte.
    difference = np.max(np.abs(generated - original), axis=2)
    evidence = np.clip((difference - 4.) / 10., 0., 1.)
    new_alpha = old_alpha + np.maximum(matte - old_alpha, 0.) * evidence
    # Keep only foreground connected through the brush to the selected anchor.
    # Do not close or fill the mask: holes between loops and ribbons stay open.
    foreground = (mask > 0) & (new_alpha > .025)
    count, labels = cv2.connectedComponents(foreground.astype(np.uint8), connectivity=8)
    anchored = np.bincount(labels[foreground & attachment_surface(rgba[..., 3])], minlength=count) > 0
    confident = np.bincount(labels[foreground & (matte >= .55)], minlength=count) > 0
    keep = foreground & (anchored & confident)[labels]
    blend = np.where(keep, weight, 0.)
    alpha = np.maximum(rgba[..., 3], np.rint((old_alpha + blend * (new_alpha - old_alpha)) * 255).astype(np.uint8))
    mixed = original + blend[..., None] * (generated - original)
    # Remove the neutral matte before saving straight RGB, so partially
    # transparent edge pixels also composite cleanly on light or dark game UIs.
    opacity = alpha[..., None].astype(np.float32) / 255.
    rgb = (mixed - 127. * (1. - opacity)) / np.maximum(opacity, 1. / 255.)
    out = clean_rgba(rgba)
    edited = keep & (alpha > 0) & ((alpha != rgba[..., 3]) | np.any(np.rint(mixed) != original, axis=2))
    out[edited, :3] = np.rint(rgb[edited]).clip(0, 255).astype(np.uint8)
    out[..., 3] = alpha
    return out
