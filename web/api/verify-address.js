// api/verify-address.js
import OpenAI from "openai";
import pdf from "pdf-parse";

export const config = {
  api: { bodyParser: false }, // multipart/form-data
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY });

function bad(res, code, error) {
  res.status(code).json({ error });
}

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    let data = Buffer.from([]);
    req.on("data", (chunk) => (data = Buffer.concat([data, chunk])));
    req.on("end", () => {
      // Very small naive multipart reader for Vercel – works because we only need 1 file + fields.
      const ct = req.headers["content-type"] || "";
      const m = ct.match(/boundary=(.+)$/i);
      if (!m) return reject(new Error("No boundary"));
      const boundary = "--" + m[1];
      const parts = data.toString("binary").split(boundary).slice(1, -1);
      let file = null, fields = {};
      for (const part of parts) {
        const [rawHeaders, rawBody] = part.split("\r\n\r\n");
        const headers = rawHeaders.split("\r\n").filter(Boolean);
        const disp = headers.find(h => h.toLowerCase().startsWith("content-disposition")) || "";
        const nameM = disp.match(/name="([^"]+)"/); const filenameM = disp.match(/filename="([^"]*)"/);
        const bodyBin = rawBody.slice(0, -2); // drop trailing \r\n
        if (filenameM && filenameM[1]) {
          const typeH = headers.find(h => h.toLowerCase().startsWith("content-type"));
          file = {
            filename: filenameM[1],
            mimetype: typeH ? typeH.split(":")[1].trim() : "application/octet-stream",
            buffer: Buffer.from(bodyBin, "binary"),
          };
        } else if (nameM) {
          fields[nameM[1]] = bodyBin.toString("utf8");
        }
      }
      resolve({ file, fields });
    });
    req.on("error", reject);
  });
}

const RULES = {
  common: `
- Дата документа должна быть не старше 12 месяцев.
- Адрес должен включать улицу, номер дома/квартиры, почтовый индекс и город.
- ФИО заявителя должно совпадать с данными паспорта/PESEL (если встречается в документе).
- Должны быть подписи сторон и/или печать учреждения, если это официозный документ.
- Если периоды проживания присутствуют — укажите начало/конец и проверьте, что дата начала не в будущем.
- Ошибки классифицируй по severity: "critical" (недействительность документа), "major" (нельзя использовать без исправлений), "minor" (косметика).
`,
  lease_standard: `
Тип: обычный договор аренды (umowa najmu).
Критично:
- Прописан точный адрес арендуемого помещения.
- Присутствуют стороны: наймодатель и наниматель (имена/фамилии, данные документа/PESEL при наличии).
- Дата заключения и срок аренды (или бессрочно).
- Подписи обеих сторон.
Дополнительно:
- Размер аренды необязателен для подтверждения адреса.
- Приложения (protokół zdawczo-odbiorczy) — опционально, но хорошо.
`,
  lease_okazjonalna: `
Тип: umowa najmu okazjonalnego.
Критично:
- Все пункты обычного договора аренды.
- Нотариальное заявление наймателя о подdaniu się egzekucji.
- Указан адрес «na wypadek» для wyprowadzki (владелец третьего жилья + его zgoda).
- Подписи и даты на каждом приложении.
`,
  meldunek: `
Тип: zaświadczenie o zameldowaniu (мелдунек).
Критично:
- Название документа/учреждения (Urząd Gminy/Urząd Miasta).
- Данные лица (ФИО, при наличии дата рождения/PESEL).
- Адрес замельдования.
- Вид замельдования (czasowy/stały) и даты (с ... по .../без срока).
- Печать учреждения и/или штрих-код/номер справки.
`,
  owner: `
Тип: подтверждение адреса собственника.
Критично:
- Документы собственности (например, выписка z księgi wieczystej / akt notarialny) + заявление о проживании по адресу.
- ФИО собственника совпадает с заявителем или есть письменное согласие на проживание.
- Адрес совпадает.
- Дата и подпись собственника.
`,
  other: `
Тип: другое подтверждение адреса (oświadczenie владельца, zaświadczenie от общежития и т.д.).
Проверь по общим правилам: адрес, стороны, подписи/печати, даты.
`,
};

const OUTPUT_SPEC = `
Сформируй СТРОГО JSON:
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
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");
  if (!client.apiKey) return bad(res, 500, "OPENAI_API_KEY не задан на сервере.");

  try {
    const { file, fields } = await readMultipart(req);
    if (!file) return bad(res, 400, "Файл не получен");
    if (file.buffer.length > 10 * 1024 * 1024) return bad(res, 400, "Файл больше 10 МБ");

    const docType = (fields.docType || "other").trim();

    // Получаем текст для анализа: из PDF — текстом; из изображения — через vision.
    let analysisText = null;
    let messages;

    const baseInstruction = `
Ты — помощник-верификатор. Проверь документ подтверждения адреса в Польше.
Правила:
${RULES.common}
Специфика для типа "${docType}":
${RULES[docType] || RULES.other}
Если контента мало/нечитаемо — верни verdict=uncertain и напиши какие страницы/элементы нужно перефотографировать.
${OUTPUT_SPEC}
`;

    if (file.mimetype === "application/pdf") {
      const pdfData = await pdf(file.buffer).catch(() => null);
      analysisText = pdfData?.text?.trim() || "";
      messages = [
        { role: "system", content: baseInstruction },
        { role: "user", content: `Вот распознанный текст PDF:\n\n${analysisText.slice(0, 18000)}` },
      ];
    } else {
      // image — отправляем в vision
      const b64 = file.buffer.toString("base64");
      messages = [
        { role: "system", content: baseInstruction },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Проанализируй этот документ на изображении по правилам выше и верни строго JSON по спецификации." },
            {
              type: "input_image",
              image_url: `data:${file.mimetype};base64,${b64}`
            }
          ]
        }
      ];
    }

    // Модель с JSON-ответом
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages,
      temperature: 0.2,
    });

    let json;
    try { json = JSON.parse(completion.choices[0].message.content || "{}"); }
    catch { json = { verdict: "uncertain", message: "Не удалось распарсить ответ модели", errors: [], recommendations: [], fieldsExtracted: {} }; }

    // Подстрахуем обязательные поля
    json.verdict = json.verdict || "uncertain";
    json.errors = Array.isArray(json.errors) ? json.errors : [];
    json.recommendations = Array.isArray(json.recommendations) ? json.recommendations : [];
    json.fieldsExtracted = json.fieldsExtracted || {};

    res.status(200).json(json);
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || "Server error");
  }
}
