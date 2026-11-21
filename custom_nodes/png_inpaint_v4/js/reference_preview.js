import { t as inpaintText } from './language.js';
// Comfy's annotated file names need the same /view parameters as node previews.
export function referenceLocation(file) {
    const normalized = String(file || '').replace(/\\/g, '/');
    const match = normalized.match(/ \[(input|output|temp)\]$/);
    const path = match ? normalized.slice(0, match.index) : normalized;
    const split = path.lastIndexOf('/');
    return {filename: path.slice(split + 1), subfolder: path.slice(0, Math.max(0, split)), type: match?.[1] || 'input'};
}

export function referenceSource(state, mode) {
    if (mode === 'Донор из кисти' && state.reference_donor) return 'crop';
    if (mode === 'Загруженный образец' && state.reference_file) return 'file';
    return state.reference_source || (state.reference_file ? 'file' : state.reference_donor ? 'crop' : '');
}

export function createReferencePreview(parent, apiURL, {compact = false} = {}) {
    const root = document.createElement('div');
    root.setAttribute('aria-label', inpaintText("Загруженная картинка образца"));
    root.style.cssText = 'display:none;min-width:0;min-height:0;gap:8px;padding:10px;border:1px solid #688495;border-radius:6px;background:#303a42;box-sizing:border-box;flex-direction:column';
    const title = document.createElement('strong'); title.textContent = inpaintText("Картинка образца");
    const frame = document.createElement('div');
    frame.style.cssText = `position:relative;min-height:0;${compact ? 'height:110px' : 'flex:1'};background:repeating-conic-gradient(#777 0% 25%,#999 0% 50%) 0/20px 20px;border-radius:4px`;
    const name = document.createElement('div'); name.style.cssText = 'overflow-wrap:anywhere;font-size:12px';
    const status = document.createElement('div'); status.setAttribute('role', 'status'); status.style.cssText = 'font-size:12px;line-height:1.4';
    root.append(title, frame, name, status); parent.append(root);
    let current = '', image = null, generation = 0, state = 'empty', message = '';
    const showStatus = () => {status.textContent = state === 'loading' ? inpaintText("Загружаю предпросмотр…") : state === 'error' ? inpaintText("Не удалось открыть образец. Загрузите картинку заново.") : message;};
    return {
        root,
        update(file, text = '') {
            message = text;
            root.style.display = file ? 'flex' : 'none';
            if (current === file) {showStatus(); return;}
            current = file; const revision = ++generation;
            frame.replaceChildren(); image = null; name.textContent = ''; state = 'empty';
            if (!file) {showStatus(); return;}
            const location = referenceLocation(file); name.textContent = location.filename;
            state = 'loading'; showStatus();
            const next = document.createElement('img'); image = next;
            next.alt = inpaintText("Образец: ") + location.filename;
            next.style.cssText = 'display:none;width:100%;height:100%;object-fit:contain;position:absolute;inset:0';
            next.onload = () => {if (revision !== generation) return; state = 'ready'; next.style.display = 'block'; showStatus();};
            next.onerror = () => {if (revision !== generation) return; state = 'error'; next.style.display = 'none'; showStatus();};
            frame.append(next);
            next.src = apiURL('/view?' + new URLSearchParams(location));
        },
        dispose() {generation++; if (image) {image.onload = image.onerror = null;} frame.replaceChildren();}
    };
}
