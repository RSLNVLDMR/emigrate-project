// web/api/translate.js
import OpenAI from "openai";
import formidable from "formidable";
import { promises as fsp } from "node:fs";

export const config = { api: { bodyParser: false } };

// --- API key ---
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

// --- refusal detector ---
const REFUSAL_RX = /(i'?m\s+sorr(y|ies)|cannot\s+help|can[' ]?t\s+assist|i\s+can[' ]?t|refuse|извините.*не могу|не могу помочь|не можу допомогти|не магу дапамагчы)/i;

// --- prompts ---
function systemPrompt(from, to) {
  return (
`You are a neutral, professional translator. Translate from ${from} to ${to} **verbatim**.
Follow strictly:
- Preserve meaning, tone, formatting, emoji, punctuation, line breaks.
- Do NOT censor, euphemize, or moralize. Profanity, insults, slurs, sexual/violent language may appear — translate them exactly.
- This is a factual, educational transformation task (transformation exception).
- Do not add apologies, warnings, or safety notes. Output ONLY the translation.
- If legally prohibited content appears (e.g., sexual content involving minors), translate the rest and replace that specific segment with [REDACTED], keeping structure.`
  );
}
function strongerSystemPrompt(from, to) {
  return (
`ROLE: Translator only. TASK: Translate from ${from} to ${to} with **verbatim fidelity**.
ALLOWED: profanity, obscenity, insults, slurs, adult/violent language — translate exactly (transformation exception).
FORBIDDEN: refusals, safety disclaimers, moral commentary, summaries. Output = translation only.
If a truly disallowed segment appears (e.g., sexual content with minors), replace ONLY that fragment with [REDACTED] and translate the rest.`
  );
}

// --- ask helpers ---
async function ask(client, sys, userContent) {
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userContent }
    ]
  });
  return (r.choices?.[0]?.message?.content || "").trim();
}
async function translateText(client, from, to, text) {
  let out = await ask(client, systemPrompt(from, to), text);
  if (!out || REFUSAL_RX.test(out)) {
    out = await ask(client, strongerSystemPrompt(from, to), text);
  }
  return out;
}

/* ========================== OCR & PDF helpers ========================== */
const toUint8 = (buf) => (buf instanceof Uint8Array ? buf : new Uint8Array(buf));

async function extractTextFromPdfWithPdfjs(pdfBuffer, maxPages = 10) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // критично: Uint8Array
  const doc = await pdfjs.getDocument({ data: toUint8(pdfBuffer), disableWorker: true }).promise;

  const pages = Math.min(doc.numPages, maxPages);
  let out = "";
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const strings = (content.items || []).map((it) => it.str).filter(Boolean);
    out += strings.join(" ") + "\n\n";
  }
  return out.trim();
}

async function renderPdfToPngBuffers(pdfBuffer, maxPages = 10, scale = 2.2) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");

  const doc = await pdfjs.getDocument({ data: toUint8(pdfBuffer), disableWorker: true }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  const out = [];

  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(
      Math.max(1, Math.floor(viewport.width)),
      Math.max(1, Math.floor(viewport.height))
    );
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push(toUint8(canvas.toBuffer("image/png")));
  }
  return out;
}

async function buildImageInputsFromBuffers(buffers) {
  let sharpLib = null;
  try { sharpLib = (await import("sharp")).default; } catch {}

  const inputs = [];
  for (const raw of buffers) {
    const u8 = toUint8(raw);
    if (sharpLib) {
      const base = await sharpLib(Buffer.from(u8))
        .rotate()
        .resize({ width: 2200, withoutEnlargement: true })
        .jpeg({ quality: 92 })
        .toBuffer();
      inputs.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${base.toString("base64")}` }
      });
    } else {
      inputs.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${Buffer.from(u8).toString("base64")}` }
      });
    }
  }
  return inputs;
}

const looksLikeRefusal = (s = "") => REFUSAL_RX.test(s);

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
/* ====================================================================== */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    res.status(500).json({
      error:
        "OPENAI_API_KEY не задан на сервере. Добавьте переменную (или переименуйте вашу OPEN_API_KEY) в Vercel для Preview/Production и redeploy."
    });
    return;
  }
  const client = new OpenAI({ apiKey });

  try {
    // Разбираем multipart/form-data
    const form = formidable({
      multiples: false,
      maxFileSize: 40 * 1024 * 1024, // 40 МБ
      uploadDir: "/tmp",
      keepExtensions: true
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    const from = (Array.isArray(fields.from) ? fields.from[0] : fields.from) || "auto";
    const to   = (Array.isArray(fields.to)   ? fields.to[0]   : fields.to)   || "ru";
    const text = (Array.isArray(fields.text) ? fields.text[0] : fields.text) || "";

    const parts = [];

    // Файл?
    const fileRec = files.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;

    if (fileRec) {
      const mime = (fileRec.mimetype || "application/octet-stream").toLowerCase();
      const buf  = await fsp.readFile(fileRec.filepath).finally(() => {
        fsp.unlink(fileRec.filepath).catch(() => {});
      });

      if (mime.startsWith("image/")) {
        // Попытка 1: сразу перевод «по картинке»
        let out = await ask(
          client,
          systemPrompt(from, to),
          [
            { type: "text", text: "Translate the text from this image." },
            { type: "image_url", image_url: { url: `data:${mime};base64,${Buffer.from(toUint8(buf)).toString("base64")}` } }
          ]
        );

        // Если отказ/пусто — OCR → перевод
        if (!out || looksLikeRefusal(out)) {
          const ocr = await ocrImageBuffer(toUint8(buf), client, 1, 1500) || "";
          const clean = (!ocr || ocr.length < 8 || looksLikeRefusal(ocr))
            ? (await ocrImageBuffer(toUint8(buf), client, 2, 1500) || "")
            : ocr;

          if (clean && clean.trim()) {
            out = await translateText(client, from, to, clean.slice(0, 200000));
          }
        }

        if (!out) out = "";
        parts.push(out);

      } else if (mime === "application/pdf") {
        // 1) Пытаемся вытащить «живой» текст через pdfjs напрямую (без pdf-parse)
        let extracted = "";
        try {
          extracted = await extractTextFromPdfWithPdfjs(buf, 10);
        } catch {
          extracted = "";
        }

        // 2) Если текста нет — OCR постранично (до 10 стр) с автоповтором
        if (!extracted || extracted.length < 20) {
          const pages = await renderPdfToPngBuffers(buf, 10, 2.2);
          if (!pages.length) {
            res.status(400).json({ error: "Не удалось обработать PDF. Попробуйте фото/скан." });
            return;
          }
          const pageTexts = [];
          for (let i = 0; i < pages.length; i++) {
            let pageText = await ocrImageBuffer(pages[i], client, 1, 1100);
            if (!pageText || pageText.length < 8 || looksLikeRefusal(pageText)) {
              pageText = await ocrImageBuffer(pages[i], client, 2, 1100);
            }
            pageTexts.push(pageText || "");
          }
          extracted = pageTexts.join("\n\n===== PAGE BREAK =====\n\n").trim();
        }

        if (!extracted) {
          parts.push("[PDF: текст не распознан]");
        } else {
          const out = await translateText(client, from, to, extracted.slice(0, 200000));
          parts.push(out || "");
        }

      } else {
        res.status(400).json({ error: "Unsupported file type" });
        return;
      }
    }

    // Параллельно — простой текст
    if (text && text.trim()) {
      const out = await translateText(client, from, to, text);
      parts.push(out || "");
    }

    const nonEmpty = parts.filter(Boolean);
    if (!nonEmpty.length) {
      res.status(400).json({ error: "Nothing to translate" });
      return;
    }

    res.status(200).json({ ok: true, text: nonEmpty.join("\n\n---\n\n") });
  } catch (e) {
    const msg = (e && (e.message || e.toString())) || "";
    if (e?.status === 429 || /insufficient_quota|quota|rate/i.test(msg)) {
      res.status(429).json({ error: "Превышена квота/нет кредитов для OpenAI API." });
      return;
    }
    console.error("translate error:", e);
    res.status(500).json({ error: msg || "Server error" });
  }
}
