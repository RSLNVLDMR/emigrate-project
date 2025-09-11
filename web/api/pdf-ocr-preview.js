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

// pdfjs worker (file:// URL)
const require = createRequire(import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")
).href;

// --- utils
const head = (s, n = 400) => (s || "").slice(0, n);
function copyU8(view) {
  const out = new Uint8Array(view.byteLength);
  out.set(view instanceof Uint8Array ? view : new Uint8Array(view));
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

// --- form
async function parseForm(req) {
  const form = formidable({
    multiples: false,
    maxFileSize: 40 * 1024 * 1024,
    uploadDir: "/tmp",
    keepExtensions: true,
  });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) =>
      err ? reject(err) : resolve({ fields, files })
    );
  });
}

// --- text extraction
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
async function pdfjsText(u8, maxPages = 10) {
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

// --- render
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

// --- optional OCR first page
async function ocrFirstPage(pngBuf, client) {
  const sys =
    "You are an OCR engine. Return the visible text as plain UTF-8 text. No summaries, no warnings. Output text only.";
  const dataUrl = `data:image/png;base64,${pngBuf.toString("base64")}`;
  const completion = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    max_tokens: 1000,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [
        { type: "text", text: "Extract plain text from the image exactly as seen." },
        { type: "image_url", image_url: { url: dataUrl } }
      ]},
    ],
  });
  const out = (completion.choices?.[0]?.message?.content || "").trim();
  return looksLikeRefusal(out) ? "" : out;
}

// --- handler
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { fields, files } = await parseForm(req);
    const doOCR = String(fields.do_ocr || "0") === "1";
    const fileRec = files?.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;
    if (!fileRec) {
      res.status(400).json({ error: "No file" });
      return;
    }
    if ((fileRec.mimetype || "").toLowerCase() !== "application/pdf") {
      res.status(400).json({ error: "PDF only" });
      return;
    }

    const buf = await fsp.readFile(fileRec.filepath).finally(() => fsp.unlink(fileRec.filepath).catch(() => {}));

    const viaParse = await tryPdfParse(buf);
    const viaPdfjs = await pdfjsText(buf, 10);
    const render = await renderPages(buf, 3, 2.0);

    let ocrHead = null;
    if (doOCR && render.merged) {
      // перерендерим только 1-ю страницу
      const doc = await pdfjsLib.getDocument({ data: toU8(buf) }).promise;
      const p1 = await doc.getPage(1);
      const vp = p1.getViewport({ scale: 2.0 });
      const canvas = createCanvas(Math.max(1, Math.floor(vp.width)), Math.max(1, Math.floor(vp.height)));
      const ctx = canvas.getContext("2d");
      await p1.render({ canvasContext: ctx, viewport: vp }).promise;
      const firstPng = canvas.toBuffer("image/png");

      const apiKey = getApiKey();
      if (!apiKey) {
        ocrHead = "[NO_OPENAI_API_KEY]";
      } else {
        const client = new OpenAI({ apiKey });
        const txt = await ocrFirstPage(firstPng, client);
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
        renderedPages: render.count,
        mergedJpegBytes: render.merged ? render.merged.length : 0
      },
      sample: {
        pdfParseHead: head(viaParse),
        pdfjsHead: head(viaPdfjs.text),
        mergedJpegDataUrlHead: render.merged ? `data:image/jpeg;base64,${render.merged.toString("base64").slice(0, 400)}` : null,
        ocrFirstPageHead: ocrHead
      }
    });
  } catch (e) {
    const msg = e?.message || String(e);
    res.status(500).json({ error: msg || "internal error" });
  }
}
