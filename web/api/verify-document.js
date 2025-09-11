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

async function loadRules(){
  const basePrompt = await fsp.readFile(path.join(root, 'rules', 'prompt.base.txt'), 'utf8');
  const schema = JSON.parse(await fsp.readFile(path.join(root, 'rules', 'schema.verify.json'), 'utf8'));
  const rules = JSON.parse(await fsp.readFile(path.join(root, 'rules', 'doc_rules.json'), 'utf8'));
  return { basePrompt, schema, rules };
}

function buildMessages({ basePrompt, schema, rulesForType, context, ocrText, mergedImageDataUrl }) {
  const sys = basePrompt;
  const userParts = [
    { type:'text', text:
`docType: ${context.docType}
citizenship: ${context.citizenship||'unknown'}
path: ${context.path||'general'}
applicationDate: ${context.applicationDate||new Date().toISOString().slice(0,10)}
userName: ${context.userName||''}
Return STRICT JSON per schema. If data insufficient: set passed=false with helpful fixTip. If language != PL: advise sworn translation.` },
    { type:'text', text: `SCHEMA:\n${JSON.stringify(schema)}` },
    { type:'text', text: `CHECKLIST FOR TYPE:\n${JSON.stringify(rulesForType, null, 2)}` }
  ];
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
  const { basePrompt, schema, rules } = await loadRules();
  const rulesForType = rules[docType] || { checks:[], fields:[] };

  const messages = buildMessages({
    basePrompt,
    schema,
    rulesForType,
    context: { docType, citizenship, path: pathName, applicationDate, userName },
    ocrText,
    mergedImageDataUrl: mergedDataUrl
  });

  const result = await callLLM({ messages });
  result.ocrQuality = result.ocrQuality || estimateOcrQuality(ocrText||'');
  result.docType = result.docType || docType;

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
