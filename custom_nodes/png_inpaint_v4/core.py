"""Lossless hidden-RGB cleanup and explicit straight-alpha compositing for 8-bit PNGs."""
import numpy as np


def clean_rgba(rgba):
    result = np.asarray(rgba, dtype=np.uint8).copy()
    if result.ndim != 3 or result.shape[-1] != 4:
        raise ValueError('Expected H x W x 4 RGBA image')
    result[result[:, :, 3] == 0, :3] = 0
    return result


def flatten_rgba(rgba, matte=127):
    rgba = np.asarray(rgba, dtype=np.uint8)
    alpha = rgba[:, :, 3:4].astype(np.float64) / 255
    return np.clip(np.rint(rgba[:, :, :3] * alpha + matte * (1-alpha)), 0, 255).astype(np.uint8)


def restore_rgba(original_rgba, edited_rgb, matte=127):
    original = np.asarray(original_rgba, dtype=np.uint8)
    edited = np.asarray(edited_rgb, dtype=np.uint8)
    if edited.shape != original.shape[:2] + (3,):
        raise ValueError('Original and edited image must have identical dimensions; do not resize the working copy.')
    expected = flatten_rgba(original, matte)
    changed = np.any(edited != expected, axis=-1)
    alpha = original[:, :, 3:4].astype(np.float64) / 255
    foreground = np.clip(np.rint((edited.astype(np.float64) - matte*(1-alpha)) / np.maximum(alpha, 1/255)), 0, 255).astype(np.uint8)
    result = clean_rgba(original)
    update = changed & (original[:, :, 3] > 0)
    result[update, :3] = foreground[update]
    return result
