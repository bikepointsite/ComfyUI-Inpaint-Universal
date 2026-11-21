import { t as inpaintText, language } from './language.js';
import { api } from '/scripts/api.js';
import { DEFAULT_STRENGTH, modeIndex, sourceFor, value, colorControl } from './editor_ui.js';
import { openMaskEditor } from './mask_editor.js';
import { createReferencePreview, referenceLocation } from './reference_preview.js';

const labels = {
    mode: inpaintText("Режим"), prompt: inpaintText("Что должно получиться"), negative: inpaintText("Нежелательные детали"),
    strength: inpaintText("Сила изменения"), retouch_to_edge: inpaintText("Ретушировать до края PNG"), seed: 'Seed', control_after_generate: inpaintText("Seed после запуска"),
    resolution: inpaintText("Размер рабочего фрагмента"), steps: inpaintText("Шаги"), cfg: 'CFG',
    detail_pass: inpaintText("Доводка текстуры"), feather_pixels: inpaintText("Переход, px (0 = авто)"),
    context_pixels: inpaintText("Окружение, px (0 = авто)"), width_percent: inpaintText("Ширина области, %"),
    height_percent: inpaintText("Высота области, %"), differential: 'Differential Diffusion',
    edge_gentleness: inpaintText("Бережность у границы"), guide_control: inpaintText("Направляющая ControlNet"),
    guide_weight: inpaintText("Влияние рисунка"), reference_mode: inpaintText("Референс IP-Adapter"),
    reference_weight: inpaintText("Влияние референса"), variants: inpaintText("Вариантов за запуск"),
    variant_strategy: inpaintText("Как сравнивать"), variant_spread: inpaintText("Разница силы вариантов"),
    color_strength: inpaintText("Сила перекраски"),
};
const tips = {
    strength: inpaintText("Больше — сильнее перерисовка. При смене режима подставляется его начальное значение."),
    cfg: inpaintText("Влияние промпта. Начните с 5."), steps: inpaintText("Число шагов генерации. Обычно достаточно 24–28."),
    differential: inpaintText("Учитывает плавные переходы маски и нарисованную под кистью силу генерации."),
    edge_gentleness: inpaintText("Увеличьте для более мягкого перехода у границы маски."),
    guide_control: inpaintText("Для складки или шва нарисуйте линию в выделении. Контекст учитывает и соседние формы."),
    guide_weight: inpaintText("Больше — сильнее привязка к рисунку. Начните с 0.65."),
    reference_mode: inpaintText("IP-Adapter переносит характер материала и внешний вид выбранного образца."),
    reference_weight: inpaintText("Больше — сильнее сходство с образцом. Начните с 0.35."),
    variant_spread: inpaintText("При силе 0.50 и разнице 0.08 получатся варианты 0.42, 0.50 и 0.58."),
    color_strength: inpaintText("0 сохраняет исходный цвет. При 1 перекраска действует в полную силу."),
};
const modeDefaults = {
    detail_pass: true, feather_pixels: 0, context_pixels: 0, width_percent: 100, height_percent: 100,
    guide_control: 'Выкл', guide_weight: .65, reference_mode: 'Выкл', reference_weight: .35,
    differential: true, edge_gentleness: .5, retouch_to_edge: false,
};
const modeHints = [
    inpaintText("Закрасьте мелкую деталь и опишите поверхность на её месте."),
    inpaintText("Закрасьте предмет с небольшим запасом и опишите, что должно остаться."),
    inpaintText("Выделите место под новую вещь и опишите её."),
    inpaintText("Выделите область и задайте её ширину или высоту. 100% соответствует исходному размеру."),
    inpaintText("Закрасьте область и выберите цвет."),
    inpaintText("Закрасьте дефект поверхности. Важные детали можно защитить кистью."),
    inpaintText("Красной кистью выделите место крепления и место для предмета за краем PNG. Опишите предмет. Его контур будет вырезан автоматически."),
];

export function installModePanel(node) {
    // Comfy workflows store widget values by position. Keep that file format
    // independent of the order in which the settings appear on the canvas.
    const original = [...node.widgets];
    const widgets = new Map(original.map(w => [w.name, w]));
    const get = name => widgets.get(name)?.value;
    const set = (name, v) => { if (widgets.has(name)) widgets.get(name).value = v; };
    for (const w of original) {
        if (labels[w.name]) w.label = labels[w.name];
        if (tips[w.name]) w.tooltip = tips[w.name];
    }
    const modeWidget = widgets.get('mode');
    const modes = [...modeWidget.options.values];
    const priority = ['Удалить и восстановить', 'Мягкая ретушь кожи / поверхности'];
    const rank = mode => priority.includes(mode) ? priority.indexOf(mode) : modeIndex(mode) === 4 ? 3 : 2;
    modeWidget.options = {...modeWidget.options, values: modes.sort((a, b) => rank(a) - rank(b))};
    const seedControl = widgets.get('control_after_generate');
    if (seedControl) seedControl.options = {...seedControl.options, canvasOnly: false};

    function button(name, label, action) {
        const w = node.addWidget('button', name, null, action, {serialize: false});
        w.serialize = false;
        w.label = label;
        widgets.set(name, w);
        return w;
    }
    function domRow(name, element, height) {
        const w = node.addDOMWidget(name, 'div', element, {
            serialize: false, hideOnZoom: false, getMinHeight: height, getMaxHeight: height,
        });
        w.serialize = false;
        w.computeSize = width => [width || 380, height()];
        widgets.set(name, w);
    }
    function openEditor(flag) {
        const source = sourceFor(node);
        if (!source) { alert(inpaintText("Подключите исходный PNG к этой ноде.")); return; }
        if (flag) source[flag] = true;
        openMaskEditor(source);
    }
    const hint = document.createElement('div');
    hint.className = 'png-inpaint-v4-mode-hint';
    hint.style.cssText = 'box-sizing:border-box;padding:2px 8px;color:var(--input-text);font:12px/16px sans-serif';
    // Vue retains the height of the old HTML panel when opening a saved graph.
    // Let visible rows determine the height, including after a mode switch.
    if (!document.getElementById('png-inpaint-v4-native-settings')) {
        const style = document.createElement('style');
        style.id = 'png-inpaint-v4-native-settings';
        style.textContent = `
            .lg-node:has(.png-inpaint-v4-mode-hint) { min-height: min-content; }
            .lg-node-widgets:has(.png-inpaint-v4-mode-hint) { align-content: start; }
        `;
        document.head.append(style);
    }
    domRow('v4_hint', hint, () => Math.max(20, hint.scrollHeight));
    button('v4_brush', inpaintText("Выделить область / ручная правка"), () => openEditor());
    function changeSetting(name, v) {
        set(name, v);
        widgets.get(name).callback?.(v);
        node.graph?.change?.();
    }
    button('v4_seed', inpaintText("Случайный seed"), () => changeSetting('seed', Math.floor(Math.random() * 2 ** 32)));
    let extrasOpen = false, variantsOpen = false;
    const extras = button('v4_extras', inpaintText("Усиления"), () => { extrasOpen = !extrasOpen; refresh(); });
    const variants = button('v4_variants', inpaintText("Сравнить варианты результата"), () => { variantsOpen = !variantsOpen; refresh(); });
    button('v4_reference', inpaintText("Выбрать / заменить образец"), () => openEditor('_v4PickReference'));
    const sample = document.createElement('div');
    const preview = createReferencePreview(sample, url => api.apiURL(url), {compact: true});
    domRow('v4_preview', sample, () => Math.max(180, preview.root.offsetHeight + 4));
    const palette = document.createElement('div');
    palette.style.cssText = 'box-sizing:border-box;padding:2px 8px';
    const colors = colorControl(palette, get('target_color'), v => changeSetting('target_color', v), () => openEditor('_v4PickColor'));
    domRow('v4_palette', palette, () => 40);
    const comparison = document.createElement('div');
    comparison.style.cssText = hint.style.cssText;
    domRow('v4_comparison', comparison, () => Math.max(20, comparison.scrollHeight));

    const order = [
        'mode', 'v4_hint', 'prompt', 'negative', 'strength', 'retouch_to_edge', 'width_percent', 'height_percent',
        'seed', 'control_after_generate', 'v4_seed', 'resolution', 'steps', 'cfg', 'detail_pass',
        'feather_pixels', 'context_pixels', 'v4_brush', 'v4_extras', 'differential', 'edge_gentleness',
        'guide_control', 'guide_weight', 'reference_mode', 'reference_weight', 'v4_reference',
        'v4_preview', 'v4_variants', 'variants', 'variant_strategy', 'variant_spread', 'v4_comparison',
        'v4_palette', 'color_strength',
    ];
    function reorder(names) {
        const indices = new Map(names.map((name, i) => [name, i]));
        node.widgets.sort((a,b) => (indices.get(a.name) ?? Infinity) - (indices.get(b.name) ?? Infinity));
    }
    // Keep existing workflow/API enum values. The English controls edit the
    // same native widgets so presets, references and old graphs keep working.
    const displayCombos = new Map();
    if (language === 'en') {
        for (const name of ['mode', 'guide_control', 'reference_mode', 'variant_strategy']) {
            const originalWidget = widgets.get(name);
            const labelsByValue = new Map(originalWidget.options.values.map(v => [v, inpaintText(v)]));
            const valuesByLabel = new Map([...labelsByValue].map(([v,label]) => [label,v]));
            const displayName = 'v4_display_' + name;
            const view = node.addWidget('combo', displayName, inpaintText(originalWidget.value), label => {
                if (valuesByLabel.has(label)) changeSetting(name, valuesByLabel.get(label));
            }, {values: [...valuesByLabel.keys()], serialize: false});
            view.serialize = false;
            view.label = labels[name];
            view.tooltip = tips[name];
            widgets.set(displayName, view);
            order.splice(order.indexOf(name), 0, displayName);
            displayCombos.set(name, displayName);
        }
    }
    const hidden = new Map();
    function show(name, visible) {
        const displayName = displayCombos.get(name);
        if (displayName) {
            widgets.get(displayName).value = inpaintText(get(name));
            show(displayName, visible);
            visible = false;
        }
        const w = widgets.get(name);
        if (!w || visible === !hidden.has(name)) return;
        if (visible) {
            const previous = hidden.get(name);
            w.computeSize = previous.computeSize;
            w.hidden = previous.hidden;
            w.options = {...w.options, hidden: previous.option};
            if (w.element) w.element.style.display = previous.display;
            hidden.delete(name);
        } else {
            hidden.set(name, {computeSize: w.computeSize, hidden: w.hidden, option: w.options?.hidden, display: w.element?.style.display});
            w.hidden = true;
            w.options = {...w.options, hidden: true};
            w.computeSize = () => [0, -4];
            if (w.element) w.element.style.display = 'none';
        }
    }

    let activeMode = get('mode'), autoStrength = !get('strength'), configuring = false;
    let lastPayload, state = {}, frame = 0, removed = false;
    function fit() {
        if (frame || removed) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            if (removed || node.flags?.collapsed) return;
            const height = node.computeSize()[1];
            if (height > 0) node.setSize([Math.max(430, node.size[0]), height]);
            node.setDirtyCanvas(true, true);
        });
    }
    function refresh() {
        if (configuring) return;
        const mode = get('mode'), i = modeIndex(mode), generation = i !== 4;
        if (activeMode !== mode) {
            const memory = node.properties.v4ModeSettings ??= {};
            memory[activeMode] = Object.fromEntries(Object.keys(modeDefaults).map(name => [name, get(name)]));
            for (const [name, v] of Object.entries({...modeDefaults, ...memory[mode]})) set(name, v);
            activeMode = mode;
            autoStrength = true;
        }
        if (autoStrength) {
            const geometryChanged = i === 3 && (get('width_percent') !== 100 || get('height_percent') !== 100);
            set('strength', geometryChanged ? .48 : DEFAULT_STRENGTH[i] ?? .28);
        }
        const source = sourceFor(node);
        const payload = value(source, 'mask_data');
        if (lastPayload !== payload) {
            lastPayload = payload;
            try { state = JSON.parse(payload || '{}') || {}; } catch { state = {}; }
        }
        const linked = socket => node.inputs?.some(input => input.name === socket && input.link != null);
        show('mode', true);
        const hints = [modeHints[i]];
        if (generation && linked('positive_prompt')) hints.push(inpaintText("Промпт подключён из помощника."));
        if (generation && extrasOpen) {
            if (get('guide_control') !== 'Выкл') hints.push(state.map_usage?.guide ? inpaintText("Линия ControlNet подключена.") : inpaintText("Для ControlNet нарисуйте линию."));
            if (state.map_usage?.strength && state.editor_mode === mode) hints.push(inpaintText("Локальная сила сохранена."));
            if (get('reference_mode') === 'Донор из кисти' && !state.reference_donor) hints.push(inpaintText("Выберите участок образца."));
            if (get('reference_mode') === 'Загруженный образец' && !state.reference_file) hints.push(inpaintText("Загрузите образец."));
        }
        hint.textContent = hints.filter(Boolean).join(' ');
        show('prompt', generation && !linked('positive_prompt'));
        show('negative', generation && !linked('negative_prompt'));
        show('retouch_to_edge', i === 5 && source?.properties?.inpaintBrushEditor === '4.1');
        for (const name of ['strength','seed','control_after_generate','v4_seed','resolution','steps','cfg','detail_pass','feather_pixels','context_pixels','v4_extras','v4_variants']) show(name, generation);
        for (const name of ['width_percent', 'height_percent']) show(name, i === 3);
        for (const name of ['differential','guide_control','reference_mode']) show(name, generation && extrasOpen);
        show('edge_gentleness', generation && extrasOpen && get('differential'));
        show('guide_weight', generation && extrasOpen && get('guide_control') !== 'Выкл');
        show('reference_weight', generation && extrasOpen && get('reference_mode') !== 'Выкл');
        show('v4_reference', generation && (extrasOpen || !!state.reference_file));
        const sampleName = state.reference_region ? inpaintText("Выбран фрагмент · ") + referenceLocation(state.reference_original_file).filename + '. ' : '';
        preview.update(state.reference_file || '', sampleName + (get('reference_mode') === 'Загруженный образец' ? inpaintText("Используется при генерации.") : inpaintText("Образец сохранён. Для применения выберите его в IP-Adapter.")));
        show('v4_preview', generation && !!state.reference_file);
        const compare = generation && variantsOpen, three = Number(get('variants')) === 3;
        const spread = get('variant_strategy') === 'Разная сила';
        show('variants', compare);
        show('variant_strategy', compare && three);
        show('variant_spread', compare && three && spread);
        show('v4_comparison', compare && three);
        comparison.textContent = spread ? inpaintText("Сила вариантов · ") + [-1,0,1].map(k => Math.min(1,Math.max(.05,get('strength') + k * get('variant_spread'))).toFixed(2)).join(' / ') : inpaintText("Seed вариантов · исходный, +1009, +2018.");
        for (const name of ['silhouette','target_color']) show(name, false);
        for (const name of ['v4_palette','color_strength']) show(name, !generation);
        if (!generation) colors.update(get('target_color'), false);
        extras.label = (extrasOpen ? '▾ ' : '▸ ') + inpaintText("Усиления");
        variants.label = (variantsOpen ? '▾ ' : '▸ ') + inpaintText("Сравнить варианты результата");
        node.setDirtyCanvas(true, true);
        fit();
    }
    for (const w of original) {
        const callback = w.callback;
        w.callback = function(...args) {
            const result = callback?.apply(this, args);
            if (!configuring && w.name === 'strength') autoStrength = !Number(w.value);
            refresh();
            return result;
        };
    }
    const configure = node.configure;
    node.configure = function(...args) {
        configuring = true;
        reorder(original.map(w => w.name));
        set('retouch_to_edge', false);
        try { return configure.apply(this, args); }
        finally {
            configuring = false;
            activeMode = get('mode');
            autoStrength = !get('strength');
            reorder(order);
            refresh();
        }
    };
    const serialize = node.onSerialize;
    node.onSerialize = function(info) {
        serialize?.call(this, info);
        // Native seed controls and every backend setting keep their legacy slots.
        // UI-only rows never enter a workflow or a generation prompt.
        info.widgets_values = original.filter(w => w.serialize !== false).map(w => w.name === 'strength' && autoStrength ? 0 : w.value);
    };
    const connections = node.onConnectionsChange;
    node.onConnectionsChange = function(...args) { connections?.apply(this, args); refresh(); };
    node._v4Refresh = refresh;
    node._v4SetMode = mode => changeSetting('mode', mode);
    const onRemoved = node.onRemoved;
    node.onRemoved = function(...args) {
        removed = true;
        cancelAnimationFrame(frame);
        preview.dispose();
        return onRemoved?.apply(this, args);
    };
    reorder(order);
    refresh();
}

