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

/* ---------- Правила для подсказки модели ---------- */
const RULES = {
  common: `
- Принимаются только документы, которые реально подтверждают адрес проживания в Польше сейчас.
- Кандидаты: Umowa najmu (обычная/okazjonalna), Zaświadczenie o zameldowaniu (мелдунек), документ собственника + заявление/подтверждение проживания.
- НЕ подходят: случайные письма с адресом, чеки, визитки, скрин Google Maps и т.п.
- Извлеки поля: full_name, address, postal_code (NN-NNN), city, doc_date, valid_from, valid_to, issuer, signatures_present.
- Если скан шумный — всё равно попытайся прочитать «якоря»: "Umowa najmu", "Zaświadczenie o zameldowaniu", "Wynajmujący", "Najemca", "Urząd", "Gmina", "Miasto", "Kod pocztowy".
- severity: "critical" (делает документ непригодным), "major" (надо исправить/добавить), "minor" (косметика).
`,
  lease_standard: `
Тип: Umowa najmu (обычная).
Обязательные признаки для пригодности:
- стороны (Wynajmujący/Najemca) присутствуют (ФИО/название);
- адрес жилья полон (улица, дом/кв, индекс, город);
- есть подписи обеих сторон (или отметка о подписании);
- срок не истёк (valid_to в будущем) ИЛИ бессрочно; дата не старше 12 мес.
`,
  lease_okazjonalna: `
Тип: Umowa najmu okazjonalnego.
Обязательные признаки = обычный договор + нотариальное заявление (poddanie się egzekucji), адрес "na wypadek", согласие владельца запасного жилья; подписи/даты на приложениях.
`,
  meldunek: `
Тип: Zaświadczenie o zameldowaniu.
Обязательные признаки:
- орган выдачи — UM/UG/Urząd/Gmina/Miasto (issuer);
- ФИО/PESEL лица;
- адрес проживания, вид (czasowy/stały), даты;
- печать/подпись/штрих-код или номер справки;
- дата справки не старше 12 мес. Если указано valid_to — не истёк.
`,
  owner: `
Тип: Вы — собственник.
Обязательные признаки:
- документ собственности (KW/акт) либо явные реквизиты KW;
- заявление/подтверждение проживания заявителя по адресу собственника;
- подпись собственника (и при необходимости печать).
`,
  other: `
Тип: Другое подтверждение — оцени по общим правилам и не помечай как "пригодно", если нет чётких обязательных признаков.
`,
};

/* ---------- Формат требуемого JSON от модели ---------- */
const OUTPUT_SPEC = `
Верни СТРОГО JSON:
{
  "is_proof_of_address": true | false,
  "doc_kind": "STRING",
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

/* ---------- Утилиты и пост-валидация ---------- */
const TODAY = new Date();
const norm = (s = "") => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

function toYMD(d) {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function toDMY(d) {
  if (!d) return null;
  const day = String(d.getDate()).padStart(2, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const y = d.getFullYear();
  return `${day}.${m}.${y}`;
}
function parseDate(s) {
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/;
  const pl = /^(\d{2})\.(\d{2})\.(\d{4})$/;
  let m = s.match(iso);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(pl);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function monthsDiff(a, b) {
  const years = b.getFullYear() - a.getFullYear();
  const months = b.getMonth() - a.getMonth();
  return years * 12 + months - (b.getDate() < a.getDate() ? 1 : 0);
}
function containsAny(str = "", words = []) {
  const low = str.toLowerCase();
  return words.some((w) => low.includes(w));
}
function addError(arr, code, title, detail, severity = "major") {
  // защита от дублей по коду/заголовку
  const keyCode = norm(code);
  const keyTitle = norm(title);
  if ((arr || []).some((e) => norm(e.code) === keyCode || norm(e.title) === keyTitle)) return;
  arr.push({ code, title, detail, severity });
}

function isExpiryErr(e) {
  const t = norm(e.title);
  const c = norm(e.code);
  const d = norm(e.detail);
  return (
    c.includes("expired") ||
    t.includes("истёк") ||
    t.includes("istek") ||
    t.includes("expired") ||
    d.includes("valid_to") ||
    d.includes("закончился")
  );
}
function unifyExpiryErrors(errors, vTo) {
  const kept = [];
  let found = null;
  for (const e of errors || []) {
    if (isExpiryErr(e)) {
      if (!found) {
        found = {
          code: "expired",
          title: "Срок действия истёк",
          detail: vTo
            ? `Срок действия закончился ${toDMY(vTo)}. Загрузите актуальный документ.`
            : (e.detail || "Срок действия закончился. Загрузите актуальный документ."),
          severity: "critical",
        };
      }
      continue; // остальные «про срок» отбрасываем
    }
    kept.push(e);
  }
  if (found) kept.unshift(found);
  return kept;
}

/** Жёсткая проверка пригодности документа + «человеческие» тексты */
function ruleCheck(docType, modelJson) {
  const out = { ...modelJson };
  out.errors = Array.isArray(out.errors) ? [...out.errors] : [];
  out.recommendations = Array.isArray(out.recommendations) ? [...out.recommendations] : [];

  const f = out.fieldsExtracted || {};
  const docDate = parseDate(f.doc_date);
  const vTo = parseDate(f.valid_to);

  // 1) Базовая проверка типа
  if (out.is_proof_of_address === false) {
    addError(
      out.errors,
      "not_proof",
      "Не является подтверждением адреса",
      "В документе нет обязательных признаков (договор/мелдунек/заявление собственника и т.п.).",
      "critical"
    );
  }

  // 2) Сроки: одно «человеческое» сообщение при наличии valid_to
  if (vTo && vTo < TODAY) {
    addError(
      out.errors,
      "expired",
      "Срок действия истёк",
      `Срок действия закончился ${toDMY(vTo)}. Загрузите актуальный документ.`,
      "critical"
    );
    out.errors = unifyExpiryErrors(out.errors, vTo);
  } else if (!vTo && docDate && monthsDiff(docDate, TODAY) > 12) {
    // Нет valid_to — отдельная проверка «документ устарел»
    addError(
      out.errors,
      "too_old",
      "Документ устарел",
      `Документ выдан более 12 месяцев назад (дата: ${toDMY(docDate)}). Нужен свежий документ.`,
      "major"
    );
  }

  // 3) Тип-специфика (дружелюбные тексты)
  const title = norm(out.doc_kind || "");
  const issuer = norm(f.issuer || "");

  if (docType === "meldunek") {
    const hasIssuer =
      containsAny(issuer, ["urząd", "urzad", "gmina", "miasto", " um ", " ug "]) ||
      containsAny(title, ["meldunek", "zameld"]);
    if (!hasIssuer)
      addError(
        out.errors,
        "no_issuer",
        "Не указан орган, выдавший справку",
        "Для мелдунка обязателен орган (UM/UG/Urząd/Gmina/Miasto).",
        "critical"
      );
    if (f.signatures_present === false)
      addError(
        out.errors,
        "no_stamp",
        "Нет печати/подписи органа",
        "Для мелдунка требуется печать/подпись/номер справки.",
        "major"
      );
  }

  if (docType === "lease_standard" || docType === "lease_okazjonalna") {
    if (!f.address || !f.postal_code || !f.city)
      addError(
        out.errors,
        "address_incomplete",
        "Неполный адрес",
        "В документе должен быть полный адрес: улица, дом/квартира, индекс и город.",
        "critical"
      );
    if (f.signatures_present === false)
      addError(
        out.errors,
        "no_signatures",
        "Нет подписей сторон",
        "Нужны подписи собственника/арендодателя и квартиросъёмщика.",
        "critical"
      );
    if (docType === "lease_okazjonalna" && !containsAny(title, ["okazjonal"]))
      addError(
        out.errors,
        "not_okazjonalna",
        "Не видно признаков najmu okazjonalnego",
        "Должны быть: нотариальное заявление, адрес «na wypadek» и согласие владельца.",
        "major"
      );
  }

  if (docType === "owner") {
    const ownershipMarks =
      containsAny(title, ["kw", "księga", "ksiega", "akt", "własno", "wlasno"]) || containsAny(issuer, ["sąd", "sad", "notariusz"]);
    if (!ownershipMarks)
      addError(
        out.errors,
        "no_ownership_markers",
        "Нет признаков документа собственности",
        "Нужны реквизиты собственности: № KW/акт/нотариус/суд и заявление собственника.",
        "critical"
      );
  }

  // Итоговый вердикт
  const hasCritical = out.errors.some((e) => e.severity === "critical");
  const hasMajor = out.errors.some((e) => e.severity === "major");

  if (hasCritical) out.verdict = "fail";
  else if (hasMajor) out.verdict = "fail";
  else if (out.is_proof_of_address === false) out.verdict = "fail";
  else out.verdict = out.verdict === "uncertain" ? "uncertain" : "pass";

  if (!out.message) {
    out.message =
      out.verdict === "pass"
        ? "Документ принят. Критичных ошибок не найдено."
        : out.verdict === "fail"
        ? "Документ непригоден: см. ошибки ниже."
        : "Не удалось уверенно определить корректность документа.";
  }

  return out;
}

/* ---------- Основной обработчик (визион + pdf-ocr) ---------- */
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
Ты — строгий верификатор подтверждений адреса в Польше.
1) СНАЧАЛА распознай текст (OCR), затем определи вид документа.
2) Скажи, является ли он ПРИГОДНЫМ подтверждением адреса ЗДЕСЬ И СЕЙЧАС (is_proof_of_address).
3) Заполни fieldsExtracted и выяви ошибки по правилам ниже.
4) Верни ответ СТРОГО по JSON-схеме (response_format json_object).
Правила:
${RULES.common}
Специфика типа "${docType}":
${RULES[docType] || RULES.other}
Если документ похож, но не дотягивает до требований (нет печати/подписей/истёк срок) — это не proof (is_proof_of_address=false) и добавь соответствующие ошибки.
${OUTPUT_SPEC}
`.trim();

    let messages;

    if (mime === "application/pdf") {
      let pdfParse;
      try {
        const mod = await import("pdf-parse");
        pdfParse = mod.default || mod;
      } catch {}
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
            res.status(400).json({ error: "PDF — скан без текста. Загрузите фото/скрин." });
            return;
          }
        } catch {
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
        const origJpeg = await sharp(buf).rotate().resize({ width: 2000, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
        const enhancedJpeg = await sharp(origJpeg).grayscale().normalize().sharpen().jpeg({ quality: 95 }).toBuffer();
        variants = [origJpeg, enhancedJpeg];
      } catch {
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
          content: [{ type: "text", text: "Проанализируй документ, извлеки поля и оцени пригодность. Верни СТРОГО JSON." }, ...imgs],
        },
      ];
    } else {
      res.status(400).json({ error: "Поддерживаются только фото и PDF" });
      return;
    }

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
      json = {
        is_proof_of_address: false,
        verdict: "uncertain",
        message: "Не удалось распарсить ответ модели",
        errors: [],
        recommendations: [],
        fieldsExtracted: {},
        raw_text_excerpt: null,
      };
    }

    const finalJson = ruleCheck(docType, json);
    res.status(200).json(finalJson);
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
