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

// ---- helpers: pdf render + combine + vision inputs ----
async function renderPdfToPngBuffers(pdfBuffer, maxPages = 10, scale = 2.2) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const doc = await pdfjs.getDocument({ data: pdfBuffer, disableWorker: true }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  const out = [];
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push(canvas.toBuffer("image/png"));
  }
  return out;
}

async function combineBuffersVerticallyToJpeg(buffers) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const images = [];
  let width = 0, height = 0;
  for (const b of buffers) {
    const img = await loadImage(b);
    images.push(img);
    width = Math.max(width, img.width);
    height += img.height;
  }
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  let y = 0;
  for (const img of images) {
    ctx.drawImage(img, 0, y);
    y += img.height;
  }
  return canvas.toBuffer("image/jpeg", { quality: 0.92 });
}

async function buildImageInputsFromBuffers(buffers) {
  let sharpLib = null;
  try { sharpLib = (await import("sharp")).default; } catch {}
  const inputs = [];
  for (const buf of buffers) {
    if (sharpLib) {
      const base = await sharpLib(buf).rotate().resize({ width: 2400, withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
      inputs.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base.toString("base64")}` } });
    } else {
      inputs.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}` } });
    }
  }
  return inputs;
}

// ---- handler ----
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
      form.parse(req, (err, _fields, fls) => (err ? reject(err) : resolve({ files: fls })));
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
      // 1) пробуем «живой» текст
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

      // 2) если текста нет — Vision OCR по склеенному JPEG (до 10 страниц)
      if (!text) {
        const pages = await renderPdfToPngBuffers(buf, 10, 2.2);
        if (!pages.length) return res.status(400).json({ error: "Не удалось отрендерить PDF." });
        const combinedJpeg = await combineBuffersVerticallyToJpeg(pages);
        const images = await buildImageInputsFromBuffers([combinedJpeg]);

        const completion = await client.chat.completions.create({
          model: "gpt-4o",
          temperature: 0,
          max_tokens: 2000,
          messages: [
            { role: "system", content: "You are an OCR engine. Return the visible text as plain UTF-8 text. No JSON, no explanations." },
            { role: "user", content: [{ type: "text", text: "Extract plain text from the image." }, ...images] }
          ]
        });
        text = (completion.choices?.[0]?.message?.content || "").trim();
        mode = "pdf-vision";
      }
    } else if (mime.startsWith("image/")) {
      // OCR для изображений
      const images = await buildImageInputsFromBuffers([buf]);
      const completion = await client.chat.completions.create({
        model: "gpt-4o",
        temperature: 0,
        max_tokens: 1500,
        messages: [
          { role: "system", content: "You are an OCR engine. Return the visible text as plain UTF-8 text. No JSON, no explanations." },
          { role: "user", content: [{ type: "text", text: "Extract plain text from the image." }, ...images] }
        ]
      });
      text = (completion.choices?.[0]?.message?.content || "").trim();
      mode = "image-vision";
    } else {
      return res.status(400).json({ error: "Поддерживаются PDF и изображения" });
    }

    if (!text) return res.status(422).json({ error: "Текст не распознан" });

    const excerpt = text.slice(0, 1200);
    res.status(200).json({
      ok: true,
      mode,
      chars: text.length,
      excerpt
    });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error("pdf-ocr-preview error:", e);
    if (e?.status === 429 || /quota|rate/i.test(msg)) return res.status(429).json({ error: "Превышена квота OpenAI API." });
    res.status(500).json({ error: msg || "Server error" });
  }
}
