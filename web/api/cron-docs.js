import { get, list, put, del } from '@vercel/blob';
import { promises as fsp } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import sharp from 'sharp';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function envApiKey() {
  return process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY || process.env.OPEN_AI_KEY || process.env.OPENAI_KEY || process.env.OPENAI;
}
const openai = new OpenAI({ apiKey: envApiKey() });
pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

export const config = { runtime: 'edge' }; // быстрый воркер

function toU8(buf){ return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }
function iso(d){ return new Date(d).toISOString(); }

async function fetchJsonBlob(key){
  const b = await get(key);
  if(!b?.downloadUrl) return null;
  const r = await fetch(b.downloadUrl);
  if(!r.ok) return null;
  return await r.json();
}
async function fetchBuffer(key){
  const b = await get(key);
  if(!b?.downloadUrl) return null;
  const r = await fetch(b.downloadUrl);
  if(!r.ok) return null;
  const arr = new Uint8Array(await r.arrayBuffer());
  return Buffer.from(arr);
}

async function pdfExtractText(u8){
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const pages = doc.numPages;
  let all = '';
  for(let i=1;i<=pages;i++){
    const page = await doc.getPage(i);
    const txt = await page.getTextContent();
    const str = txt.items.map(it=>it.str).join('\n');
    all += str+'\n';
  }
  return all.trim();
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
    ctx.drawImage(im, 0, y); y+=im.height;
  }
  const jpg = canvas.toBuffer('image/jpeg', { quality: 0.9 });
  const normalized = await sharp(jpg).rotate().jpeg({ quality: 85 }).toBuffer();
  return normalized;
}
async function pdfRenderMergedJPEG(u8){
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const pages = doc.numPages;
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
Return STRICT JSON per schema.` },
    { type:'text', text: `SCHEMA:\n${JSON.stringify(schema)}` },
    { type:'text', text: `CHECKLIST FOR TYPE:\n${JSON.stringify(rulesForType, null, 2)}` },
  ];
  if(ocrText && ocrText.trim().length){
    userParts.push({ type:'text', text:`OCR_TEXT:\n${ocrText.slice(0,20000)}` });
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
  else json={ verdict:{status:'uncertain',summary:'no json'}, raw: out };
  return json;
}

export default async function handler(req){
  if(req.method!=='GET') return new Response(JSON.stringify({ error:'Method not allowed' }), { status:405 });
  if(!envApiKey()) return new Response(JSON.stringify({ error:'OPENAI_API_KEY not set' }), { status:500 });

  // Выбираем matured jobs
  const all = await list({ prefix: 'jobs/' });
  const now = Date.now();
  const matured = [];
  for(const it of all.blobs){
    if(!it.pathname.endsWith('.json')) continue;
    const job = await fetchJsonBlob(it.pathname);
    if(!job) continue;
    if(job.status==='queued' && new Date(job.runAt).getTime()<=now){
      matured.push(job);
    }
  }

  for(const job of matured){
    // Помечаем processing
    job.status = 'processing';
    await put(`jobs/${job.id}.json`, JSON.stringify(job), { access:'private', contentType:'application/json' });

    try{
      // собираем OCR
      const pdfs = job.files.filter(f=>f.mimetype==='application/pdf');
      const imgs = job.files.filter(f=>f.mimetype?.startsWith('image/'));
      let ocrText = '';
      let mergedJPEG = null;

      if(pdfs.length===1){
        const buf = await fetchBuffer(pdfs[0].key);
        try{ ocrText = await pdfExtractText(buf); }catch{}
        try{ mergedJPEG = await pdfRenderMergedJPEG(buf); }catch{}
      } else if(imgs.length>=1){
        const buffers = [];
        for(const im of imgs){ buffers.push(await fetchBuffer(im.key)); }
        // normalize images through sharp
        for(let i=0;i<buffers.length;i++){
          buffers[i] = await sharp(buffers[i]).rotate().jpeg({ quality:85 }).toBuffer();
        }
        mergedJPEG = await mergeImagesVertically(buffers);
      }

      const mergedDataUrl = mergedJPEG ? `data:image/jpeg;base64,${mergedJPEG.toString('base64')}` : null;

      // правила
      const { basePrompt, schema, rules } = await loadRules();
      const rulesForType = rules[job.docType] || { checks:[], fields:[] };

      const messages = buildMessages({
        basePrompt, schema, rulesForType,
        context: { docType: job.docType, citizenship: job.citizenship, path: job.path, applicationDate: job.applicationDate },
        ocrText, mergedImageDataUrl: mergedDataUrl
      });
      const result = await callLLM({ messages });

      // сохраняем результат
      await put(`results/${job.id}.json`, JSON.stringify({ ok:true, result }), { access:'private', contentType:'application/json' });

      // чистим исходники
      for(const f of job.files){ await del(f.key).catch(()=>{}); }

      // завершаем job
      job.status = 'done';
      job.finishedAt = iso(new Date());
      await put(`jobs/${job.id}.json`, JSON.stringify(job), { access:'private', contentType:'application/json' });
    } catch(e){
      job.status = 'error';
      job.error = e.message || 'processing error';
      await put(`jobs/${job.id}.json`, JSON.stringify(job), { access:'private', contentType:'application/json' });
    }
  }

  return new Response(JSON.stringify({ ok:true, processed: matured.map(j=>j.id) }), { status:200, headers:{ 'content-type':'application/json; charset=utf-8' } });
}
