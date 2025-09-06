// web/api/verify-address.js
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

const RULES = {
  common: `
- Принимай документы на PL/RU/UA/BY; встречаются формы: "Umowa najmu", "Zaświadczenie o zameldowaniu".
- Поля для извлечения: ФИО, адрес (улица, дом, кв), индекс PL вида NN-NNN, город; даты (doc_date/valid_from/valid_to); issuer; наличие подписей/печати.
- Если фото под углом/шум — постарайся прочитать ключевые слова-метки ("Data", "Adres", "Miejscowość", "Kod pocztowy", "PESEL", "Wynajmujący", "Najemca", "Urząd").
- severity: critical (недействительно), major (нужно исправить), minor (косметика).
`,
  lease_standard: `
Тип: Umowa najmu (обычная).
Критично: адрес, стороны (Wynajmujący/Najemca), срок/дата, подписи обеих сторон.
`,
  lease_okazjonalna: `
Тип: Umowa najmu okazjonalnego.
Критично: обычные требования + нотариальное заявление (poddanie się egzekucji), адрес "na wypadek", согласие właściciela zapasowego жилья; подписи/даты на приложениях.
`,
  meldunek: `
Тип: Zaświadczenie o zameldowaniu (мелдунек).
Критично: орган (UM/UG), ФИО/PESEL, адрес, вид (czasowy/stały), даты, печать/номер справки/штрих-код.
`,
  owner: `
Тип: Вы — собственник.
Критично: документ собственности (KW/акт) + заявление, совпадение ФИО/адреса, дата и подпись собственника/печать.
`,
  other: `
Тип: Другое подтверждение адреса.
Проверяй по общим правилам: адрес, стороны, подписи/печати, даты.
`,
};

const OUTPUT_SPEC = `
Верни СТРОГО JSON:
{
  "verdict": "pass" | "fail" | "uncertain",
  "message": "краткое резюме",
  "errors": [{"code":"STRING","title":"STRING","detail":"STRING","severity":"critical|major|minor"}],
  "recommendations": ["STRING", ...],
  "fieldsExtracted": {
    "full_name": "STRING|null",
    "address": "STRING|null",
    "postal_code": "STRING|null",
    "city": "STRING|null",
    "doc_date": "YYYY-MM-DD|null",
    "valid_from": "YYYY-MM-DD|null",
    "valid_to": "YYYY-MM-DD|null",
    "issuer": "STRING|null",
    "signatures_present": true|false|null
  },
  "raw_text_excerpt": "STRING|null"
}
Только JSON, без пояснений.
`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY не задан на сервере." });
    return;
  }
  const client = new OpenAI({ apiKey });

  try {
    // multipart/form-data
    const form = formidable({
      multiples: false,
      maxFileSize: 10 * 1024 * 1024,
      uploadDir: "/tmp",
      keepExtensions: true,
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    const docType = (Array.isArray(fields.docType) ? fields.docType[0] : fields.docType) || "other";
    const fileRec = files.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;

    if (!fileRec) {
      res.status(400).json({ error: "Файл не получен" });
      return;
    }

    const buf = await fsp.readFile(fileRec.filepath).finally(() => {
      fsp.unlink(fileRec.filepath).catch(() => {});
    });
    const mime = fileRec.mimetype || "application/octet-stream";

    const baseInstruction = `
Ты — помощник-верификатор. Сначала максимально точно РАСПОЗНАЙ текст (OCR: буквенно-цифровые блоки, индексы NN-NNN, даты dd.mm.yyyy/yyyy-mm-dd), затем оцени корректность по правилам.
Правила:
${RULES.common}
Специфика: ${RULES[docType] || RULES.other}
Если критично нечитабельно — verdict=uncertain и чётко перечисли, какие элементы переснять. ${OUTPUT_SPEC}
`.trim();

    let messages;

    if (mime === "application/pdf") {
      // Пробуем текстовый слой
      let pdfParse;
      try {
        const mod = await import("pdf-parse");
        pdfParse = mod.default || mod;
      } catch (e) {
        console.error("pdf-parse import failed:", e);
      }

      if (pdfParse) {
        try {
          const parsed = await pdfParse(buf);
          const pdfText = (parsed.text || "").trim();
          if (pdfText) {
            messages = [
              { role: "system", content: baseInstruction },
              { role: "user", content: `OCR-текст из PDF:\n\n${pdfText.slice(0, 20000)}` },
            ];
          } else {
            res.status(400).json({ error: "PDF — это скан без текста. Загрузите фото/скрин страницы." });
            return;
          }
        } catch (e) {
          console.error("pdf-parse error:", e);
          res.status(400).json({ error: "Не удалось обработать PDF. Загрузите фото/скрин." });
          return;
        }
      } else {
        res.status(501).json({ error: "Парсер PDF недоступен. Загрузите фото/скрин." });
        return;
      }
    } else if (mime.startsWith("image/")) {
      // Улучшение низкого качества: sharp (динамический импорт)
      let variants = [];
      try {
        const sharp = (await import("sharp")).default;
        // 1) Оригинал — безопасный ресайз и поворот
        const origJpeg = await sharp(buf)
          .rotate() // EXIF
          .resize({ width: 2000, withoutEnlargement: true })
          .jpeg({ quality: 90 })
          .toBuffer();

        // 2) Усиленная версия — для слабого OCR (градации, нормализация, шарп)
        const enhancedJpeg = await sharp(origJpeg)
          .grayscale()
          .normalize()
          .sharpen()
          .jpeg({ quality: 95 })
          .toBuffer();

        variants = [origJpeg, enhancedJpeg];
      } catch (e) {
        console.warn("sharp unavailable, fall back to original image", e?.message);
        variants = [buf];
      }

      const imgs = variants.map((b) => ({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${b.toString("base64")}` },
      }));

      messages = [
        { role: "system", content: baseInstruction },
        {
          role: "user",
          content: [
            { type: "text", text: "Проанализируй документ. Сначала сделай внутренний OCR, затем верни СТРОГО JSON по схеме." },
            ...imgs,
          ],
        },
      ];
    } else {
      res.status(400).json({ error: "Поддерживаются только фото и PDF" });
      return;
    }

    // Модель с лучшим зрением
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages,
      temperature: 0.1,
    });

    let json;
    try {
      json = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    } catch {
      json = { verdict: "uncertain", message: "Не удалось распарсить ответ модели", errors: [], recommendations: [], fieldsExtracted: {}, raw_text_excerpt: null };
    }

    // sanity
    json.verdict = json.verdict || "uncertain";
    json.errors = Array.isArray(json.errors) ? json.errors : [];
    json.recommendations = Array.isArray(json.recommendations) ? json.recommendations : [];
    json.fieldsExtracted = json.fieldsExtracted || {};
    if (!("raw_text_excerpt" in json)) json.raw_text_excerpt = null;

    // Лёгкая нормализация индекса/дат (если модель их положила в message)
    // Дополнительно можно дописать регексы здесь.

    res.status(200).json(json);
  } catch (e) {
    const msg = e?.message || String(e);
    console.error("verify-address error:", e);
    if (e?.status === 429 || /insufficient_quota|quota|rate/i.test(msg)) {
      res.status(429).json({ error: "Превышена квота/нет кредитов для OpenAI API." });
      return;
    }
    res.status(500).json({ error: msg || "Server error" });
  }
}
