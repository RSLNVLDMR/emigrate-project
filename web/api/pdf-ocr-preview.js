// web/api/pdf-ocr-preview.js
import OpenAI from "openai";
import formidable from "formidable";
import { promises as fsp } from "node:fs";

export const config = { api: { bodyParser: false } };

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

// ---------- small utils ----------
function looksLikeRefusal(s = "") {
  return /i'?m\s+sorr(y|ies)|can('?|no)t\s+(assist|help)|unable\s+to\s+assist|cannot\s+comply|refus/i.test(s);
}
function toUint8(buf) {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

// ---------- PDF render helpers (server-side) ----------
async function renderPdfToPngBuffers(pdfBuffer, maxPages = 10, scale = 2.2) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");

  const doc = await pdfjs.getDocument({ data: toUint8(pdfBuffer), disableWorker: true }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  const out = [];

  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push(canvas.toBuffer("image/png"));
  }
  return out;
}

// ---------- Vision inputs ----------
async function buildImageInputsFromBuffers(buffers) {
  let sharpLib = null;
  try { sharpLib = (await import("sharp")).default; } catch {}
  const inputs = [];
  for (const buf of buffers) {
    if (sharpLib) {
      const base = await sharpLib(buf).rotate().resize({ width: 2200, withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
      inputs.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base.toString("base64")}` } });
    } else {
      inputs.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}` } });
    }
  }
  return inputs;
}

// ---------- Single-page OCR with retry-on-refusal ----------
async function ocrImageBuffer(buf, client, variant = 1, maxTokens = 1500) {
  const images = await buildImageInputsFromBuffers([buf]);

  const SYSTEM1 =
    "You are an OCR engine. Return the visible text as plain UTF-8 text. Do not summarize, do not add disclaimers. Output text only.";
  const SYSTEM2 =
    "You transcribe user-provided documents verbatim for accessibility and translation. The text may include profanity or sensitive language. Return plain UTF-8 text only. No summaries, no warnings.";

  const sys = variant === 1 ? SYSTEM1 : SYSTEM2;

  const completion = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [{ type: "text", text: "Extract plain text from the image exactly as seen." }, ...images] }
    ]
  });

  return (completion.choices?.[0]?.message?.content || "").trim();
}

// ---------- Handler ----------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = getApiKey();
  if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY не задан на сервере." });
  const client = new OpenAI({ apiKey });

  try {
    const form = formidable({
      multiples: false,
      maxFileSize: 40 * 1024 * 1024, // до 40 МБ
      uploadDir: "/tmp",
      keepExtensions: true,
    });

    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (_err, _fields, fls) => (_err ? reject(_err) : resolve({ files: fls })));
    });

    const fileRec = files.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;
    if (!fileRec) return res.status(400).json({ error: "Файл не получен" });

    const buf = await fsp.readFile(fileRec.filepath).finally(() => {
      fsp.unlink(fileRec.filepath).catch(() => {});
    });
    const mime = (fileRec.mimetype || "application/octet-stream").toLowerCase();

    let text = "";
    let mode = "";

    if (mime === "application/pdf") {
      // 1) Прямой текстовый слой
      let pdfParse;
      try {
        const mod = await import("pdf-parse");
        pdfParse = mod.default || mod;
      } catch { pdfParse = null; }

      if (pdfParse) {
        try {
          const parsed = await pdfParse(buf);
          const pdfText = (parsed.text || "").trim();
          if (pdfText && pdfText.length > 10) {
            text = pdfText;
            mode = "pdf-text";
          }
        } catch {}
      }

      // 2) Нет текста — распознаём ПОСТРАНИЧНО Vision (устойчиво к отказам)
      if (!text) {
        const pages = await renderPdfToPngBuffers(buf, 10, 2.2);
        if (!pages.length) return res.status(400).json({ error: "Не удалось отрендерить PDF." });

        const pageTexts = [];
        for (let i = 0; i < pages.length; i++) {
          // Первая попытка
          let pageText = await ocrImageBuffer(pages[i], client, 1, 1100);
          // Если отказ или слишком коротко — повторяем с альтернативной подсказкой
          if (!pageText || pageText.length < 8 || looksLikeRefusal(pageText)) {
            pageText = await ocrImageBuffer(pages[i], client, 2, 1100);
          }
          pageTexts.push(pageText || "");
        }

        text = pageTexts.join("\n\n===== PAGE BREAK =====\n\n").trim();
        mode = "pdf-vision-paged";
      }

    } else if (mime.startsWith("image/")) {
      // Изображения — одна страница, но с повтором при отказе
      let t = await ocrImageBuffer(buf, client, 1, 1500);
      if (!t || t.length < 8 || looksLikeRefusal(t)) {
        t = await ocrImageBuffer(buf, client, 2, 1500);
      }
      text = t || "";
      mode = "image-vision";
    } else {
      return res.status(400).json({ error: "Поддерживаются PDF и изображения" });
    }

    if (!text) return res.status(422).json({ error: "Текст не распознан" });

    const excerpt = text.slice(0, 1200);
    res.status(200).json({ ok: true, mode, chars: text.length, excerpt });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error("pdf-ocr-preview error:", e);
    if (e?.status === 429 || /quota|rate/i.test(msg)) return res.status(429).json({ error: "Превышена квота OpenAI API." });
    res.status(500).json({ error: msg || "Server error" });
  }
}
