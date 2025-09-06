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
- Дата документа должна быть не старше 12 месяцев.
- Адрес должен включать улицу, номер дома/квартиры, почтовый индекс и город.
- ФИО заявителя должно совпадать с документом/PESEL (если встречается).
- Должны быть подписи сторон и/или печать учреждения для официоза.
- Если есть периоды проживания — укажи начало/конец; начало не может быть в будущем.
- severity: "critical" (недействительно), "major" (нельзя использовать без исправлений), "minor" (косметика).
`,
  lease_standard: `
Тип: обычный договор аренды (umowa najmu).
Критично: адрес, стороны (наймодатель/наниматель), дата/срок, подписи обеих сторон.
Дополнительно: протокол приёма-передачи — опционален.
`,
  lease_okazjonalna: `
Тип: umowa najmu okazjonalnego.
Критично: требования обычного договора + нотариальное заявление о poddaniu się egzekucji, адрес "na wypadek", согласие владельца запасного жилья, подписи/даты на приложениях.
`,
  meldunek: `
Тип: zaświadczenie o zameldowaniu (мелдунек).
Критично: учреждение (UM/UG), данные лица (ФИО/PESEL), адрес, вид (czasowy/stały), даты, печать/номер справки/штрих-код.
`,
  owner: `
Тип: подтверждение адреса собственника.
Критично: документ собственности (KW/акт) + заявление о проживании, совпадение ФИО/адреса, дата и подпись собственника.
`,
  other: `
Тип: другое подтверждение адреса (oświadczenie владельца, заcвидетельствование общежития и т.д.).
Проверь по общим правилам: адрес, стороны, подписи/печати, даты.
`,
};

const OUTPUT_SPEC = `
Верни СТРОГО JSON:
{
  "verdict": "pass" | "fail" | "uncertain",
  "message": "краткое резюме",
  "errors": [{"code": "STRING", "title": "STRING", "detail": "STRING", "severity": "critical|major|minor"}],
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
  }
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
    // 1) multipart/form-data через formidable
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
Ты — помощник-верификатор. Проверь документ подтверждения адреса в Польше.
Правила:
${RULES.common}
Специфика для типа "${docType}":
${RULES[docType] || RULES.other}
Если контента мало/нечитаемо — поставь verdict=uncertain и опиши, какие элементы/страницы переснять.
${OUTPUT_SPEC}
`.trim();

    // 2) Готовим сообщения для модели
    let messages;

    if (mime === "application/pdf") {
      // ⚠️ Динамический импорт pdf-parse — чтобы избежать ENOENT при старте
      let pdfParse;
      try {
        const mod = await import("pdf-parse");
        pdfParse = mod.default || mod;
      } catch (e) {
        console.error("pdf-parse import failed:", e);
        res.status(501).json({ error: "Парсер PDF недоступен. Загрузите фото/скрин вместо PDF." });
        return;
      }

      try {
        const parsed = await pdfParse(buf);
        const pdfText = (parsed.text || "").trim();
        if (!pdfText) {
          res.status(400).json({ error: "Не удалось извлечь текст из PDF (возможно, скан). Загрузите фото/скрин." });
          return;
        }
        messages = [
          { role: "system", content: baseInstruction },
          { role: "user", content: `Вот распознанный текст PDF:\n\n${pdfText.slice(0, 20000)}` },
        ];
      } catch (e) {
        console.error("pdf-parse error:", e);
        res.status(400).json({ error: "Не удалось обработать PDF. Загрузите фото/скрин." });
        return;
      }
    } else if (mime.startsWith("image/")) {
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      messages = [
        { role: "system", content: baseInstruction },
        {
          role: "user",
          content: [
            { type: "text", text: "Проанализируй этот документ по правилам выше и верни СТРОГО JSON по спецификации." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ];
    } else {
      res.status(400).json({ error: "Поддерживаются только фото и PDF" });
      return;
    }

    // 3) Вызов модели с JSON-ответом
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages,
      temperature: 0.2,
    });

    let json;
    try {
      json = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    } catch {
      json = { verdict: "uncertain", message: "Не удалось распарсить ответ модели", errors: [], recommendations: [], fieldsExtracted: {} };
    }

    // sanity defaults
    json.verdict = json.verdict || "uncertain";
    json.errors = Array.isArray(json.errors) ? json.errors : [];
    json.recommendations = Array.isArray(json.recommendations) ? json.recommendations : [];
    json.fieldsExtracted = json.fieldsExtracted || {};

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
