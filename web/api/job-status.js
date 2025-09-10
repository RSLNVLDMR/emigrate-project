import { get, put, del } from '@vercel/blob';
import OpenAI from 'openai';
import sharp from 'sharp';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// ---- OpenAI key (любой из перечисленных)
function envApiKey() {
  return process.env.OPENAI_API_KEY
      || process.env.OPEN_API_KEY
      || process.env.OPEN_AI_KEY
      || process.env.OPENAI_KEY
      || process.env.OPENAI;
}
const openai = new OpenAI({ apiKey: envApiKey() });

// ---- pdfjs worker под Node
pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');

// ---- helpers
const toU8 = (buf) => (buf instanceof Uint8Array ? buf : new Uint8Array(buf));
const iso = (d) => new Date(d).toISOString();

async function fetchJson(key){
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
  let all = '';
  for(let i=1;i<=doc.numPages;i++){
    const page = await doc.getPage(i);
    const txt = await page.getTextContent();
    all += txt.items.map(it=>it.str).join('\n') + '\n';
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
  for(const im of imgs){ ctx.drawImage(im, 0, y); y+=im.height; }
  const jpg = canvas.toBuffer('image/jpeg', { quality: 0.9 });
  return await sharp(jpg).rotate().jpeg({ quality: 85 }).toBuffer();
}
async function pdfRenderMergedJPEG(u8){
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const images = [];
  for(let i=1;i<=doc.numPages;i++){
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    images.push(canvas.toBuffer('image/png'));
  }
  return await mergeImagesVertically(images);
}

async function processJob(job){
  // 1) Собрать входные данные (PDF или изображения)
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
    for(let i=0;i<buffers.length;i++){
      buffers[i] = await sharp(buffers[i]).rotate().jpeg({ quality:85 }).toBuffer();
    }
    mergedJPEG = await mergeImagesVertically(buffers);
  }

  const mergedDataUrl = mergedJPEG ? `data:image/jpeg;base64,${mergedJPEG.toString('base64')}` : null;

  // 2) Подготовить подсказки/правила
  // Храним рядом в /web/rules/ :
  // - prompt.base.txt
  // - schema.verify.json
  // - doc_rules.json
  // Чтобы не читать FS в serverless (медленно), кладём их как "static" через fetch.
  // Но для совместимости используем инлайн-минимум:
  const basePrompt = [
    'Ты — AI-проверяющий формальностей.',
    'Строго возвращай JSON под предоставленную схему.',
    'Не отказывайся, не добавляй комментарии вне JSON.'
  ].join(' ');
  const schema = {
    "$schema":"https://json-schema.org/draft/2020-12/schema",
    "type":"object",
    "properties":{
      "docType":{"type":"string"},
      "fieldsExtracted":{"type":"object"},
      "checks":{"type":"array","items":{
        "type":"object",
        "properties":{
          "key":{"type":"string"},
          "title":{"type":"string"},
          "passed":{"type":"boolean"},
          "details":{"type":"string"},
          "fixTip":{"type":"string"}
        },
        "required":["key","title","passed"]
      }},
      "verdict":{"type":"object","properties":{
        "status":{"type":"string","enum":["pass","fail","uncertain"]},
        "summary":{"type":"string"}
      },"required":["status"]},
      "advice":{"type":"array","items":{"type":"string"}}
    },
    "required":["docType","checks","verdict"]
  };

  const rulesForType = { // минимальный набор, расширим из /rules позже
    docType: job.docType,
    checks: [
      { key:"file_readable", title:"Файл читается", required:true },
      { key:"has_signatures", title:"Есть подписи/печати при необходимости", required:false },
      { key:"dates_valid", title:"Актуальные даты/сроки", required:true }
    ]
  };

  const messages = [
    { role:'system', content: basePrompt },
    { role:'user', content: [
      { type:'text', text:
`docType: ${job.docType}
citizenship: ${job.citizenship||'unknown'}
path: ${job.path||'general'}
applicationDate: ${job.applicationDate||new Date().toISOString().slice(0,10)}
Return STRICT JSON per schema.` },
      { type:'text', text: `SCHEMA:\n${JSON.stringify(schema)}` },
      { type:'text', text: `CHECKLIST FOR TYPE:\n${JSON.stringify(rulesForType, null, 2)}` },
      ...(ocrText ? [{ type:'text', text:`OCR_TEXT:\n${ocrText.slice(0,20000)}` }] : []),
      ...(mergedDataUrl ? [{ type:'image_url', image_url:{ url: mergedDataUrl } }] : [])
    ] }
  ];

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

  // Сохраняем результат
  await put(`results/${job.id}.json`, JSON.stringify({ ok:true, result: json }), { access:'private', contentType:'application/json' });

  // Чистим загруженные файлы
  for(const f of job.files){ await del(f.key).catch(()=>{}); }

  // Обновляем статус job
  job.status = 'done';
  job.finishedAt = iso(new Date());
  await put(`jobs/${job.id}.json`, JSON.stringify(job), { access:'private', contentType:'application/json' });

  return json;
}

export default async function handler(req, res){
  try{
    const url = new URL(req.url, 'http://localhost');
    const jobId = url.searchParams.get('jobId') || (req.query && req.query.jobId);
    if(!jobId){
      res.status(400).json({ error: 'jobId required' });
      return;
    }

    const job = await fetchJson(`jobs/${jobId}.json`);
    if(!job){
      res.status(404).json({ error: 'job not found' });
      return;
    }

    // Если уже готово — отдаем сразу
    if(job.status === 'done'){
      const rst = await fetchJson(`results/${job.id}.json`);
      res.status(200).json({ status:'done', result: rst?.result });
      return;
    }

    // «Ленивая» обработка: если время созрело — запускаем прямо сейчас
    const now = Date.now();
    const due = new Date(job.runAt).getTime() <= now;
    if(job.status === 'queued' && due){
      // фиксируем статус, чтобы вторые клики не гоняли повторно
      job.status = 'processing';
      await put(`jobs/${job.id}.json`, JSON.stringify(job), { access:'private', contentType:'application/json' });

      try{
        const result = await processJob(job);
        res.status(200).json({ status:'done', result });
      }catch(err){
        job.status = 'error';
        job.error = err.message || 'processing error';
        await put(`jobs/${job.id}.json`, JSON.stringify(job), { access:'private', contentType:'application/json' });
        res.status(500).json({ status:'error', error: job.error });
      }
      return;
    }

    // Иначе просто сообщаем текущий статус
    res.status(200).json({ status: job.status || 'queued', runAt: job.runAt });
  } catch (e){
    res.status(500).json({ error: e.message || 'internal error' });
  }
}
