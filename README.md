# Inpaint Universal 4.1 for ComfyUI

[Инструкция на русском](README_RU.md) · [Model files and downloads](MODELS.md)

Edit a transparent PNG with local SDXL inpainting, or use the manual brushes without running diffusion. The editor includes alpha repair, inward and free edge warps, adjustable curves, dodge and burn, texture healing, SAM selection, ControlNet fold guides and IP-Adapter reference crops. The result node lets you save an RGBA PNG or send it back to the brush editor for another pass.

## Windows portable installation

1. Start a working copy of ComfyUI once, then close it. The tested setup uses ComfyUI **0.12.2** and frontend **1.37.11**. Choose a portable build for your GPU. [ComfyUI portable installation](https://docs.comfy.org/installation/comfyui_portable_windows)
2. Extract this project. Open PowerShell **inside its folder**. Replace the example path with your portable installation and run the commands below. The installer copies the four node packages, workflow, sample PNG and any supplied offline model set. It skips identical files and lists conflicts before copying.
3. If you downloaded this project from GitHub, also install the weights in [MODELS.md](MODELS.md). The local transfer folder includes eight supporting weights (**9.42 GB**). For generation, choose a regular SDXL 1.0 checkpoint that suits your art style. If you already use one in ComfyUI, reuse it. Place any new checkpoint in `ComfyUI/models/checkpoints/`.
4. Start ComfyUI, refresh the browser and open **Workflows → Inpaint_Universal_v4_1**. Alternatively drag `user/default/workflows/Inpaint_Universal_v4_1.json` onto the ComfyUI canvas.

```powershell
$portable = 'D:\ComfyUI_windows_portable'
& "$portable\python_embeded\python.exe" -s .\install.py "$portable\ComfyUI"
& "$portable\python_embeded\python.exe" -s -m pip install -r .\requirements.txt
```

If you use a virtual environment on Windows or Linux, run both commands with that environment’s Python (3.11+ for the copy helper). Give `install.py` the path containing `main.py`. ComfyUI supplies PyTorch and torchvision for your hardware.

### Manual copy

| From this project | Destination under ComfyUI |
|---|---|
| The four folders in `custom_nodes/` | `custom_nodes/` |
| `input/Inpaint_V41_fabric.png` | `input/` |
| `user/default/workflows/Inpaint_Universal_v4_1.json` | `user/default/workflows/`, or open the file directly |
| Contents of `models/` (offline copy) | `models/`, preserving the subfolders |

Install the Python requirements as above. Use one copy of each node package per ComfyUI instance. Existing private V4/V4.1 installations use the same node IDs; use a separate ComfyUI installation to keep those intact.

## First edit

1. The starter graph opens on a blue fabric swatch. The loose thread already has a small red inpaint mask. Select your own model in the expanded **SDXL checkpoint** node and save the workflow to remember your choice. Press **Run** to try soft retouch.
2. For your own image, choose **Upload PNG → Open brush editor** in the first node. Paint the area to change in **Edit mask**, then **Save edits**. Set the mode and desired result, then run. The assistant’s positive and negative prompt fields accept manual input.
3. **Save result** writes the selected full-size PNG under `output/Inpaint_V4/`. **Continue editing** loads that result into the first node and opens the brush editor. Temporary results can expire on restart.
4. For a manual-only edit, clear the red generation mask, apply an alpha or retouch brush, then choose **Save edits**. The result appears immediately. **Clear all masks** keeps the edited contour.

## Language and optional prompt assistant

Use **Inpaint · Язык / Language** on the first node to select **English** or **Русский**. Save any open edits and your workflow, then refresh the tab. The choice is remembered in that browser. The default follows the browser language. The surrounding ComfyUI interface has its own language setting.

### Connect your own Grok API key

This setting is optional. Manual prompts and image generation work locally.

1. Open **API Keys** in your account and create a key. Find the ID of a text model available to your account. [Create an API key](https://console.x.ai/team/default/api-keys) · [xAI models](https://docs.x.ai/developers/models)
2. **After installation**, open **`ComfyUI/inpaint-grok.local.json`** in a text editor on the machine running the server. It sits beside `main.py`. The installer creates a blank file. For a manual installation, create the file yourself using this exact name and the JSON below.
3. Paste your own key between the quotes in **`api_key`**, and enter the model ID in **`model`**. Save the file. The assistant reads the settings the next time you click **Prepare prompts**.

```json
{
  "api_key": "",
  "model": ""
}
```

The portable assistant reads credentials only from this file. Keep the filled file on your own computer. Preparing prompts sends the edit description and mode to xAI. The local response cache lives under `ComfyUI/user/inpaint/prompt-cache/`.

If you **already installed the previous portable release**, stop that server, copy the updated `prompt_assistant.py` and `messages.py` from the bundle’s `custom_nodes/png_inpaint_v4/` into the same folder in your installation, then start ComfyUI again. Create the settings file using the example above.

## Troubleshooting

- **Missing nodes.** Check the ComfyUI startup console for import errors. Install requirements with the Python used to launch ComfyUI, confirm the four folders sit directly under `custom_nodes`, then restart the server.
- **Unknown checkpoint or patch.** Select an installed regular SDXL checkpoint and verify both Fooocus filenames. For Smart selection, references, or adding an object beyond the silhouette, check the matching row of [MODELS.md](MODELS.md).
- **Low VRAM.** Start with one variant and a 768 px crop. Enable ControlNet or IP-Adapter when the edit needs it.
- **Incorrect editor layout after updating.** Save your edits and workflow, restart ComfyUI, then refresh with Ctrl+F5.

## Sharing

The root `.gitignore` excludes model weights. The starter workflow uses the included fabric sample. Model sources and separate licenses are listed in [MODELS.md](MODELS.md) and [THIRD_PARTY.md](THIRD_PARTY.md).
