import english from './english.js';

const key = 'inpaint.portable.language';
function preferredLanguage() {
    try {
        const saved = localStorage.getItem(key);
        if (saved === 'en' || saved === 'ru') return saved;
    } catch { /* Read-only browser profile. */ }
    return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}
export const language = preferredLanguage();
try { document.cookie = 'inpaint_portable_ui=' + language + '; Path=/; SameSite=Strict'; } catch { /* Storage is optional. */ }
export function t(text) { return language === 'en' ? english[text] ?? text : text; }

export function addLanguageSelector(node) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 8px;flex-wrap:wrap;color:var(--input-text);font:12px sans-serif';
    row.append('Inpaint · Язык / Language ');
    const select = document.createElement('select');
    select.setAttribute('aria-label','Inpaint language');
    select.add(new Option('Русский','ru'));
    select.add(new Option('English','en'));
    select.value = language;
    const message = document.createElement('span');
    select.onchange = () => {
        try {
            localStorage.setItem(key,select.value);
            message.textContent = select.value === language ? '' : select.value === 'en' ?
                'Save your work, then refresh this tab (F5).' : 'Сохраните работу и обновите вкладку (F5).';
        } catch { select.value = language; message.textContent = 'Browser storage unavailable / Хранилище браузера недоступно'; }
    };
    row.append(select,message);
    const w = node.addDOMWidget('inpaint_ui_language','div',row,{serialize:false, getMinHeight:()=>message.textContent?48:30});
    w.serialize = false;
}

