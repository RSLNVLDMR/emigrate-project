// web/api/translate.js
import OpenAI from "openai";
import formidable from "formidable";
import { promises as fsp } from "node:fs";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // поддерживаем несколько имён переменных; рекомендуем OPENAI_API_KEY
  const apiKey =
    process.env.OPENAI_API_KEY ||
    process.env.OPEN_API_KEY ||
    process.env.OPEN_AI_KEY ||
    process.env.OPENAI_KEY ||
    process.env.OPENAI;

  if (!apiKey) {
    res.status(500).json({
      error:
        "OPENAI_API_KEY не задан на сервере. Добавьте переменную в Vercel → Project → Settings → Environment Variables (Preview/Production) и redeploy."
    });
    return;
  }

  const client = new OpenAI({ apiKey });

  try {
    // 1) multipart/form-data
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

    const out = [];

    // 2) файл (если есть)
    const fileRec = files.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;

    if (fileRec) {
      const mime = fileRec.mimetype || "application/octet-stream";
      const buf  = await fsp.readFile(fileRec.filepath).finally(() => {
        fsp.unlink(fileRec.filepath).catch(() => {});
      });

      if (mime.startsWith("image/")) {
        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
        const r = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: `You are a precise translator. Detect source language (${from} if specified) and translate to ${to}. Keep formatting; return only the translation.` },
            { role: "user", content: [ { type: "text", text: "Read this image document and translate it." }, { type: "image_url", image_url: { url: dataUrl } } ] }
          ]
        });
        out.push(r.choices?.[0]?.message?.content?.trim() || "");
      } else if (mime === "application/pdf") {
        // динамический импорт pdf-parse, чтобы избежать крашей при старте
        let pdfParse;
        try {
          const mod = await import("pdf-parse");
          pdfParse = mod.default || mod;
        } catch (e) {
          console.error("pdf-parse import failed:", e);
          res.status(501).json({ error: "Парсер PDF недоступен на сервере. Загрузите фото/скрин вместо PDF." });
          return;
        }
        try {
          const parsed = await pdfParse(buf);
          const pdfText = (parsed.text || "").trim();
          if (pdfText) {
            const r = await client.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: `Translate the text from ${from} to ${to}. Keep layout where reasonable. Return only the translated text.` },
                { role: "user",   content: pdfText.slice(0, 200000) }
              ]
            });
            out.push(r.choices?.[0]?.message?.content?.trim() || "");
          } else {
            out.push("[PDF: не удалось извлечь текст (похоже на скан без текстового слоя). Загрузите фото/скрин страницы.]");
          }
        } catch (e) {
          console.error("pdf-parse error:", e);
          res.status(400).json({ error: "Не удалось извлечь текст из PDF. Попробуйте загрузить фото/скрин." });
          return;
        }
      } else {
        res.status(400).json({ error: "Unsupported file type" });
        return;
      }
    }

    // 3) перевод plain-текста
    if (text && text.trim()) {
      const r = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `Translate the text from ${from} to ${to}. Preserve line breaks and lists. Return only the translated text.` },
          { role: "user",   content: text }
        ]
      });
      out.push(r.choices?.[0]?.message?.content?.trim() || "");
    }

    if (!out.length) {
      res.status(400).json({ error: "Nothing to translate" });
      return;
    }

    res.status(200).json({ ok: true, text: out.filter(Boolean).join("\n\n---\n\n") });
  } catch (e) {
    // дружелюбная обработка лимитов/квоты
    const msg = (e && (e.message || e.toString())) || "";
    const code = e?.status || e?.code || "";
    if (e?.status === 429 || /insufficient_quota|quota|rate/i.test(msg)) {
      res.status(429).json({
        error:
          "Превышена квота/нет кредитов на OpenAI API. Пополните баланс в Billing и повторите запрос. (Подробнее см. в документации к ошибке 429.)"
      });
      return;
    }

    console.error("translate error:", e);
    res.status(500).json({ error: msg || "Server error" });
  }
}
