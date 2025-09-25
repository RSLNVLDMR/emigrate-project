// web/api/pdf-ocr-preview.js
import formidable from "formidable";
import { promises as fsp } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import OpenAI from "openai";

export const config = { runtime: "nodejs", api: { bodyParser: false } };

// ==== pdfjs worker (file:// URL)
const require = createRequire(import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")
).href;

// ==== константы
const MAX_UPLOAD = 35 * 1024 * 1024;         // поднимаем до 35 MB
const MAX_TEXT_PAGES = 10;                   // для pdfjs текста
const MAX_RENDER_PAGES_PREVIEW = 3;          // превью-сливка
const MAX_RENDER_PAGES_OCR = 10;             // оцифровка страниц
const BATCH_PAYLOAD_BUDGET = 45 * 1024 * 1024; // ~45MB на vision-запрос (запас к 50MB)
const head = (s, n = 600) => (s || "").slice(0, n);

// ==== utils
function copyU8(view) {
  const src = view instanceof Uint8Array ? view : new Uint8Array(view);
  const out = new Uint8Array(src.byteLength);
  out.set(src);
  return out;
}
function toU8(x) {
  if (!x) return new Uint8Array();
  if (Buffer.isBuffer(x)) return copyU8(x);
  if (x instanceof Uint8Array) return copyU8(x);
  if (x instanceof ArrayBuffer) return copyU8(new Uint8Array(x));
  return copyU8(new Uint8Array(x));
}
function getApiKey() {
  return (
    process.env.OPENAI_API_KEY ||
    process.env.OPEN_API_KEY ||
    process.env.OPEN_AI_KEY ||
    process.env.OPENAI_KEY ||
    process.env.OPENAI ||
    ""
  );
}
const looksLikeRefusal = (s = "") =>
  /(i'?m\s+sorr(y|ies)|cannot\s+help|can[' ]?t\s+assist|i\s+can[' ]?t|refuse|извините.*не могу|не могу помочь|не можу допомогти|не магу дапамагчы)/i.test(
    s
  );

// ==== form
async function parseForm(req) {
  const form = formidable({
    multiples: false,
    maxFileSize: MAX_UPLOAD,
    uploadDir: "/tmp",
    keepExtensions: true,
  });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) =>
      err ? reject(err) : resolve({ fields, files })
    );
  });
}

// ==== быстрый парс текста
async function tryPdfParse(buf) {
  try {
    const mod = await import("pdf-parse");
    const pdfParse = mod.default || mod;
    const parsed = await pdfParse(buf);
    return (parsed.text || "").trim();
  } catch {
    return "";
  }
}
async function pdfjsText(u8, maxPages = MAX_TEXT_PAGES) {
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  let all = "";
  for (let i = 1; i <= pages; i++) {
    const p = await doc.getPage(i);
    const t = await p.getTextContent();
    all += t.items.map((it) => it.str).join("\n") + "\n";
  }
  return { text: all.trim(), pagesTried: pages, totalPages: doc.numPages };
}

// ==== рендер страниц
async function renderPages(u8, maxPages = 5, scale = 2.0) {
  const doc = await pdfjsLib.getDocument({ data: toU8(u8) }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  const pngs = [];
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(
      Math.max(1, Math.floor(viewport.width)),
      Math.max(1, Math.floor(viewport.height))
    );
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    pngs.push(canvas.toBuffer("image/png"));
  }
  return { pngs, pages };
}

async function mergeVerticallyJPEG(pngs) {
  if (!pngs.length) return { merged: null, count: 0 };
  const metas = await Promise.all(pngs.map((b) => sharp(b).metadata()));
  const width = Math.max(...metas.map((m) => m.width || 1));
  let totalH = 0;
  const composite = [];
  for (let i = 0; i < pngs.length; i++) {
    const h = metas[i].height || 1;
    composite.push({ input: pngs[i], top: totalH, left: 0 });
    totalH += h;
  }
  const base = sharp({
    create: { width, height: totalH, channels: 3, background: { r: 255, g: 255, b: 255 } },
  });
  const merged = await base.composite(composite).jpeg({ quality: 85 }).toBuffer();
  return { merged: await sharp(merged).rotate().jpeg({ quality: 85 }).toBuffer(), count: pngs.length };
}

// ==== предобработка для OCR
async function preprocessForOCR(buf, { handwriting = false } = {}) {
  let img = sharp(buf).rotate();
  if (handwriting) {
    img = img
      .grayscale()
      .normalise()
      .gamma(1.2)
      .threshold(180)
      .sharpen();
    return await img.png().toBuffer(); // PNG лучше хранит штрихи
  } else {
    return await img
      .resize({ width: 2200, withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
  }
}

// ==== тайлирование 2×2 с перекрытием
async function tileImage(buf) {
  const meta = await sharp(buf).metadata();
  const W = meta.width || 1, H = meta.height || 1;
  const ox = Math.floor(W * 0.10), oy = Math.floor(H * 0.10);
  const wHalf = Math.floor(W / 2), hHalf = Math.floor(H / 2);
  const tiles = [
    { left: 0,        top: 0,         width: wHalf + ox,      height: hHalf + oy },
    { left: wHalf-ox, top: 0,         width: W-(wHalf-ox),     height: hHalf + oy },
    { left: 0,        top: hHalf-oy,  width: wHalf + ox,      height: H-(hHalf-oy) },
    { left: wHalf-ox, top: hHalf-oy,  width: W-(wHalf-ox),     height: H-(hHalf-oy) },
  ];
  const outs = [];
  for (const t of tiles) {
    outs.push(await sharp(buf).extract(t).toBuffer());
  }
  return outs;
}

// ==== оценка лимита батча
function batchFitsLimit(buffers) {
  const approx = buffers.reduce((a, b) => a + Math.ceil(b.length * 1.37), 0);
  return approx < BATCH_PAYLOAD_BUDGET;
}

// ==== OCR батчем
async function ocrBuffersBatch(buffers, { client, handwriting = false, maxTokens = 1500 }) {
  const inputs = buffers.map((b) => ({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${b.toString("base64")}` },
  }));

  const SYS1 = "You are an OCR engine. Return the visible text as plain UTF-8 text. No summaries, no disclaimers. Output text only.";
  const SYS2 = "You transcribe handwriting and printed documents verbatim. If unreadable, output ???. Keep line breaks and punctuation. Output plain UTF-8 text only.";
  const sys = handwriting ? SYS2 : SYS1;

  const ask = async (systemPrompt) => {
    const r = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: [{ type: "text", text: "Extract plain text from all images exactly as seen, concatenated in reading order." }, ...inputs] },
      ],
    });
    return (r.choices?.[0]?.message?.content || "").trim();
  };

  let out = await ask(sys);
  if (!out || out.length < 8 || looksLikeRefusal(out)) {
    out = await ask(SYS2);
  }
  return out || "";
}

// ==== OCR всех буферов с разбиением на батчи
async function ocrBuffersAll(binaries, { client, handwriting = false, maxTokens = 1500 }) {
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const buf of binaries) {
    const est = Math.ceil(buf.length * 1.37);
    if (cur.length && curBytes + est >= BATCH_PAYLOAD_BUDGET) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(buf);
    curBytes += est;
  }
  if (cur.length) batches.push(cur);

  const parts = [];
  for (const group of batches) {
    const txt = await ocrBuffersBatch(group, { client, handwriting, maxTokens });
    parts.push(txt || "");
  }
  return parts.join("\n\n");
}

// ==== handler
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { fields, files } = await parseForm(req);
    const doOCR = String(fields.do_ocr || "0") === "1";
    const ocrMode = String(fields.ocr_mode || "").toLowerCase(); // 'handwriting' | '' | 'auto'
    const handwriting = ocrMode === "handwriting";

    const fileRec = files?.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;
    if (!fileRec) {
      res.status(400).json({ error: "No file" });
      return;
    }
    if ((fileRec.mimetype || "").toLowerCase() !== "application/pdf") {
      res.status(400).json({ error: "PDF only" });
      return;
    }

    const buf = await fsp.readFile(fileRec.filepath).finally(() =>
      fsp.unlink(fileRec.filepath).catch(() => {})
    );

    // Быстрые способы
    const viaParse = await tryPdfParse(buf);
    const viaPdfjs = await pdfjsText(buf, MAX_TEXT_PAGES);

    // Превью-сливка первых страниц
    const rPrev = await renderPages(buf, MAX_RENDER_PAGES_PREVIEW, 2.0);
    const mergedPrev = await mergeVerticallyJPEG(rPrev.pngs);

    // OCR при необходимости
    let ocrHead = null;
    let ocrVisionLen = 0;
    let pagesRendered = 0;
    let tilesTotal = 0;

    if (doOCR) {
      const apiKey = getApiKey();
      if (!apiKey) {
        ocrHead = "[NO_OPENAI_API_KEY]";
      } else {
        const client = new OpenAI({ apiKey });

        // более глубокий рендер для OCR
        const scale = handwriting ? 3.0 : 2.2;
        const rOcr = await renderPages(buf, MAX_RENDER_PAGES_OCR, scale);
        pagesRendered = rOcr.pages;

        const prepped = [];
        for (const p of rOcr.pngs) {
          const pre = await preprocessForOCR(p, { handwriting });
          if (handwriting) {
            const tiles = await tileImage(pre);
            tilesTotal += tiles.length;
            prepped.push(...tiles);
          } else {
            prepped.push(pre);
          }
        }

        const txt = await ocrBuffersAll(prepped, { client, handwriting, maxTokens: 1400 });
        ocrVisionLen = (txt || "").length;
        ocrHead = head(txt || "");
      }
    }

    res.status(200).json({
      ok: true,
      meta: {
        pdfParseLen: viaParse.length,
        pdfjsLen: viaPdfjs.text.length,
        pdfjsPagesTried: viaPdfjs.pagesTried,
        totalPages: viaPdfjs.totalPages,
        previewRenderedPages: mergedPrev.count,
        previewMergedJpegBytes: mergedPrev.merged ? mergedPrev.merged.length : 0,
        pagesRenderedForOCR: pagesRendered,
        tilesTotalForOCR: tilesTotal,
        ocrVisionLen
      },
      sample: {
        pdfParseHead: head(viaParse),
        pdfjsHead: head(viaPdfjs.text),
        previewMergedDataUrlHead: mergedPrev.merged ? `data:image/jpeg;base64,${mergedPrev.merged.toString("base64").slice(0, 400)}` : null,
        ocrHead
      }
    });
  } catch (e) {
    const msg = e?.message || String(e);
    res.status(500).json({ error: msg || "internal error" });
  }
}
