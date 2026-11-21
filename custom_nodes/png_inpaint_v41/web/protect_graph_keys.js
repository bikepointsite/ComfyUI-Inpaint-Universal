import { t as inpaintText } from '/extensions/png_inpaint_v4/language.js';
import { app } from "/scripts/app.js";

const settingId = "Inpaint.Graph.ProtectDelete";

function protectGraphSelection(event) {
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;

    const canvas = app.canvas?.canvas;
    if (!canvas || !app.ui.settings.getSettingValue(settingId, true)) return;
    const path = event.composedPath();
    if (path.some(el => el.isContentEditable || el.matches?.(
        'input, textarea, select, [role="textbox"], dialog, [role="dialog"], [role="menu"]'
    ))) return;

    const graph = canvas.closest("#graph-canvas-container");
    const target = path[0];
    // A click beside a widget can leave focus on the document instead of the canvas.
    if (!path.includes(canvas) && !(graph && path.includes(graph))
        && target !== document.body && target !== document.documentElement && target !== document) return;
    event.preventDefault();
    event.stopImmediatePropagation();
}

app.registerExtension({
    name: "PNGInpaintV41.ProtectGraphDelete",
    settings: [{
        id: settingId,
        category: ["Inpaint", inpaintText("Холст"), "ProtectDelete"],
        name: inpaintText("Защитить ноды от Delete и Backspace"),
        type: "boolean",
        defaultValue: true,
    }],
    setup() {
        // LiteGraph handles these keys even without a configured shortcut.
        window.addEventListener("keydown", protectGraphSelection, true);
        window.addEventListener("keyup", protectGraphSelection, true);
    },
});
