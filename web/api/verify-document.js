import { promises as fsp } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import formidable from 'formidable';
import OpenAI from 'openai';
import sharp from 'sharp';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { put } from '@vercel/blob';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function envApiKey() {
  return process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY || process.env.OPEN_AI_KEY || process.env.OPENAI_KEY || process.env.OPENAI;
}
const openai = new OpenAI({ apiKey: envApiKey() });

pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

export const config = {
  api: { bodyParser: false, sizeLimit: '35mb' } // чуть выше лимита, мы сами проверим 30MB
};

function toU8(buf){ return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }

async function readFileBuffer(fp){
  const buf = await fsp.readFile(fp);
  // удалить сразу
  fsp.unlink(fp).catch(()=>{});
  return buf;
}

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

function sumSize(files){ return files.reduce((a,f)=>a+ (f.size||0), 0); }
function extOf(name='file'){ return (name.split('.').pop()||'').toLowerCase(); }

async function pdfExtractText(u8){
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const pages = doc.numPages;
  if(pages>20) throw new Error('PDF has more than 20 pages');
  let all = '';
  for(let i=1;i<=pages;i++){
    const page = await doc.getPage(i);
    const txt = await page.getTextContent();
    const str = txt.items.map(it=>it.str).join('\n');
    all += str+'\n';
  }
  return { pages, text: all.trim() };
}

async function pdfRenderMergedJPEG(u8){
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const pages = doc.numPages;
  if(pages>20) throw new Error('PDF has more than 20 pages');
  // Рендерим каждую страницу в PNG и склеиваем вертикально
  const images = [];
  for(let i=1;i<=pages;i++){
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 }); // Retina-ish
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const png = canvas.toBuffer('image/png');
    images.push(png);
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
  for(const im of imgs){
    ctx.drawImage(im, 0, y);
    y += im.height;
  }
  const jpg = canvas.toBuffer('image/jpeg', { quality: 0.9 });
  // Нормализуем через sharp
  const normalized = await sharp(jpg).rotate().jpeg({ quality: 85 }).toBuffer();
  return normalized;
}

async function imagesToMergedJPEG(buffers){
  // normalize + merge
  const normalized = [];
  for(const b of buffers){
    const out = await sharp(b).rotate().jpeg({ quality: 85 }).toBuffer();
    normalized.push(out);
  }
  return await mergeImagesVertically(normalized);
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
  const income = JSON.parse(await fsp.readFile(path.join(root, 'rules', 'context', 'income_thresholds.json'), 'utf8'));
  const fees = JSON.parse(await fsp.readFile(path.join(root, 'rules', 'context', 'fees.json'), 'utf8'));
  return { basePrompt, schema, rules, income, fees };
}

function buildMessages({ basePrompt, schema, rulesForType, context, ocrText, mergedImageDataUrl }) {
  const sys = basePrompt;
  const userParts = [
    { type:'text', text:
`docType: ${context.docType}
citizenship: ${context.citizenship||'unknown'}
path: ${context.path||'general'}
applicationDate: ${context.applicationDate||new Date().toISOString().slice(0,10)}
Return STRICT JSON per schema. If data insufficient: mark checks passed=false with helpful fixTip. If language != PL: advise sworn translation.` },
    { type:'text', text: `SCHEMA:\n${JSON.stringify(schema)}` },
    { type:'text', text: `CHECKLIST FOR TYPE:\n${JSON.stringify(rulesForType, null, 2)}` },
  ];
  if(ocrText && ocrText.trim().length){
    userParts.push({ type:'text', text:`OCR_TEXT (raw, may include noise):\n${ocrText.slice(0, 20000)}` });
  }
  if(mergedImageDataUrl){
    userParts.push({ type:'image_url', image_url: { url: mergedImageDataUrl } });
  }
  return [
    { role:'system', content: sys },
    { role:'user', content: userParts }
  ];
}

async function callLLMBuildJSON({ messages }){
  // Один вызов: модель анализирует текст/изображение и возвращает JSON по схеме
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    messages
  });
  const out = resp.choices?.[0]?.message?.content || '{}';
  // Попытка выдрать JSON
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  let json = {};
  if(start>=0 && end>start){
    try { json = JSON.parse(out.slice(start, end+1)); } catch(e){ json = { verdict:{status:'uncertain', summary:'Model returned non-JSON'}, raw: out }; }
  } else {
    json = { verdict:{status:'uncertain', summary:'No JSON found'}, raw: out };
  }
  return json;
}

async function processNow({ files, docType, citizenship, pathName, applicationDate }){
  // prepare OCR
  const pdfs = files.filter(f=>f.mimetype==='application/pdf');
  const imgs = files.filter(f=>f.mimetype?.startsWith('image/'));
  let ocrText = '';
  let mergedJPEG = null;

  if(pdfs.length===1){
    const buf = await readFileBuffer(pdfs[0].filepath);
    // try text first
    let text = '';
    try{
      const t = await pdfExtractText(buf);
      text = t.text;
    }catch(e){ text=''; }
    if(!text || text.replace(/\s+/g,' ').length<200){
      mergedJPEG = await pdfRenderMergedJPEG(buf);
    } else {
      ocrText = text;
      // рендерим тоже (для печатных полей/подписей)
      try { mergedJPEG = await pdfRenderMergedJPEG(buf); } catch(e){}
    }
  } else if(imgs.length>=1){
    const bufs = [];
    for(const im of imgs){ bufs.push(await readFileBuffer(im.filepath)); }
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
  const result = await callLLMBuildJSON({ messages });
  // enrichment: add simple ocrQuality
  result.ocrQuality = result.ocrQuality || estimateOcrQuality(ocrText||'');
  result.docType = result.docType || docType;
  return result;
}

async function uploadBlob(key, buf, contentType){
  const { url } = await put(key, buf, { access: 'private', contentType });
  return { url, key };
}

function addMinutes(date, minutes){
  return new Date(date.getTime() + minutes*60000);
}

function iso(d){ return new Date(d).toISOString(); }

function bad(res, code, error){
  res.statusCode = code;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify({ error }));
}

export default async function handler(req, res){
  if(req.method!=='POST') return bad(res, 405, 'Method not allowed');
  try{
    const { fields, files } = await parseForm(req);
    const mode = String(fields.mode||'').toLowerCase()==='queued' ? 'queued' : 'now';
    const docType = String(fields.docType||'').trim() || 'unknown';
    const citizenship = String(fields.citizenship||'').trim() || '';
    const pathName = String(fields.path||'').trim() || '';
    const applicationDate = String(fields.applicationDate||'').trim() || '';

    if(!envApiKey()) return bad(res, 500, 'OPENAI_API_KEY not set');

    if(!files.length) return bad(res, 400, 'No files');
    if(files.length>20) return bad(res, 400, 'Max 20 files');
    const total = sumSize(files);
    if(total > 30*1024*1024) return bad(res, 400, 'Total size exceeds 30MB');

    const pdfs = files.filter(f=>f.mimetype==='application/pdf');
    const imgs = files.filter(f=>f.mimetype?.startsWith('image/'));
    if(pdfs.length && imgs.length) return bad(res, 400, 'Upload either PDF or images, not both');
    if(pdfs.length>1) return bad(res, 400, 'Only one PDF allowed');

    if(mode==='queued'){
      // загружаем файлы в Blob, создаём job JSON
      const jobId = Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
      const uploaded = [];
      for(let i=0;i<files.length;i++){
        const buf = await fsp.readFile(files[i].filepath);
        await fsp.unlink(files[i].filepath).catch(()=>{});
        const key = `uploads/${jobId}/${i}_${files[i].originalFilename||'file'}.${extOf(files[i].originalFilename||'dat')}`;
        const up = await uploadBlob(key, buf, files[i].mimetype || 'application/octet-stream');
        uploaded.push({ key: up.key, url: up.url, mimetype: files[i].mimetype, size: files[i].size });
      }
      const runAt = addMinutes(new Date(), 23*60+50);
      const job = {
        id: jobId,
        status: 'queued',
        createdAt: iso(new Date()),
        runAt: iso(runAt),
        docType, citizenship, path: pathName, applicationDate,
        files: uploaded
      };
      await uploadBlob(`jobs/${jobId}.json`, Buffer.from(JSON.stringify(job)), 'application/json');
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify({ ok:true, jobId, runAt: job.runAt }));
      return;
    } else {
      const result = await processNow({ files, docType, citizenship, pathName, applicationDate });
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(JSON.stringify({ ok:true, result }));
      return;
    }
  }catch(e){
    bad(res, 500, e.message || 'Internal error');
  }
}
