// web/api/verify-document.js
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import formidable from 'formidable';
import OpenAI from 'openai';
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export const config = { runtime: 'nodejs', api: { bodyParser: false, sizeLimit: '35mb' } };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// === лимиты/константы ===
const MAX_FILES = 20;
const MAX_TOTAL_BYTES = 35 * 1024 * 1024; // суммарно на аплоад
const MAX_PDF_PAGES = 20;                 // читаем текст/рендерим не больше 20 стр
const MAX_RENDER_PAGES = 10;              // для визуал/подписей
const BATCH_PAYLOAD_BUDGET = 45 * 1024 * 1024; // ~45MB на один vision-запрос (запас к лимиту 50MB)

// === API-ключ ===
function envApiKey() {
  return (
    process.env.OPENAI_API_KEY ||
    process.env.OPEN_API_KEY ||
    process.env.OPEN_AI_KEY ||
    process.env.OPENAI_KEY ||
    process.env.OPENAI
  );
}
const openai = new OpenAI({ apiKey: envApiKey() });

// === pdfjs worker ===
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
).href;

// ===== helpers =====
function copyU8(view) {
  const src = view instanceof Uint8Array ? view : new Uint8Array(view);
  const out = new Uint8Array(src.byteLength);
  out.set(src);
  return out;
}
function toU8(x){
  if (!x) return new Uint8Array();
  if (Buffer.isBuffer(x)) return copyU8(x);
  if (x instanceof Uint8Array) return copyU8(x);
  if (x instanceof ArrayBuffer) return copyU8(new Uint8Array(x));
  return copyU8(new Uint8Array(x));
}

async function parseForm(req){
  const form = formidable({
    multiples: true,
    maxFileSize: MAX_TOTAL_BYTES, // per-file (чтобы один файл тоже не вылезал)
    uploadDir: '/tmp',
    keepExtensions: true
  });
  return new Promise((resolve,reject)=>{
    form.parse(req, (err, fields, files)=>{
      if(err) return reject(err);
      const list = [];
      const arr = Array.isArray(files.file) ? files.file : (files.file ? [files.file] : []);
      for(const f of arr){
        list.push({ filepath:f.filepath, originalFilename:f.originalFilename, mimetype:f.mimetype, size:f.size });
      }
      resolve({ fields, files:list });
    });
  });
}

function sumSize(files){ return files.reduce((a,f)=>a+(f.size||0),0); }
async function readTmp(fp){ const b = await fsp.readFile(fp); fsp.unlink(fp).catch(()=>{}); return b; }

// --- безопасный парс дат (PL-форматы) ---
function parsePLDate(s){
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
function daysBetween(a, b){
  const MS = 24*60*60*1000;
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.floor((da - db)/MS);
}

// --- суммы ---
function parseAmountToNumber(s=''){
  if(typeof s !== 'string') s = String(s ?? '');
  let t = s.trim();
  let negative = /^\(.*\)$/.test(t);
  t = t.replace(/^\((.*)\)$/, '$1');       // (440,00) → 440,00
  t = t.replace(/[–—−]/g, '-');            // разные «минусы»
  t = t.replace(/\s+/g,'').replace(/pln|zł|zl/ig,'');
  t = t.replace(',', '.');
  const m = t.match(/^-?\d+(\.\d+)?/);
  let num = m ? parseFloat(m[0]) : NaN;
  if(isNaN(num)) return null;
  if(negative) num = -Math.abs(num);
  return Math.abs(num);                    // считаем как модуль (платёж списанием)
}

function stripDiacritics(s=''){
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}

async function tryPdfParseText(buf){
  try{
    const mod = await import('pdf-parse');
    const pdfParse = mod.default || mod;
    const parsed = await pdfParse(buf);
    const t = (parsed.text || '').trim();
    return t && t.length>10 ? t : '';
  }catch{ return ''; }
}

async function pdfExtractTextViaPdfjs(u8, limit=MAX_PDF_PAGES){
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const pages = Math.min(doc.numPages, limit);
  let all = '';
  for(let i=1;i<=pages;i++){
    const page = await doc.getPage(i);
    const txt = await page.getTextContent();
    all += txt.items.map(it=>it.str).join('\n') + '\n';
  }
  return all.trim();
}

async function renderPdfPages(u8, maxPages=MAX_RENDER_PAGES, scale=2.0){
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  const out = [];
  for(let i=1;i<=pages;i++){
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push(canvas.toBuffer('image/png')); // исходники для предобработки
  }
  return { pngs: out, pages };
}

// — предобработка картинок для OCR —
async function preprocessForOCR(buf, { handwriting=false } = {}){
  let img = sharp(buf).rotate();
  if (handwriting) {
    img = img
      .grayscale()
      .normalise()
      .gamma(1.2)
      .threshold(180) // мягкий порог
      .sharpen();
    // Для рукописи оставляем PNG (сохраняет штрихи лучше)
    return await img.png().toBuffer();
  } else {
    // Для печатного — JPEG с ограничением ширины
    return await img
      .resize({ width: 2200, withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
  }
}

// — тайлирование страницы 2×2 с ~10% перекрытием —
async function tileImage(buf){
  const meta = await sharp(buf).metadata();
  const W = meta.width || 1, H = meta.height || 1;
  const ox = Math.floor(W * 0.10), oy = Math.floor(H * 0.10);
  const wHalf = Math.floor(W/2), hHalf = Math.floor(H/2);
  const tiles = [
    { left: 0,           top: 0,           width: wHalf+ox, height: hHalf+oy },                  // TL
    { left: wHalf-ox,    top: 0,           width: W-(wHalf-ox), height: hHalf+oy },              // TR
    { left: 0,           top: hHalf-oy,    width: wHalf+ox, height: H-(hHalf-oy) },              // BL
    { left: wHalf-ox,    top: hHalf-oy,    width: W-(wHalf-ox), height: H-(hHalf-oy) }           // BR
  ];
  const outs = [];
  for(const t of tiles){
    const b = await sharp(buf).extract(t).toBuffer();
    outs.push(b);
  }
  return outs;
}

// — оценка «веса» батча в запросе Vision (по двоичному размеру JPEG/PNG) —
function batchFitsLimit(buffers){
  // Примерная оценка base64-размера: ~1.37× исходного (4/3 + заголовки)
  const approx = buffers.reduce((a,b)=>a + Math.ceil(b.length * 1.37), 0);
  return approx < BATCH_PAYLOAD_BUDGET;
}

// — OCR батчем картинок (одним запросом), с «устойчивым» вторым заходом при провале —
async function ocrBuffersBatch(buffers, { client, handwriting=false, maxTokens=1500 }){
  // Готовим inputs
  const inputs = buffers.map(b => ({ type:'image_url', image_url:{ url: `data:image/${'png'};base64,${b.toString('base64')}` } }));
  const SYS1 = 'You are an OCR engine. Return the visible text as plain UTF-8 text. No summaries, no disclaimers. Output text only.';
  const SYS2 = 'You transcribe handwriting and printed documents verbatim. If unreadable, output ???. Keep original line breaks and punctuation. Output plain UTF-8 text only.';
  const sys = handwriting ? SYS2 : SYS1;

  const ask = async (systemPrompt) => {
    const r = await client.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role:'system', content: systemPrompt },
        { role:'user', content: [ { type:'text', text: 'Extract plain text from all images exactly as seen, concatenated in reading order.' }, ...inputs ] }
      ]
    });
    return (r.choices?.[0]?.message?.content || '').trim();
  };

  let out = await ask(sys);
  if (!out || out.length < 8) {
    // Повторная попытка (иногда помогает)
    out = await ask(SYS2);
  }
  return out || '';
}

// — весь OCR: разбиваем на батчи <45MB, собираем текст —
async function ocrBuffersAll(binaries, { client, handwriting=false, maxTokens=1500 }){
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const buf of binaries){
    const est = Math.ceil(buf.length * 1.37);
    if (cur.length && (curBytes + est >= BATCH_PAYLOAD_BUDGET)) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(buf);
    curBytes += est;
  }
  if (cur.length) batches.push(cur);

  const parts = [];
  for (const group of batches){
    const txt = await ocrBuffersBatch(group, { client, handwriting, maxTokens });
    parts.push(txt || '');
  }
  return parts.join('\n\n');
}

// — «качество OCR» —
function estimateOcrQuality(text){
  if(!text) return 'poor';
  const len = text.length;
  const alpha = (text.match(/[A-Za-zА-Яа-яĄąĆćĘęŁłŃńÓóŚśŹźŻż]/g)||[]).length;
  const ratio = alpha/Math.max(1,len);
  if(ratio>0.7 && len>500) return 'good';
  if(ratio>0.4 && len>200) return 'medium';
  return 'poor';
}

// === fees helpers ===
function detectPurposeByKeywords(title='', recipient='', fees){
  const low = stripDiacritics((title+' '+recipient).toLowerCase());
  const map = fees?.purpose_keywords || {};
  for(const [purpose, arr] of Object.entries(map)){
    if(arr.some(k => low.includes(stripDiacritics(k.toLowerCase())))){
      return purpose;
    }
  }
  return null;
}
function resolvePurpose(pathName='', detectedPurpose='', title='', recipient='', fees){
  const ov = fees?.path_overrides || {};
  const keyFromPath = ov[pathName] || ov[(pathName||'').toLowerCase()];
  if(keyFromPath) return keyFromPath;
  if(detectedPurpose) return detectedPurpose;
  const byKw = detectPurposeByKeywords(title, recipient, fees);
  if(byKw) return byKw;
  return 'temporary_residence_general';
}

// === загрузка правил/схем ===
async function loadRules(){
  const basePrompt = await fsp.readFile(path.join(root, 'rules', 'prompt.base.txt'), 'utf8');
  const schema = JSON.parse(await fsp.readFile(path.join(root, 'rules', 'schema.verify.json'), 'utf8'));
  const rules = JSON.parse(await fsp.readFile(path.join(root, 'rules', 'doc_rules.json'), 'utf8'));
  let fees = {};
  try {
    fees = JSON.parse(await fsp.readFile(path.join(root, 'rules', 'context', 'fees.json'), 'utf8'));
  } catch {}
  return { basePrompt, schema, rules, fees };
}

// ---- LLM messages ----
function buildMessages({ basePrompt, schema, rulesForType, fees, context, ocrText, mergedImageDataUrl }) {
  const sys = basePrompt;
  const extractionHint =
`К ИЗВЛЕЧЕНИЮ (если есть в документе/сканах):
- Для паспорта: passport_stamps[] (дата/страна/тип отметки).
- Для анкеты: wniosek_trips[] (дата/направление/цель).
- Для трудового пакета: поля из Zał.1 и договора (сопоставить).
- Для PIT: имена/PESEL/NIP налогоплательщика/супруга, суммы.`;

  const userParts = [
    { type:'text', text:
`docType: ${context.docType}
citizenship: ${context.citizenship||'unknown'}
path: ${context.path||'general'}
applicationDate: ${context.applicationDate||new Date().toISOString().slice(0,10)}
userName: ${context.userName||''}
${extractionHint}
Return STRICT JSON per schema. If data insufficient: set passed=false with helpful fixTip. If language != PL: advise sworn translation.` },
    { type:'text', text: `SCHEMA:\n${JSON.stringify(schema)}` },
    { type:'text', text: `CHECKLIST FOR TYPE:\n${JSON.stringify(rulesForType, null, 2)}` }
  ];
  if (fees && Object.keys(fees).length){
    userParts.push({ type:'text', text: `FEES_TABLE:\n${JSON.stringify(fees, null, 2)}` });
  }
  if(ocrText && ocrText.trim()){
    userParts.push({ type:'text', text:`OCR_TEXT (raw):\n${ocrText.slice(0,20000)}` });
  }
  if(mergedImageDataUrl){
    userParts.push({ type:'image_url', image_url:{ url: mergedImageDataUrl } });
  }
  return [
    { role:'system', content: sys },
    { role:'user', content: userParts }
  ];
}

async function callLLM({ messages }){
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    messages
  });
  const out = resp.choices?.[0]?.message?.content || '{}';
  const s = out.indexOf('{'), e = out.lastIndexOf('}');
  let json = {};
  if(s>=0 && e>s){ try{ json = JSON.parse(out.slice(s,e+1)); }catch{ json={ verdict:{status:'uncertain',summary:'parse error'}, raw: out}; } }
  else { json = { verdict:{status:'uncertain',summary:'no json'}, raw: out }; }
  return json;
}

// === пост-валидации для opłata skarbowa ===

// 1) «Платёж свежий»: один чек, приоритет applicationDate, иначе — сегодня.
function enforcePaymentRecency(result, applicationDate){
  try{
    if(!result || (result.docType!=='oplata_skarbowa' && result.docType!=='opłata_skarbowa')) return;

    const fields = result.fieldsExtracted || {};
    const paymentStr = fields.payment_date || fields.paymentDate || '';
    const refDate = parsePLDate(applicationDate) || new Date();
    const usedRefLabel = parsePLDate(applicationDate) ? 'applicationDate' : 'today';

    const RECENCY_KEYS = new Set(['payment_date_recent','payment_recent','payment_recency','payment_fresh']);
    const checks = Array.isArray(result.checks) ? result.checks.filter(c=>{
      if(!c) return false;
      if(RECENCY_KEYS.has(c.key)) return false;
      if(typeof c.title==='string' && /плат[её]ж.*свеж/i.test(c.title)) return false;
      return true;
    }) : [];

    const chk = { key: 'payment_date_recent', title: 'Платёж свежий', required: false };

    const payment = parsePLDate(paymentStr);
    if(!payment){
      chk.passed = false;
      chk.details = 'Не удалось разобрать дату платежа (ожидается DD.MM.YYYY или YYYY-MM-DD).';
    } else {
      const diff = daysBetween(refDate, payment);
      const inFuture = diff < 0;
      const within60 = diff <= 60;
      chk.passed = !inFuture && within60;
      chk.details = `payment_date=${paymentStr} ⇒ ${payment.toISOString().slice(0,10)}, ref(${usedRefLabel})=${refDate.toISOString().slice(0,10)}, diffDays=${diff}, threshold=60`;
    }

    checks.push(chk);
    result.checks = checks;
  }catch(e){}
}

// 2) «Сумма соответствует цели»: один чек, детерминированно, по fees.json
function enforceFeeAmount(result, applicationDate, pathName, fees){
  try{
    if(!result || (result.docType!=='oplata_skarbowa' && result.docType!=='opłata_skarbowa')) return;

    const fields = result.fieldsExtracted = result.fieldsExtracted || {};
    let checks = Array.isArray(result.checks) ? result.checks : (result.checks = []);

    // дедуп: вычищаем все возможные LLM-варианты про сумму
    const AMOUNT_KEYS = new Set(['amount_correct','fee_amount_correct','amount_ok','kwota_poprawna','suma_zgodna']);
    checks = checks.filter(c=>{
      if(!c) return false;
      if(AMOUNT_KEYS.has(c.key)) return false;
      if(typeof c.title==='string' && /сумм[аы].*соответ/i.test(c.title)) return false;
      if(typeof c.title==='string' && /(kwota|suma).*(zgodna|poprawna)/i.test(c.title)) return false;
      if(typeof c.title==='string' && /amount.*(match|correct)/i.test(c.title)) return false;
      return true;
    });

    result.checks = checks; // применяем отфильтрованный список

    // парс суммы
    let amountStr = fields.amount || fields.amount_raw || '';
    let amountVal = fields.amount_value;
    if (amountVal == null) {
      amountVal = parseAmountToNumber(amountStr);
      if (amountVal == null && typeof fields.amount === 'string') amountVal = parseAmountToNumber(fields.amount);
      if (amountVal == null && typeof fields.amount_raw === 'string') amountVal = parseAmountToNumber(fields.amount_raw);
      fields.amount_value = amountVal ?? null;
    }

    const title = (fields.title || '').toString();
    const recipient = (fields.recipient || '').toString();
    const llmPurpose = (fields.detected_purpose || '').toString();

    const purpose = resolvePurpose(pathName || '', llmPurpose, title, recipient, fees);
    const expected = fees?.items?.[purpose]?.amount_pln ?? fees?.items?.temporary_residence_general?.amount_pln ?? null;
    const tolerance = fees?.tolerance_pln ?? 1;

    fields.detected_purpose = purpose;
    fields.expected_amount = expected;

    const chk = { key: 'amount_correct', title: 'Сумма соответствует цели', required: true };

    if (amountVal == null || expected == null){
      chk.passed = false;
      chk.details = `Недостаточно данных для проверки суммы: amount=${amountVal}, expected=${expected}, purpose=${purpose}`;
    } else {
      const delta = Math.abs(amountVal - expected);
      fields.amount_delta = delta;
      chk.passed = delta <= tolerance;
      chk.details = `amount=${amountVal} PLN, expected=${expected} PLN (purpose=${purpose}), tolerance=±${tolerance}, delta=${delta}`;
    }

    result.checks.push(chk);
  }catch(e){}
}

// 3) Вердикт выравниваем по чек-боксам (для opłata skarbowa)
function enforceVerdictConsistency(result){
  try{
    if(!result || (result.docType!=='oplata_skarbowa' && result.docType!=='opłata_skarbowa')) return;

    const checks = Array.isArray(result.checks) ? result.checks : [];
    const failedReq = checks.filter(c => c && c.required && c.passed === false).map(c => c.title || c.key);
    const failedOpt = checks.filter(c => c && !c.required && c.passed === false).map(c => c.title || c.key);

    let status = 'pass';
    if (failedReq.length) status = 'fail';
    else if (failedOpt.length) status = 'uncertain';

    const summary =
      status === 'pass'
        ? 'Все обязательные проверки пройдены.'
        : status === 'fail'
          ? `Провалены обязательные проверки: ${failedReq.join(', ')}.`
          : `Есть замечания по необязательным пунктам: ${failedOpt.join(', ')}.`;

    result.verdict = { ...(result.verdict || {}), status, summary };
  }catch(e){}
}

// === главный пайплайн ===
async function processNow({ files, docType, citizenship, pathName, applicationDate, userName, wantDebug=false, wantDebugFull=false, ocrMode='auto' }){
  const pdfs = files.filter(f=>f.mimetype==='application/pdf');
  const imgs = files.filter(f=>f.mimetype?.startsWith('image/'));
  if(pdfs.length && imgs.length) throw new Error('Upload either PDF or images, not both');
  if(pdfs.length>1) throw new Error('Only one PDF allowed');

  const handwriting = (ocrMode === 'handwriting');

  const debug = { handwriting };
  let ocrText = '';
  let mergedJPEG = null;

  const client = openai;

  if(pdfs.length===1){
    const buf = await readTmp(pdfs[0].filepath);

    // 1) Попытка «живого» текста
    let viaParse = await tryPdfParseText(buf);
    debug.pdfParseLen = viaParse.length;

    // 2) Попытка через pdfjs
    let viaPdfjs = '';
    try { viaPdfjs = await pdfExtractTextViaPdfjs(buf, MAX_PDF_PAGES); } catch {}
    debug.pdfjsLen = viaPdfjs.length;

    // Берём лучший из текстовых
    ocrText = (viaParse.length >= viaPdfjs.length ? viaParse : viaPdfjs) || '';

    // 3) Если текста мало — OCR по страницам (и тайлам при handwriting) батчами
    if (ocrText.length < 500) {
      const scale = handwriting ? 3.0 : 2.0;
      const { pngs, pages } = await renderPdfPages(buf, MAX_PDF_PAGES, scale);
      debug.pagesRendered = pages;

      const prepped = [];
      let tilesTotal = 0;

      for (const p of pngs){
        const pre = await preprocessForOCR(p, { handwriting });
        if (handwriting) {
          const tiles = await tileImage(pre);
          tilesTotal += tiles.length;
          // для OCR — тайлы в PNG (после предварительной обработки)
          prepped.push(...tiles);
        } else {
          prepped.push(pre);
        }
      }
      debug.tilesTotal = handwriting ? tilesTotal : 0;

      // батчи <45MB
      const ocrAll = await ocrBuffersAll(prepped, { client, handwriting, maxTokens: 1400 });
      debug.ocrVisionLen = ocrAll.length;

      // склеиваем: если раньше был какой-то текст — добавим для полноты
      const joined = [];
      if (ocrText) joined.push(ocrText);
      if (ocrAll) joined.push(ocrAll);
      ocrText = joined.join('\n\n').trim();
    }

    // 4) Сводный JPEG для визуальных проверок (подписи/печати) — первые 10 страниц
    try{
      const { pngs, pages } = await renderPdfPages(buf, MAX_RENDER_PAGES, 2.0);
      if (pngs.length) {
        mergedJPEG = await mergeImagesVerticallySharp(pngs);
        debug.mergedJpegBytes = mergedJPEG.length;
      } else {
        debug.mergedJpegBytes = 0;
      }
    }catch(e){
      debug.mergedJpegBytes = debug.mergedJpegBytes || 0;
    }

  } else if(imgs.length>=1){
    // пачка изображений
    const normalized = [];
    for(const im of imgs){
      const b = await readTmp(im.filepath);
      // предобработка зависит от handwriting
      const pre = await preprocessForOCR(b, { handwriting });
      if (handwriting) {
        const tiles = await tileImage(pre);
        normalized.push(...tiles);
      } else {
        normalized.push(pre);
      }
    }
    debug.pagesRendered = imgs.length;
    debug.tilesTotal = handwriting ? normalized.length : 0;

    const ocrAll = await ocrBuffersAll(normalized, { client, handwriting, maxTokens: 1400 });
    ocrText = (ocrAll || '').trim();
    debug.ocrVisionLen = ocrText.length;

    // Сводный JPEG для визуальных проверок
    try{
      // Для визуала: без тайлов, а нормализованные картинки (без агрессивного threshold)
      const vis = [];
      for (const im of imgs){
        const raw = await readTmp(im.filepath).catch(()=>null); // на всякий — вдруг уже удалили
        if (raw) {
          const v = await sharp(raw).rotate().jpeg({ quality: 85 }).toBuffer();
          vis.push(v);
        }
      }
      if (vis.length){
        mergedJPEG = await mergeImagesVerticallySharp(vis);
        debug.mergedJpegBytes = mergedJPEG.length;
      } else {
        debug.mergedJpegBytes = 0;
      }
    }catch(e){
      debug.mergedJpegBytes = debug.mergedJpegBytes || 0;
    }
  } else {
    throw new Error('Attach 1 PDF or up to 20 images');
  }

  const mergedDataUrl = mergedJPEG ? `data:image/jpeg;base64,${mergedJPEG.toString('base64')}` : null;
  const { basePrompt, schema, rules, fees } = await loadRules();
  const rulesForType = rules[docType] || { checks:[], fields:[] };

  const messages = buildMessages({
    basePrompt,
    schema,
    rulesForType,
    fees,
    context: { docType, citizenship, path: pathName, applicationDate, userName },
    ocrText,
    mergedImageDataUrl: mergedDataUrl
  });

  const result = await callLLM({ messages });
  result.ocrQuality = result.ocrQuality || estimateOcrQuality(ocrText||'');
  result.docType = result.docType || docType;

  // === детерминированные поправки для opłata skarbowa ===
  enforcePaymentRecency(result, applicationDate);
  enforceFeeAmount(result, applicationDate, pathName, fees);
  enforceVerdictConsistency(result);

  const debugOut = { ...debug };
  // финальные метрики
  debugOut.ocrTextLen = (ocrText||'').length;

  if(wantDebug){
    debugOut.rulesUsed  = rulesForType;
    debugOut.userName   = userName || '';
    if(wantDebugFull){
      debugOut.ocrTextHead = (ocrText||'').slice(0, 2000);
    }
  }

  return { result, debug: wantDebug ? debugOut : undefined };
}

// === detect purpose by keywords & fees === (уже выше)

// === HTTP обёртки ===
function bad(res, code, error){
  res.statusCode = code;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify({ error }));
}

export default async function handler(req, res){
  if(req.method!=='POST') return bad(res, 405, 'Method not allowed');

  try{
    if(!envApiKey()) return bad(res, 500, 'OPENAI_API_KEY not set');

    const { fields, files } = await parseForm(req);
    const docType = String(fields.docType||'').trim() || 'unknown';
    const citizenship = String(fields.citizenship||'').trim() || '';
    const pathName = String(fields.path||'').trim() || '';
    const applicationDate = String(fields.applicationDate||'').trim() || '';
    const userName = String(fields.userName||'').trim() || '';
    const wantDebug = String(fields.debug||'')==='1';
    const wantDebugFull = String(fields.debug_full||'')==='1';
    const ocrMode = String(fields.ocr_mode||'').toLowerCase(); // 'handwriting' | '' | 'auto'

    if(!files.length) return bad(res, 400, 'No files');
    if(files.length>MAX_FILES) return bad(res, 400, `Max ${MAX_FILES} files`);
    const total = sumSize(files);
    if(total > MAX_TOTAL_BYTES) return bad(res, 400, `Total size exceeds 35MB`);

    const { result, debug } = await processNow({
      files, docType, citizenship, pathName, applicationDate, userName,
      wantDebug, wantDebugFull, ocrMode
    });

    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.end(JSON.stringify({ ok:true, result, ...(debug ? { debug } : {}) }));
  }catch(e){
    bad(res, 500, e.message || 'Internal error');
  }
}
