// web/api/translate.js
import OpenAI from "openai";
import formidable from "formidable";
import { promises as fsp } from "node:fs";

export const config = { api: { bodyParser: false } };

// Читаем ключ из нескольких часто встречающихся имён
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

const REFUSAL_RX = /(i'?m sorry|cannot help|can[' ]?t assist|i can[' ]?t|refuse|извините.*не могу|не могу помочь|не можу допомогти|не магу дапамагчы)/i;

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

async function ask(client, sys, user) {
  const r = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });
  return (r.choices?.[0]?.message?.content || "").trim();
}

async function translateText(client, from, to, text) {
  // Первая попытка
  let out = await ask(client, systemPrompt(from, to), text);

  // Если похоже на отказ — повторяем с более жёсткими инструкциями
  if (!out || REFUSAL_RX.test(out)) {
    out = await ask(client, strongerSystemPrompt(from, to), text);
  }
  return out;
}

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
      maxFileSize: 10 * 1024 * 1024,
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
      const mime = fileRec.mimetype || "application/octet-stream";
      const buf  = await fsp.readFile(fileRec.filepath).finally(() => {
        fsp.unlink(fileRec.filepath).catch(() => {});
      });

      if (mime.startsWith("image/")) {
        // Vision OCR + перевод
        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
        // Сообщение как и для текста — просим «прочитай и переведи содержимое изображения»
        let out = await ask(
          client,
          systemPrompt(from, to),
          [
            { type: "text", text: "Translate the text from this image." },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        );
        if (!out || REFUSAL_RX.test(out)) {
          out = await ask(
            client,
            strongerSystemPrompt(from, to),
            [
              { type: "text", text: "Translate the text from this image." },
              { type: "image_url", image_url: { url: dataUrl } }
            ]
          );
        }
        parts.push(out || "");
      } else if (mime === "application/pdf") {
        // PDF: динамический импорт, чтобы не падать в serverless
        let pdfParse;
        try {
          const mod = await import("pdf-parse");
          pdfParse = mod.default || mod;
        } catch (e) {
          console.error("pdf-parse import failed:", e);
          res.status(501).json({ error: "Парсер PDF недоступен. Загрузите фото/скрин страницы вместо PDF." });
          return;
        }
        try {
          const parsed = await pdfParse(buf);
          const pdfText = (parsed.text || "").trim();
          if (pdfText) {
            const out = await translateText(client, from, to, pdfText.slice(0, 200000));
            parts.push(out || "");
          } else {
            parts.push("[PDF: не удалось извлечь текст (вероятно, скан без текстового слоя). Загрузите фото/скрин страницы.]");
          }
        } catch (e) {
          console.error("pdf-parse error:", e);
          res.status(400).json({ error: "Не удалось извлечь текст из PDF. Попробуйте фото/скрин." });
          return;
        }
      } else {
        res.status(400).json({ error: "Unsupported file type" });
        return;
      }
    }

    // Plain-текст?
    if (text && text.trim()) {
      const out = await translateText(client, from, to, text);
      parts.push(out || "");
    }

    if (!parts.filter(Boolean).length) {
      res.status(400).json({ error: "Nothing to translate" });
      return;
    }

    res.status(200).json({ ok: true, text: parts.filter(Boolean).join("\n\n---\n\n") });
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
