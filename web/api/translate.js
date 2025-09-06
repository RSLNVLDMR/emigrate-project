// web/api/translate.js
import OpenAI from "openai";
import formidable from "formidable";
import { promises as fsp } from "node:fs";

// В некоторых окружениях top-level import "pdf-parse" вызывает чтение test-файла и крашит функцию.
// Поэтому импортируем его динамически ТОЛЬКО при обработке PDF и оборачиваем в try/catch.

// Полезно для Next API routes; в Node Functions не обязательно, но не мешает:
export const config = { api: { bodyParser: false } };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // 1) Разбираем multipart/form-data
    const form = formidable({
      multiples: false,
      maxFileSize: 10 * 1024 * 1024, // 10 MB
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

    // 2) Если пришёл файл — обработаем
    const fileRec = files.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;

    if (fileRec) {
      const mime = fileRec.mimetype || "application/octet-stream";
      const buf  = await fsp.readFile(fileRec.filepath).finally(() => {
        fsp.unlink(fileRec.filepath).catch(() => {});
      });

      if (mime.startsWith("image/")) {
        // OCR + перевод (Vision)
        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

        const r = await client.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a precise translator. Detect source language (${from} if specified) and translate to ${to}. Keep formatting (line breaks, lists). Return only the translation.`
            },
            {
              role: "user",
              content: [
                { type: "text", text: "Read this image document and translate it." },
                { type: "image_url", image_url: { url: dataUrl } }
              ]
            }
          ]
        });

        out.push(r.choices?.[0]?.message?.content?.trim() || "");
      } else if (mime === "application/pdf") {
        // PDF: пробуем подключить парсер ТОЛЬКО здесь
        let pdfParse;
        try {
          const mod = await import("pdf-parse");
          pdfParse = mod.default || mod; // совместимость ESM/CJS
        } catch (e) {
          console.error("pdf-parse import failed:", e);
          res.status(501).json({
            error:
              "Парсер PDF временно недоступен на сервере. Пожалуйста, загрузите фото/скрин страницы вместо PDF."
          });
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
          // типичная проблема: ENOENT на test-файл внутри пакета у некоторых сборок
          console.error("pdf-parse error:", e);
          res.status(400).json({
            error:
              "Не удалось извлечь текст из PDF. Попробуйте загрузить фото/скрин страницы."
          });
          return;
        }
      } else {
        res.status(400).json({ error: "Unsupported file type" });
        return;
      }
    }

    // 3) Перевод plain-текста (если был)
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
    console.error("translate error:", e);
    res.status(500).json({ error: e?.message || "Server error" });
  }
}
