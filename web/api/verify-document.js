import { promises as fsp } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import formidable from 'formidable';
import OpenAI from 'openai';
import sharp from 'sharp';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ── фикс рантайма: Node.js (НЕ edge)
export const config = { runtime: 'nodejs' };

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

// ── pdfjs worker под Node (file:// URL через pathToFileURL + require.resolve)
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
).href;

function toU8(buf){ return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }

async function parseForm(req){
  const form = formidable({ multiples: true, maxFileSize: 35*1024*1024 });
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
function extOf(name='file'){ return (name.split('.').pop()||'').toLowerCase(); }

async function pdfExtractText(u8){
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const pages = doc.numPages;
  if(pages>20) throw new Error('PDF has more than 20 pages');
  let all = '';
  for(let i=1;i<=pages;i++){
    const page = await doc.getPage(i);
    const txt = await page.getTextContent();
    all += txt.items.map(it=>it.str).join('\n') + '\n';
  }
  return all.trim();
}

async function pdfRenderMergedJPEG(u8){
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const pages = doc.numPages;
  if(pages>20) throw new Error('PDF has more than 20 pages');
  const images = [];
  for(let i=1;i<=pages;i++){
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    images.push(canvas.toBuffer('image/png'));
  }
  return await mergeImagesVertically(images);
}

async function mergeImagesVertically(buffers){
  const imgs = [];
  for(const b of buffers){ imgs.push(await loadImage(b)); }
  const width = Math.max(...imgs.map(i=>i.width));
  const height = imgs.reduce((a,i)=>a+i.height,0);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  let y=0;
  for(const im of imgs){ ctx.drawImage(im, 0, y); y+=im.height; }
  const jpg = canvas.toBuffer('image/jpeg', { quality: 0.9 });
  return await sharp(jpg).rotate().jpeg({ quality: 85 }).toBuffer();
}

async function imagesToMergedJPEG(buffers){
  const norm = [];
  for(const b of buffers){ norm.push(await sharp(b).rotate().jpeg({ quality:85 }).toBuffer()); }
  return await mergeImagesVertically(norm);
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
Return STRICT JSON per schema. If data insufficient: set passed=false with helpful fixTip. If language != PL: advise sworn translation.` },
    { type:'text', text: `SCHEMA:\n${JSON.stringify(schema)}` },
    { type:'text', text: `CHECKLIST FOR TYPE:\n${JSON.stringify(rulesForType, null, 2)}` }
  ];
  if(ocrText && ocrText.trim()){
    userParts.push({ type:'text', text:`OCR_TEXT (raw, may include noise):\n${ocrText.slice(0,20000)}` });
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
  if(s>=0 && e>s){ try{ json = JSON.parse(out.slice(s,e+1)); }catch{ json={ verdict:{status:'uncertain',summary:'parse error'}, raw: out }; } }
  else { json = { verdict:{status:'uncertain',summary:'no json'}, raw: out }; }
  return json;
}

async function processNow({ files, docType, citizenship, pathName, applicationDate }){
  const pdfs = files.filter(f=>f.mimetype==='application/pdf');
  const imgs = files.filter(f=>f.mimetype?.startsWith('image/'));
  if(pdfs.length && imgs.length) throw new Error('Upload either PDF or images, not both');
  if(pdfs.length>1) throw new Error('Only one PDF allowed');

  let ocrText = '';
  let mergedJPEG = null;

  if(pdfs.length===1){
    const buf = await readTmp(pdfs[0].filepath);
    try{
      const t = await pdfExtractText(buf);
      if(t && t.replace(/\s+/g,' ').length>=200) ocrText = t;
    }catch{}
    try{ mergedJPEG = await pdfRenderMergedJPEG(buf); }catch{}
  } else if(imgs.length>=1){
    const bufs = [];
    for(const im of imgs){ bufs.push(await readTmp(im.filepath)); }
    mergedJPEG = await imagesToMergedJPEG(bufs);
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
    context: { docType, citizenship, path: pathName, applicationDate },
    ocrText,
    mergedImageDataUrl: mergedDataUrl
  });

  const result = await callLLM({ messages });
  result.ocrQuality = result.ocrQuality || estimateOcrQuality(ocrText||'');
  result.docType = result.docType || docType;
  return result;
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

    const form = await parseForm(req);
    const { fields, files } = form;
    const docType = String(fields.docType||'').trim() || 'unknown';
    const citizenship = String(fields.citizenship||'').trim() || '';
    const pathName = String(fields.path||'').trim() || '';
    const applicationDate = String(fields.applicationDate||'').trim() || '';

    if(!files.length) return bad(res, 400, 'No files');
    if(files.length>20) return bad(res, 400, 'Max 20 files');
    const total = sumSize(files);
    if(total > 30*1024*1024) return bad(res, 400, 'Total size exceeds 30MB');

    const result = await processNow({ files, docType, citizenship, pathName, applicationDate });
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.end(JSON.stringify({ ok:true, result }));
  }catch(e){
    bad(res, 500, e.message || 'Internal error');
  }
}
