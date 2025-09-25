/* web/utils.js */
/* Basic helpers + i18n + validation + storage */

export const $  = (sel, root=document) => root.querySelector(sel);
export const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

export const storage = {
  get(key, def=null){
    try{ const v = localStorage.getItem(key); return v==null ? def : JSON.parse(v); }catch{ return def }
  },
  set(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch{} },
  del(key){ try{ localStorage.removeItem(key); }catch{} }
};

/* ---------- i18n ---------- */
export const i18n = {
  lang: storage.get('lang','ru'),
  dict: {},
  async load(lang){
    try{
      const res = await fetch(`./i18n/${lang}.json`, { cache: 'no-store' });
      if(!res.ok) throw new Error(`i18n ${lang} ${res.status}`);
      i18n.dict = await res.json();
      i18n.lang = lang;
      storage.set('lang', lang);
    }catch{
      if(lang !== 'ru'){
        // фолбэк на RU
        try{
          const resRU = await fetch(`./i18n/ru.json`, { cache: 'no-store' });
          i18n.dict = resRU.ok ? await resRU.json() : {};
          i18n.lang = 'ru';
          storage.set('lang','ru');
        }catch{ i18n.dict = {}; i18n.lang = 'ru'; }
      } else {
        i18n.dict = {};
      }
    }
    // применяем тексты
    $$('[data-i18n]').forEach(el=>{
      const key = el.getAttribute('data-i18n');
      if(key && i18n.dict[key]) el.textContent = i18n.dict[key];
    });
  }
};

/* ---------- Validation ---------- */
export const isLatinName  = (s) => /^[A-Za-z\s\-']{2,}$/.test(String(s||'').trim());
export const isDDMMYYYY   = (s) => /^([0-2]\d|3[01])\.(0\d|1[0-2])\.(19|20)\d{2}$/.test(String(s||'').trim());

/* ---------- Name/diacritics utilities (в унисон с сервером) ---------- */
export function stripDiacritics(s=''){
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}
export function normalizeName(s=''){
  return stripDiacritics(String(s||'').toLowerCase())
    .replace(/\s+/g,' ')
    .trim();
}

/* ---------- Date utils (совместимы с сервером) ---------- */
export function parsePLDate(s){
  if(!s || typeof s!=='string') return null;
  const t = s.trim();
  let m = t.match(/^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/);
  if(m){
    const [_,Y,Mo,D] = m;
    const d = new Date(Number(Y), Number(Mo)-1, Number(D));
    return isNaN(d) ? null : d;
  }
  m = t.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/);
  if(m){
    const [_,D,Mo,Y] = m;
    const d = new Date(Number(Y), Number(Mo)-1, Number(D));
    return isNaN(d) ? null : d;
  }
  return null;
}
export function formatDateISO(d){
  if(!(d instanceof Date) || isNaN(d)) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

/* ---------- Amount utils (совместимы с сервером) ---------- */
export function parseAmountToNumber(s=''){
  if(typeof s !== 'string') s = String(s ?? '');
  let t = s.trim();
  let negative = /^\(.*\)$/.test(t);
  t = t.replace(/^\((.*)\)$/, '$1');
  t = t.replace(/[–—−]/g, '-'); // разные минусы
  t = t.replace(/\s+/g,'').replace(/pln|zł|zl/ig,'');
  t = t.replace(',', '.');
  const m = t.match(/^-?\d+(\.\d+)?/);
  let num = m ? parseFloat(m[0]) : NaN;
  if(isNaN(num)) return null;
  if(negative) num = -Math.abs(num);
  return Math.abs(num); // как в проверке opłata skarbowa
}

/* ---------- Decision tree (very simplified M1) ---------- */
export function decidePath(q){
  // q: questionnaire object
  // statuses: pesel_ukr, asylum, karta_czasowa, student, no_status
  if (q.status === 'student') return 'pobyt_study';
  if (q.status === 'no_status') return 'regularize';
  if (q.status === 'pesel_ukr') return 'pesel_support';
  if (q.status === 'asylum') return 'asylum_support';
  if (q.status === 'karta_czasowa') return 'pobyt_support';
  return 'regularize';
}

/* ---------- Checklist presets (M1 mock) ---------- */
export const CHECKLISTS = {
  pobyt_study: [
    {slug:'student-zaswiadczenie', i18n:'item.student_zaswiadczenie'},
    {slug:'photo-fee-wniosek', i18n:'item.photo_fee_wniosek'},
    {slug:'visit-biometrics', i18n:'item.visit_biometrics'}
  ],
  regularize: [
    {slug:'choose-basis', i18n:'item.choose_basis'},
    {slug:'collect-docs', i18n:'item.collect_docs'},
    {slug:'submit-pobyt', i18n:'item.submit_pobyt'}
  ],
  pesel_support: [
    {slug:'pesel-rights', i18n:'item.pesel_rights'},
    {slug:'work-insurance', i18n:'item.work_insurance'},
    {slug:'address', i18n:'item.address'}
  ],
  asylum_support: [
    {slug:'asylum-brief', i18n:'item.asylum_brief'},
    {slug:'parallel-options', i18n:'item.parallel_options'}
  ],
  pobyt_support: [
    {slug:'obligations', i18n:'item.obligations'},
    {slug:'employer-change', i18n:'item.employer_change'}
  ]
};

/* ---------- Language UI hookup ---------- */
export async function initLangSwitcher(){
  const current = storage.get('lang','ru');
  $$('.lang button').forEach(b=>{
    b.classList.toggle('active', b.dataset.lang===current);
    b.onclick = async ()=>{
      $$('.lang button').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      await i18n.load(b.dataset.lang);
    };
  });
  // подгружаем словарь при инициализации
  await i18n.load(current);
}

/* ---------- Telegram Back button helper ---------- */
export function enableBackButton(){
  if (!window.Telegram?.WebApp) return;
  const tg = window.Telegram.WebApp;
  tg.BackButton.show();
  tg.onEvent('backButtonClicked', ()=> history.back());
}

/* ---------- Simple progress utility ---------- */
export function computeProgress(items){
  const done = items.filter(x=>x.done).length;
  return Math.round((done / Math.max(items.length,1)) * 100);
}

/* ---------- Misc ---------- */
export function debounce(fn, wait=250){
  let t=null;
  return (...args)=>{
    clearTimeout(t);
    t = setTimeout(()=>fn(...args), wait);
  };
}
