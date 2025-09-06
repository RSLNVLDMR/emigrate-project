// /api/translate.js
import OpenAI from "openai";
import formidable from "formidable";
import { promises as fsp } from "node:fs";
import pdfParse from "pdf-parse";

// для совместимости с next/v0: отключаем встроенный bodyParser
export const config = { api: { bodyParser: false } };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    // 1) Разбираем multipart/form-data
    const form = formidable({
      multiples: false,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      uploadDir: "/tmp",
      keepExtensions: true
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
    });

    const from = (Array.isArray(fields.from) ? fields.from[0] : fields.from) || "auto";
    const to   = (Array.isArray(fields.to)   ? fields.to[0]   : fields.to)   || "ru";
    const text = (Array.isArray(fields.text) ? fields.text[0] : fields.text) || "";

    const parts = [];

    // 2) Если пришёл файл — обработаем
    const fileRec = files.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;

    if (fileRec) {
      const mime = fileRec.mimetype || "application/octet-stream";
      const buf  = await fsp.readFile(fileRec.filepath).finally(() => {
        fsp.unlink(fileRec.filepath).catch(() => {});
      });

      if (mime.startsWith("image/")) {
        // OCR + перевод через Chat Completions (мультимодальный ввод)
        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

        const completion = await openai.chat.completions.create({
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

        parts.push(completion.choices?.[0]?.message?.content?.trim() || "");
      } else if (mime === "application/pdf") {
        // Извлечение текста + перевод
        const parsed = await pdfParse(buf);
        const pdfText = (parsed.text || "").trim();

        if (pdfText) {
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: `Translate the text from ${from} to ${to}. Keep layout where reasonable. Return only the translated text.` },
              { role: "user",   content: pdfText.slice(0, 200000) } // страховка по объёму
            ]
          });
          parts.push(completion.choices?.[0]?.message?.content?.trim() || "");
        } else {
          parts.push("[PDF: не удалось извлечь текст (похоже на скан без текстового слоя). Попробуйте загрузить фото/скрин страницы.]");
        }
      } else {
        res.status(400).json({ error: "Unsupported file type" });
        return;
      }
    }

    // 3) Перевод plain-текста (если был)
    if (text && text.trim()) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `Translate the text from ${from} to ${to}. Preserve line breaks and lists. Return only the translated text.` },
          { role: "user",   content: text }
        ]
      });
      parts.push(completion.choices?.[0]?.message?.content?.trim() || "");
    }

    if (parts.length === 0) {
      res.status(400).json({ error: "Nothing to translate" });
      return;
    }

    res.status(200).json({ ok: true, text: parts.filter(Boolean).join("\n\n---\n\n") });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Server error" });
  }
}
