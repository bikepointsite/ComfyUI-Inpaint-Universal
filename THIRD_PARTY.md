# Third-party components

| Component included in custom_nodes/ | Upstream | License shipped with the code |
|---|---|---|
| comfyui-inpaint-nodes 1.4.4, including its runtime MAT module | [Acly/comfyui-inpaint-nodes](https://github.com/Acly/comfyui-inpaint-nodes) | [GPL v3](custom_nodes/comfyui-inpaint-nodes/LICENSE) and the [separate MAT architecture notice, CC BY-NC 4.0](custom_nodes/comfyui-inpaint-nodes/mat/arch/LICENSE) |
| comfyui_ipadapter_plus 2.0.0 | [cubiq/ComfyUI_IPAdapter_plus](https://github.com/cubiq/ComfyUI_IPAdapter_plus) | [GPL v3](custom_nodes/comfyui_ipadapter_plus/LICENSE) |

These directories contain the upstream runtime sources from the tested installation, their project metadata and license notices. The workflow uses the Fooocus and color-match nodes from the first package and the SDXL Plus loader and conditioning nodes from the second.

ComfyUI, its frontend and the Python packages in `requirements.txt` are installed in the destination environment. SAM uses [Meta’s Segment Anything](https://github.com/facebookresearch/segment-anything). Weight sources are listed in [MODELS.md](MODELS.md). Keep upstream license and attribution files when sharing the project. The local model directory is excluded from Git.
