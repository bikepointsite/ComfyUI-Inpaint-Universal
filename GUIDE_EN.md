# Inpaint Universal V4.1 user guide

[Руководство на русском](GUIDE_RU.md) · [Installation](README.md) · [Model files](MODELS.md)

Use Inpaint to change a selected part of an image. You can remove a stain from a photo, replace a patch on a jacket, draw a curved seam, or repair the transparent edge of a game sprite. A JPEG with its original background works for the first three tasks.

[Image formats](#formats) · [Your first edit](#start) · [Editing modes](#modes) · [Masks and SAM](#masks) · [Stroke shapes](#strokes) · [Manual retouch and edges](#manual) · [Generation settings](#settings) · [Guides, references and prompts](#guides) · [Saving and troubleshooting](#results)

<a id="formats"></a>

## 1. Open an image and choose an output

| Source | How to open it | What to expect |
|---|---|---|
| PNG with transparency | In the first node, choose **Upload PNG**. | The image keeps its alpha channel during ordinary inpainting. The edge tools let you change it deliberately. |
| Opaque PNG | Use the same **Upload PNG** button. | You can retouch the subject, an object or the background. |
| JPEG/JPG, WebP, BMP, TIFF or GIF | Put the file directly in **`ComfyUI/input/`**. Refresh the file list. If necessary, save your current work and reload the tab. In the first node, select the filename in **image**, then choose **Open brush editor**. | The editor opens the image and saves the result as **RGBA PNG**. It uses the first frame of a GIF or the first page of a multipage TIFF. |

**A transparent background is optional.** The **Upload PNG** file picker filters for PNG. The **image** list in the same node also accepts the other formats above. Leave the original file extension in place.

The input limit is **32 megapixels**. The loader applies EXIF orientation and converts the image to 8-bit RGBA. Every pixel of an ordinary JPEG starts fully opaque. Where a person meets a wall in a photo, the boundary comes from color and texture. Use **Edit mask**, **Smart selection** or **Smooth contour** there. **Edit contour A–B** follows an existing alpha boundary. Switching the preview background helps you inspect a part of the image that is already transparent.

<a id="start"></a>

## 2. Your first edit

Try removing a loose thread from a photo of a blue sleeve.

1. Open **Inpaint_Universal_v4_1**. In **SDXL checkpoint**, choose a regular SDXL 1.0 checkpoint that suits the image. Save the workflow to remember it.
2. Choose the photo in the first node. In **Mode and enhancements**, select **Retouch a small detail or tattoo**. For a faint blemish with the correct weave still visible underneath, start with **Soft skin or surface retouch**.
3. Choose **Open brush editor**. Select **Edit mask** on the left and paint the thread red, leaving a small margin. If it runs close to a button, paint the button with **Protection mask**. Choose **Save edits**.
4. In the connected prompt assistant, enter `blue woven sleeve fabric, continuous weave, matching color and lighting` in the positive field. An optional negative prompt is `loose thread, stain`. If you have set up Grok, you can describe the edit in English or Russian and choose **Prepare prompts**.
5. Choose **Run**. Compare the result with the source. Choose **Save result** to keep it, or **Continue editing** to open the result as the starting point for the next pass.

**Apply stroke** commits the curve you are shaping to the active editor layer. **Save edits** sends your masks and manual edits back to the workflow. **Save result** writes the full-size PNG to `ComfyUI/output/Inpaint_V4/` when using the default filename prefix.

### Nodes in the starter workflow

| Node | What you do there |
|---|---|
| **1 · PNG and brushes** | Pick the source, open the brush editor, paint masks and make manual edits. |
| **Prompt assistant** | Enter positive and negative prompts or ask Grok to prepare them from an edit description. |
| **SDXL checkpoint / Fooocus inpaint patch** | The first node selects the model that determines the visual style. The second loads the two Fooocus files used by reconstruction modes. Soft retouch starts directly from the existing surface. |
| **2 · Mode and enhancements** | Set the task, denoise strength, crop resolution, optional models and number of variants. The outputs include the full-size result, a comparison and a text report. |
| **3 · Save or continue editing** | Choose a generated variant, save it, or send it back to the brush editor. |
| **Source (left) · result (right)** | Inspect the before-and-after comparison. Use **Save result** in the preceding node for the full-resolution image. |

<a id="modes"></a>

## 3. Choose an editing mode

The strengths below are the initial settings for each mode. To see what changing denoise strength does, keep the seed and edit mask fixed.

| Mode | Use it when | Starting point |
|---|---|---|
| **Soft skin or surface retouch** | Shape and pattern look right, but a small patch looks uneven or has a visible join. | **0.28**. The pass starts from the existing surface. Describe its material, tone and lighting. Enable **Retouch up to the PNG edge** for a defect against transparency. |
| **Retouch a small detail or tattoo** | A mark, thread, small motif or piece of fabric needs to disappear. | **0.48**. LaMa fills the marked area first, then SDXL reconstructs detail. Describe the clean surface you want there. |
| **Remove and reconstruct** | A whole object needs to disappear and the surface behind it needs rebuilding. | **0.86**. Cover the object and any visible trace it leaves. For a patch on jeans, try `continuous blue denim, matching weave and lighting`. |
| **Replace clothing or an object** | The replacement has a different shape or material. | **0.92**. Mask the space the new object will occupy. Try `round brass button, worn metal, side lighting`. The existing silhouette limits the result. |
| **Reshape proportions** | A feature needs to be wider, narrower, taller or shorter within the silhouette. | **0.80** with the starting geometry. **Region width / height** at **100%** keeps the original size. Changing either percentage gives an automatic starting strength of **0.48**. Use **Local warp** to move an outer edge by hand. |
| **Recolor without generation** | The shape, folds and surface detail already look right. | Mask the visible area, choose a color with the palette, hex value or eyedropper, and adjust **Recolor strength**. Choose **Run**. The recolor preserves local lightness variations and works without a prompt or seed. |
| **Add an object beyond the silhouette** | A bow, ribbon or accessory needs to extend into the transparent canvas. | **0.95**. Paint one connected red region that includes the visible attachment point and enough transparent space for the new object. Describe the object. BiRefNet helps cut it out after generation. |

SDXL modes require a nonempty positive prompt. Manual brushes work without one. In the starter graph the prompt assistant supplies both prompt fields to the processing node. Edit them in the assistant.

<a id="masks"></a>

## 4. The brush editor, masks and smart selection

Select the tool on the **left**. Choose the brush action, stroke shape and parameters **above the image**. The editor remembers the brush size and shape for individual tools. **Open brush editor** in the settings node and the equivalent button in the source node open the same image.

| Tool | What to mark |
|---|---|
| **Edit mask** | Paint the part the model may change in red. Leave a small margin for blending. Visible source pixels outside the selection are preserved during generation. |
| **Protection mask** | Paint details in green to keep them intact even inside the red mask. Protect a buckle, for example, when replacing the surrounding strap. |
| **Local generation strength** | Paint inside the red mask to retain more of the source in specific places. **0** protects the area, **1** allows the full strength of the current mode. Saving a strength map enables Differential Diffusion. |
| **Fold or seam guide** | Draw a thin blue line where the fold or seam should run. Paint a red edit mask wide enough for the material, highlight and shadow on either side of the line. |
| **Generation reference** | Select the material or appearance to use through IP-Adapter. Section 8 covers taking a sample from part of an external image. |
| **Smart selection** | SAM proposes a region based on your clicks. Choose the target layer, refine the selection and apply the yellow preview. |

Recolor mode shows tools suited to recoloring. Fold guides and local strength maps belong to the active generation mode. Check which marks are active after switching modes.

**Use SAM to select a sleeve.** Choose **Edit mask → Smart selection**. Click **Include (+)** and place a point on the sleeve. Use **Exclude (−)** to mark an adjacent forearm if the selection spills onto it. Choose **Limit with box** to restrict the search, then **Find region**. Pick the best candidate, adjust the selection feathering and apply the preview to the indicated layer. The points guide SAM. Applying the result writes the selection. SAM runs on the CPU, so the first search can take a few seconds.

**Erase part of a mask.** **Eraser → Current layer** removes marks from the active layer. **Eraser → All masks** clears the edit mask, protection, guide and local strength under the stroke for the current mode. To cut pixels out of the actual image, choose **Erase to transparent**.

**Clear all masks** clears selections over the whole image, including current dodge, burn and sampled-retouch strokes. It keeps applied contour and alpha edits, paint on transparency, edge retouch and the chosen reference. **Ctrl+Z** undoes a clear. To keep a manual retouch as the starting image for another pass, choose **Save edits** and then **Continue editing** before drawing a fresh mask.

<a id="strokes"></a>

## 5. Seven stroke shapes

| Stroke | How to draw it |
|---|---|
| **Freehand** | Hold the left mouse button and paint. Use it to cover spots or quickly block out a mask. |
| **Stabilized** | Trace the edge with the mouse. Higher stabilization smooths hand jitter and increases the distance the brush trails behind the pointer. |
| **Line** | Press at the start and release at the end. Useful for a straight hem or a hard-edged shadow. |
| **Circular arc** | Place two endpoints and drag the line between them. The whole segment bends into an arc, as on the rim of a round object. |
| **Oval arc** | Place two endpoints. Pull near the middle for a symmetric curve or closer to one end to move the crest. Try it on a curved cuff. |
| **Point curve** | Place anchor points, then pull between them in one or more places. **Bend width** sets how much of the line responds to each pull. Use it to make an S-shaped seam. |
| **Smooth contour** | Draw a rough path along a boundary or mark two points. **Snap to edge** follows a nearby change in color, texture or alpha. **Snap inside mask** restricts that search to the red edit mask. Adjust **Offset, px** to move the stroke to either side of the boundary. |

For an arc or an editable curve, choose **Apply stroke** when the path looks right. To shade a seam, use a narrow shadow on one side and a lighter stroke on the other. If snapping picks up a nearby detail, narrow the red mask and try **Snap inside mask**.

**Move around the image.** Scroll to zoom at the pointer. Hold the middle mouse button and drag to pan. **Ctrl+Z** undoes the last stroke or edit. While building a curve you can remove a selected point or reset the draft. Switch between checkerboard, white, black, gray and bright pink to inspect transparency. Black helps reveal light halos, white helps reveal dark ones. ComfyUI also has an **Inpaint → Canvas** setting called **Protect nodes from Delete and Backspace**, enabled by default.

<a id="manual"></a>

## 6. Manual retouch, transparency and the silhouette

For a manual-only pass, start with an empty red edit mask. Choose a tool, make a stroke and choose **Save edits**. The result node immediately displays the updated PNG. If an old red selection remains, clear just the edit mask so the manual layers you want to keep stay in place.

### Dodge and burn

**Dodge** lightens and **Burn** darkens. Try **0.15–0.25 EV** for a subtle change. At full coverage, **1 EV** doubles or halves the linear light level. For a fine highlight on a silhouette, let the soft rim of the brush overlap the subject. The brush center can sit over transparency.

- Enable **Build up strokes** to add each completed stroke to the previous ones. Two intersecting strokes have a stronger effect at the crossing. With buildup off, the layer strength limits repeated coverage of the same area.
- **Full strength through** controls the fade along the stroke. At **60%**, the first 60% uses the selected strength and the remaining 40% fades smoothly to zero. At **100%** the strength stays constant. Start at the end where the highlight or shadow should be strongest.
- **Show stroke mask** reveals where you have painted. Turn it off to judge tone. **Refresh preview** recalculates the manual edits already applied. Apply an editable arc before judging its effect.

### Heal from sample

Choose **1. Sample a clean area**, or **Alt+click** good texture, then brush over the defect. The crosshair marks the source. **Transfer texture, retain color** works well on skin or cloth with a lighting gradient. **Clone color and texture** also transfers the donor's tone. Lower the retouch intensity if the patch stands out.

You can sample directly at an edge. Partially transparent source pixels contribute in proportion to their opacity, and empty pixels are skipped. If little texture transfers as you drag, check where the brush is sampling. **Clear sampling point** removes the crosshair. Choosing a new donor for another stroke replaces this tool's earlier healing strokes in the current edit. For two independent patches, save the first and continue editing from its result.

### Choose an alpha tool

| Task | Tool and action |
|---|---|
| Remove fabric sticking out past the silhouette | Use **Erase to transparent** for a small remnant or **Edit contour A–B** for a longer edge. |
| Recover an area you erased accidentally | **Restore original alpha** restores the opacity of the current source. After **Continue editing**, that source is the accepted result of the previous pass. |
| Fix a translucent patch inside the subject | Use **Make opaque**. For a completely empty hole, switch to **Paint on transparency**. |
| Restore opacity close to the rim | **Remove edge translucency** increases opacity inward while retaining the outer antialiased row. Inspect the edge on black and white first. Increasing opacity can reveal stray colors in nearly transparent pixels. Correct the color with sampled retouch or trim a surplus halo. |
| Fill an empty area before generating over it | Use **Paint on transparency → Color** or **Nearby texture**. Sample a color or a patch of texture and paint the gap. This layer sits behind existing pixels. Mask the patch in red and run soft retouch to blend it in. |
| Make a trimmed edge look like a rounded surface | Use **Edge retouch** and brush along the rim with the stroke straddling the surface and transparency. The tool estimates color and shading from the neighboring surface. Repeated strokes build up. **Smooth alpha** also softens the alpha edge inward. |

### Edit contour A–B and Local warp

**Reshape a length of edge.** In **Edit contour A–B**, place A and B on the same boundary, on either side of a protrusion. The white line is the detected PNG boundary, yellow shows the selected segment and blue previews the new edge. Pull any part of the line inward. Both endpoints stay pinned. Use the separate anchor button to add a fixed point or **Other segment** to take the other route around the same outline.

Use **Smooth segment** for bumps and **Straighten A–B** for a straight trim. **Smoothing radius, px** sets the size of irregularities to smooth. **Bend width, %** sets how much of the segment moves when dragged. If the white line follows a faint halo, raise **Alpha threshold, %** before placing A. **Show small and faint boundaries** reveals separate pieces of alpha. Choose **Apply contour** to commit. If a straight line would cross transparency or cut into another edge, review the inward-curved suggestion or divide the edit into two shorter segments.

**Warp an area with a brush.** **Local warp** has four modes:

- **Warp interior · lock silhouette** moves surface detail within the figure. Try it on a wrinkle or part of a pattern.
- **Pull edge inward** brings a protruding edge and its surface inward together.
- **Move alpha edge inward** trims opacity while the surface texture stays in place.
- **Free edge warp** moves the edge and its texture outward or back inward. Use it to pull a dent into empty space.

Set warp strength and diameter independently. The diameter slider covers **1–100 px** for fine control. The numeric field accepts up to **1024 px**. Several short pulls are easier to judge on a small protrusion.

<a id="settings"></a>

## 7. Generation settings

| Setting | What it controls | How to tune it |
|---|---|---|
| **Denoise strength** | How much SDXL rebuilds the masked area. | Lower it if useful texture disappears. If the old object still shows through, check mask coverage, then increase strength or try **Remove and reconstruct**. |
| **Seed / Seed after generation** | The initial noise and how it changes between runs. | Fix the seed to compare settings. Use **randomize** or **Random seed** to try another interpretation. |
| **Crop resolution** | The working resolution of the selected crop, **768** or **1024**. | 768 is faster and uses less VRAM. Try 1024 for fine weave, strands and seams. The saved image retains the source dimensions. |
| **Steps** | The number of sampling steps in the main pass. | **24–28** is a reasonable starting range. More steps take longer. Check the mask and strength first if a result looks wrong. |
| **CFG** | How strongly the text prompt guides generation. | Start near **5**. If details look harsh or exaggerated, try a lower CFG with the same seed. |
| **Texture refinement** | A second local pass after generation. | Adds **12 steps** at **0.10** strength for soft retouch or **0.18** for other generative modes. Compare on cloth or skin. The output dimensions stay the same. |
| **Feather, px** | How far the generated result blends inward from the red mask boundary. | Start here if there is a visible seam around a patch. Give the mask a small margin. **0** uses the mode's default. |
| **Context, px** | The minimum size of the source region around the selection that the model sees. | If a patch has the wrong tone in its center, include neighboring material under the same light. **0** uses the mode default. Large selections automatically enlarge the crop. |
| **Differential Diffusion** | Varies generation strength within a selection. | Use it for a gradual transition from reconstruction to delicate retouch. The **Local generation strength** map works inside the red mask. |
| **Edge protection** | Softens generation near the selection boundary when Differential Diffusion is enabled. | Increase it if the model distorts the perimeter. If an edge defect consistently survives, compare a pass with less protection. |

**Context 768 and crop resolution 1024 work together.** Context determines how much of the original image is included. Crop resolution determines how many pixels the model works with. As you fit more source area into a given working resolution, a tiny feature occupies fewer working pixels.

**One or three variants.** Open **Compare results**. With **1** variant you get one result at the selected settings. With **3**, each candidate starts from the same source. **Different seeds** uses the original seed, seed + 1009 and seed + 2018 at the same strength. **Different strengths** holds the seed fixed. For example, **0.50** strength with a **0.08** spread gives **0.42 / 0.50 / 0.58**. Click the thumbnail you want before saving or continuing. Manual edits and recoloring produce one result.

<a id="guides"></a>

## 8. Guide the model with a line, an image or a prompt

### Draw a fold or seam with ControlNet

1. Choose a generation mode suited to the change. For a subtle fold on a surface that already looks right, start with soft retouch.
2. Paint a red **Edit mask** wide enough for the fold and its surrounding light and shadow.
3. Switch to **Fold or seam guide** and draw the fold line. For an arc, choose **Apply stroke**, then **Save edits**.
4. Check **Enhancements → ControlNet guide**. **Drawing only** uses your line. **Drawing and context** adds detected edges outside the processed area. Try **0.65** guide strength for a first comparison.
5. Describe the material and construction. Try `single curved seam in blue leather, shallow recessed stitching, matching light`. For a fold without stitching, use `soft rounded fold, subtle contact shadow, matching texture`.

### Take texture from another image with IP-Adapter

1. Choose **Generation reference** in the editor or **Choose or replace reference** in the settings node.
2. Take a sample from the current image or upload an external reference. Work on an external image in the **Reference** panel on the right. Expand it for more room, scroll to zoom and middle-drag to pan.
3. Choose **Square** for an even patch. For an irregular area, use **Lasso**, outline the material and choose **Close outline**. **Whole image** resets the crop. Check the sample thumbnail.
4. On the **main image**, paint the destination red and choose **Save edits**. In **Enhancements → IP-Adapter reference**, check the selected source. Start at **0.35** reference strength and specify the desired color and material in the positive prompt.

For white fur, select just the fur in a rabbit photo, leaving out the eye, ear and background. On the character, mask only the patch that should become white. Try `short white fur, fine soft fibers, matching directional light`. The reference guides the generated appearance. For a direct copy of local pixels, use **Heal from sample → Clone color and texture**.

The source choices are **Off**, **Source crop** (the current working region), **Brush sample** (the area around the sample point), **Uploaded reference**, and **Connected image** (the `reference_image` input). A reference uploaded in the editor is stored in ComfyUI's temporary files. Upload it again if it is unavailable after a restart.

### Write a prompt or use Grok

Describe **what you want to see after the edit**. To remove a label, try `uninterrupted dark wool, fine woven fibers, matching light`. A negative prompt could include `label, printed letters, adhesive residue`. Material, color and lighting generally give enough direction for a local repair.

The public prompt assistant accepts English and Russian. **Prepare prompts** sends the edit description and the selected mode to Grok. Edit the returned positive and negative prompts if needed. **Run** uses the prompt fields already in the node. To use your own API key, follow the [Grok setup instructions](README.md#connect-your-own-grok-api-key).

<a id="results"></a>

## 9. Save, continue and troubleshoot

The comparison shows the source on the left and the result on the right. Choose **Save result** in the result node to export at full source resolution. You can change the filename prefix in that node. Intermediate versions are stored in `temp` and can disappear when ComfyUI restarts. **Continue editing** opens the selected result in the first node with a fresh, empty mask. For example, remove an object, continue from the result to even out its tone, then save the finished PNG.

| What you see | What to try first |
|---|---|
| A JPEG still has its background and you want to fix only a cheek. | Select the JPEG in **image**, paint the blemish red and run soft retouch. The rest of the photograph can stay as it is. |
| A patch blends well at its edge but the center is a different color. | Fix the seed. Lower denoise strength and give **Context** enough nearby surface under the same light. Check color wording in the prompt and try turning off a strong external reference. Feathering has little effect on the center. |
| A defect persists in the last few pixels against transparency. | Paint the red mask across the rim. In **Soft skin or surface retouch**, enable **Retouch up to the PNG edge**. Remove green protection from the defect for this pass. The PNG keeps its alpha. |
| The outline is correct after trimming but the cut looks flat. | Start with **Edge retouch**. To regenerate the surface itself, follow with a separate soft retouch pass up to the edge. Inspect against both white and black. |
| A bow needs to extend beyond a dress. | For a cutout sprite, choose **Add an object beyond the silhouette** and include the attachment point and transparent space in the same mask. On a photo with a visible background, choose **Replace clothing or an object** and mask the background pixels the bow should cover. |
| A colored guide is visible but generation does nothing. | Check the red mask, apply any draft curve, save the edits and choose **Run**. The blue guide, purple strength map and reference influence what happens inside the selection. |
| A later pass looks worse than an earlier one. | If you are still choosing between variants, click the earlier thumbnail. To keep a good intermediate version before starting another pass, choose **Save result**. Fix the seed when comparing a single setting. |

**Which model does what?** The main SDXL checkpoint sets the visual style. Fooocus handles generative reconstruction and replacement. LaMa fills the region before object removal and small-detail retouch. ControlNet follows the drawing. IP-Adapter and CLIP Vision use the appearance reference. SAM finds selections, and BiRefNet separates the new object extending beyond a silhouette. See the [model file list](MODELS.md) for filenames and paths.

For custom graphs, the package also registers `PNGV4AlphaPrepare` to clean hidden colors and prepare a working copy on gray, `PNGV4AlphaRestore` to restore source transparency after editing the working copy, and `PNGV4AlphaInpaintFinish` to composite the edited result using the mask. The starter workflow handles these operations through its main processing node.

To switch the interface language, use **Inpaint · Язык / Language → Русский / English** in the first node. Save open edits and the workflow, then refresh the tab. [Inpaint Universal repository](https://github.com/bikepointsite/ComfyUI-Inpaint-Universal)
