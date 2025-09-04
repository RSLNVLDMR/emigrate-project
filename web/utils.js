/* Basic helpers + i18n + validation + storage */

export const $ = (sel, root=document) => root.querySelector(sel);
export const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

export const storage = {
  get(key, def=null){ try{ return JSON.parse(localStorage.getItem(key)) ?? def }catch{ return def } },
  set(key, val){ localStorage.setItem(key, JSON.stringify(val)) },
  del(key){ localStorage.removeItem(key) }
};

export const i18n = {
  lang: storage.get('lang','ru'),
  dict: {},
  async load(lang){
    const res = await fetch(`./i18n/${lang}.json`);
    i18n.dict = await res.json();
    i18n.lang = lang;
    storage.set('lang', lang);
    $$('[data-i18n]').forEach(el=>{
      const key = el.getAttribute('data-i18n');
      if(i18n.dict[key]) el.textContent = i18n.dict[key];
    });
  }
};

// Validation
export const isLatinName = (s) => /^[A-Za-z\s\-\']{2,}$/.test(String(s||'').trim());
export const isDDMMYYYY = (s) => /^([0-2]\d|3[01])\.(0\d|1[0-2])\.(19|20)\d{2}$/.test(String(s||'').trim());

// Decision tree (very simplified M1)
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

// Checklist presets (M1 mock)
export const CHECKLISTS = {
  pobyt_study: [
    {slug:'student-zaswiadczenie', title:'Zaświadczenie z uczelni'},
    {slug:'photo-fee-wniosek', title:'Фото, оплата, wniosek'},
    {slug:'visit-biometrics', title:'Визит и биометрия'}
  ],
  regularize: [
    {slug:'choose-basis', title:'Определить основание (работа/учёба/семья)'},
    {slug:'collect-docs', title:'Собрать документы по основанию'},
    {slug:'submit-pobyt', title:'Подача на pobyt czasowy'}
  ],
  pesel_support: [
    {slug:'pesel-rights', title:'Права и подтверждения по PESEL-UKR'},
    {slug:'work-insurance', title:'Работа и страховка'},
    {slug:'address', title:'Адрес/мелдунек'}
  ],
  asylum_support: [
    {slug:'asylum-brief', title:'Ход процедуры и права'},
    {slug:'parallel-options', title:'Параллельные опции (учёба/работа)'}
  ],
  pobyt_support: [
    {slug:'obligations', title:'Текущие обязанности и продление'},
    {slug:'employer-change', title:'Смена работодателя (если нужно)'}
  ]
};

// Language UI hookup
export function initLangSwitcher(){
  const current = storage.get('lang','ru');
  $$('.lang button').forEach(b=>{
    b.classList.toggle('active', b.dataset.lang===current);
    b.onclick = async ()=>{
      $$('.lang button').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      await i18n.load(b.dataset.lang);
    };
  });
}

// Telegram Back button helper
export function enableBackButton(){
  if (!window.Telegram?.WebApp) return;
  const tg = window.Telegram.WebApp;
  tg.BackButton.show();
  tg.onEvent('backButtonClicked', ()=> history.back());
}

// Simple progress utility
export function computeProgress(items){
  const done = items.filter(x=>x.done).length;
  return Math.round((done / Math.max(items.length,1)) * 100);
}
