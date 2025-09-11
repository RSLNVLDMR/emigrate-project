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

// pdfjs worker
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
  const form = formidable({ multiples: true, maxFileSize: 35*1024*1024, uploadDir: '/tmp', keepExtensions: true });
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

async function tryPdfParseText(buf){
  try{
    const mod = await import('pdf-parse');
    const pdfParse = mod.default || mod;
    const parsed = await pdfParse(buf);
    const t = (parsed.text || '').trim();
    return t && t.length>10 ? t : '';
  }catch{ return ''; }
}

async function pdfExtractTextViaPdfjs(u8, limit=20){
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

async function renderPdfPages(u8, maxPages=10, scale=2.0){
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  const out = [];
  for(let i=1;i<=pages;i++){
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push(canvas.toBuffer('image/png'));
  }
  return { pngs: out, pages };
}

async function mergeImagesVerticallySharp(pngBuffers){
  const metas = await Promise.all(pngBuffers.map(b => sharp(b).metadata()));
  const width = Math.max(...metas.map(m => m.width || 1));
  let y = 0;
  const composite = [];
  for (let i=0; i<pngBuffers.length; i++){
    const h = metas[i].height || 1;
    composite.push({ input: pngBuffers[i], top: y, left: 0 });
    y += h;
  }
  const base = sharp({ create: { width, height: y, channels: 3, background: { r: 255, g: 255, b: 255 } } });
  const out = await base.composite(composite).jpeg({ quality: 85 }).toBuffer();
  return await sharp(out).rotate().jpeg({ quality: 85 }).toBuffer();
}

function estimateOcrQuality(text){
  if(!text) return 'poor';
  const len = text.length;
  const alpha = (text.match(/[A-Za-zА-Яа-яĄąĆćĘęŁłŃńÓóŚśŹźŻż]/g)||[]).length;
  const ratio = alpha/Math.max(1,len);
  if(ratio>0.7 && len>500) return 'good';
  if(ratio>0.4 && len>200) return 'medium';
  return 'poor';
}

function stripDiacritics(s=''){
  // минимальная нормализация для сравнения ключевых слов
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}

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

// ---- date utils (deterministic) ----
function parsePLDate(s){
  if(!s || typeof s!=='string') return null;
  const t = s.trim();
  // ISO yyyy-mm-dd / yyyy.mm.dd / yyyy/mm/dd
  let m = t.match(/^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/);
  if(m){
    const [_,Y,Mo,D] = m;
    const d = new Date(Number(Y), Number(Mo)-1, Number(D));
    return isNaN(d) ? null : d;
  }
  // dd.mm.yyyy / dd-mm-yyyy / dd/mm/yyyy
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

// ---- amount utils ----
function parseAmountToNumber(s=''){
  if(typeof s !== 'string') s = String(s ?? '');
  let t = s.trim();
  // detect parentheses negative
  let negative = /^\(.*\)$/.test(t);
  t = t.replace(/^\((.*)\)$/, '$1');
  // normalize dashes to minus
  t = t.replace(/[–—−]/g, '-');
  // drop currency and spaces
  t = t.replace(/\s+/g,'').replace(/pln|zł|zl/ig,'');
  // allow single leading minus
  // replace comma with dot
  t = t.replace(',', '.');
  // keep only first minus if any
  const m = t.match(/^-?\d+(\.\d+)?/);
  let num = m ? parseFloat(m[0]) : NaN;
  if(isNaN(num)) return null;
  if(negative) num = -Math.abs(num);
  return Math.abs(num);
}

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
  // 1) path override
  const ov = fees?.path_overrides || {};
  const keyFromPath = ov[pathName] || ov[(pathName||'').toLowerCase()];
  if(keyFromPath) return keyFromPath;
  // 2) detected by LLM
  if(detectedPurpose) return detectedPurpose;
  // 3) keywords
  const byKw = detectPurposeByKeywords(title, recipient, fees);
  if(byKw) return byKw;
  // 4) default
  return 'temporary_residence_general';
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

// post-fix for oplata_skarbowa: compute payment_date_recent deterministically
function enforcePaymentRecency(result, applicationDate){
  try{
    if(!result || (result.docType!=='oplata_skarbowa' && result.docType!=='opłata_skarbowa')) return;

    const fields = result.fieldsExtracted || {};
    const paymentStr = fields.payment_date || fields.paymentDate || '';
    const appStr = applicationDate || '';
    const payment = parsePLDate(paymentStr);
    const ref = parsePLDate(appStr) || new Date(); // если дата подачи не передана — сегодня
    const checks = Array.isArray(result.checks) ? result.checks : [];

    let chk = checks.find(c => c && c.key === 'payment_date_recent');
    if(!chk){
      chk = { key: 'payment_date_recent', title: 'Платёж свежий', required: false };
      checks.push(chk);
      result.checks = checks;
    }

    if(!payment){
      chk.passed = false;
      chk.details = 'Не удалось разобрать дату платежа (ожидается DD.MM.YYYY или YYYY-MM-DD).';
      return;
    }

    const diff = daysBetween(ref, payment); // ref - payment
    const inFuture = diff < 0;
    const within60 = diff <= 60;

    chk.passed = !inFuture && within60;
    chk.details = `payment_date=${paymentStr} ⇒ ${payment.toISOString().slice(0,10)}, reference=${ref.toISOString().slice(0,10)}, diffDays=${diff}, threshold=60`;
  }catch(e){
    // не падаем
  }
}

// post-fix for oplata_skarbowa: compute amount_correct deterministically
function enforceFeeAmount(result, applicationDate, pathName, fees){
  try{
    if(!result || (result.docType!=='oplata_skarbowa' && result.docType!=='opłata_skarbowa')) return;

    const fields = result.fieldsExtracted = result.fieldsExtracted || {};
    const checks = Array.isArray(result.checks) ? result.checks : (result.checks = []);

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

    let chk = checks.find(c => c && c.key === 'amount_correct');
    if(!chk){
      chk = { key: 'amount_correct', title: 'Сумма соответствует цели', required: true };
      checks.push(chk);
    }

    if (amountVal == null || expected == null){
      chk.passed = false;
      chk.details = `Недостаточно данных для проверки суммы: amount=${amountVal}, expected=${expected}, purpose=${purpose}`;
      return;
    }

    const delta = Math.abs(amountVal - expected);
    fields.amount_delta = delta;

    chk.passed = delta <= tolerance;
    chk.details = `amount=${amountVal} PLN, expected=${expected} PLN (purpose=${purpose}), tolerance=±${tolerance}, delta=${delta}`;
  }catch(e){
    // не падаем
  }
}

async function processNow({ files, docType, citizenship, pathName, applicationDate, userName, wantDebug=false, wantDebugFull=false }){
  const pdfs = files.filter(f=>f.mimetype==='application/pdf');
  const imgs = files.filter(f=>f.mimetype?.startsWith('image/'));
  if(pdfs.length && imgs.length) throw new Error('Upload either PDF or images, not both');
  if(pdfs.length>1) throw new Error('Only one PDF allowed');

  const debug = {};
  let ocrText = '';
  let mergedJPEG = null;

  if(pdfs.length===1){
    const buf = await readTmp(pdfs[0].filepath);

    // 1) «Живой» текст
    let viaParse = await tryPdfParseText(buf);
    debug.pdfParseLen = viaParse.length;

    // 2) pdfjs getTextContent
    let viaPdfjs = '';
    try { viaPdfjs = await pdfExtractTextViaPdfjs(buf, 20); } catch {}
    debug.pdfjsLen = viaPdfjs.length;

    ocrText = viaParse.length >= viaPdfjs.length ? viaParse : viaPdfjs;

    // 3) JPEG из первых 10 страниц
    try{
      const { pngs, pages } = await renderPdfPages(buf, 10, 2.0);
      debug.pagesRendered = pages;
      if (pngs.length) {
        mergedJPEG = await mergeImagesVerticallySharp(pngs);
        debug.mergedJpegBytes = mergedJPEG.length;
      } else {
        debug.mergedJpegBytes = 0;
      }
    }catch(e){
      debug.pagesRendered = debug.pagesRendered || 0;
      debug.mergedJpegBytes = debug.mergedJpegBytes || 0;
    }

  } else if(imgs.length>=1){
    const normalized = [];
    for(const im of imgs){
      const b = await readTmp(im.filepath);
      normalized.push(await sharp(b).rotate().jpeg({ quality: 85 }).toBuffer());
    }
    mergedJPEG = await mergeImagesVerticallySharp(normalized);
    debug.pagesRendered = imgs.length;
    debug.mergedJpegBytes = mergedJPEG.length;
    debug.pdfParseLen = 0;
    debug.pdfjsLen = 0;
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

  if(wantDebug){
    debug.ocrTextLen = (ocrText||'').length;
    debug.rulesUsed  = rulesForType;
    debug.userName   = userName || '';
    if(wantDebugFull){
      debug.ocrTextHead = (ocrText||'').slice(0, 2000);
    }
  }

  return { result, debug: wantDebug ? debug : undefined };
}

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

    if(!files.length) return bad(res, 400, 'No files');
    if(files.length>20) return bad(res, 400, 'Max 20 files');
    const total = sumSize(files);
    if(total > 30*1024*1024) return bad(res, 400, 'Total size exceeds 30MB');

    const { result, debug } = await processNow({ files, docType, citizenship, pathName, applicationDate, userName, wantDebug, wantDebugFull });
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.end(JSON.stringify({ ok:true, result, ...(debug ? { debug } : {}) }));
  }catch(e){
    bad(res, 500, e.message || 'Internal error');
  }
}
