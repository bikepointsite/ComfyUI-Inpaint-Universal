# Model files / Модели

The personal transfer bundle includes eight supporting model files in `models/` (9.42 GB total). Copy that directory to `ComfyUI/models/`. For a GitHub installation use the sources below. The filename in the first column is the **destination name**, even when the download has another name.

В локальном комплекте восемь вспомогательных файлов уже лежат в `models/`. Для GitHub-версии скачайте модели из таблицы. В первом столбце указано точное имя и расположение файла относительно `ComfyUI/models/`. Папки можно создать вручную.

## Select your base model / Выбор основной модели

For generation, select your own regular SDXL 1.0 checkpoint in the **SDXL checkpoint** node and save the workflow. Use an existing checkpoint or add one to `ComfyUI/models/checkpoints/`. If you need a starting point, [SDXL Base 1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/sd_xl_base_1.0.safetensors) is one option. The bundled Fooocus patch and guide models target SDXL 1.0.

Для генерации выберите свой обычный чекпойнт SDXL 1.0 в ноде **Модель SDXL** и сохраните workflow. Подойдёт уже установленный в ComfyUI чекпойнт нужного вам стиля. Для тестовой ретуши также нужны оба файла Fooocus. Остальные модели используются перечисленными ниже инструментами.

## Supporting models / Вспомогательные модели

| Destination under models/ | Used for / Назначение | Source |
|---|---|---|
| `inpaint/fooocus_inpaint_head.pth` | Fooocus inpaint head / локальная перерисовка | [Fooocus head](https://huggingface.co/lllyasviel/fooocus_inpaint/blob/main/fooocus_inpaint_head.pth) |
| `inpaint/inpaint_v26.fooocus.patch` | SDXL inpaint patch / патч Fooocus | [Fooocus v2.6](https://huggingface.co/lllyasviel/fooocus_inpaint/blob/main/inpaint_v26.fooocus.patch) |
| `inpaint/big-lama.pt` | Prefill for detail removal and reconstruction / заполнение при удалении объекта или детали | [LaMa TorchScript weights](https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt) |
| `inpaint/birefnet-general-lite.onnx` | Cut out generated objects beyond the silhouette / вырезание выступающего предмета | [BiRefNet General Lite ONNX](https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx) |
| `sams/sam_vit_b_01ec64.pth` | CPU smart selection / умное выделение | [Meta SAM ViT-B](https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth) |
| `controlnet/xinsir_scribble_sdxl_1.0.safetensors` | Fold and seam guides / направляющие складок и швов | [xinsir Scribble SDXL](https://huggingface.co/xinsir/controlnet-scribble-sdxl-1.0/blob/main/diffusion_pytorch_model.safetensors) |
| `ipadapter/ip-adapter-plus_sdxl_vit-h.safetensors` | Appearance reference / перенос внешнего вида | [IP-Adapter Plus SDXL ViT-H](https://huggingface.co/h94/IP-Adapter/blob/main/sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors) |
| `clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | Vision encoder paired with IP-Adapter / энкодер для образца | [CLIP Vision ViT-H](https://huggingface.co/h94/IP-Adapter/blob/main/models/image_encoder/model.safetensors) |

[models.sha256](models.sha256) lists the SHA-256 hashes of the tested local set. To compare one file in PowerShell, run `Get-FileHash -Algorithm SHA256 .\models\inpaint\big-lama.pt` from the project directory. Each model is distributed under its publisher’s terms.
