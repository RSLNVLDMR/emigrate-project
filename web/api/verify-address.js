// web/api/verify-address.js
import OpenAI from "openai";
import formidable from "formidable";
import { promises as fsp } from "node:fs";
import { Buffer } from "node:buffer";

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
- Кандидаты: umowa najmu (обычная/okazjonalna), zaświadczenie o zameldowaniu (мелдунек), право собственности + подтверждение проживания, umowa użyczenia, подтверждения отеля/общежития, заявление арендодателя о предоставлении жилья.
- НЕ подходят: случайные письма с адресом, чеки, инвойсы, визитки, скрин Google Maps и т.п.
- Извлеки поля: full_name, address, postal_code (NN-NNN), city, doc_date, valid_from, valid_to, issuer, signatures_present.
- Если скан шумный — всё равно попытайся прочитать «якоря»: "Umowa najmu", "Umowa użyczenia", "Zaświadczenie o zameldowaniu", "Wynajmujący", "Najemca", "Podpis", "Urząd", "Gmina", "Miasto", "Kod pocztowy", "Hotel", "Akademik".
- severity: "critical" (делает документ непригодным), "major" (надо исправить/добавить), "minor" (косметика).
`,
  lease_standard: `
Тип: Umowa najmu (обычная).
Обязательные признаки:
- стороны (Wynajmujący/Najemca) присутствуют;
- адрес жилья полон (улица, дом/кв, индекс, город);
- подписи обеих сторон;
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
  uzyczenie: `
Тип: Umowa użyczenia (безвозмездное пользование).
Обязательные признаки:
- стороны (дающий жильё и пользующийся);
- полный адрес жилья;
- подписи сторон;
- период проживания (valid_from/valid_to) или чёткое указание на действительность сейчас.
`,
  hotel_dorm: `
Тип: Подтверждение отеля/общежития (академик).
Обязательные признаки:
- наименование и адрес объекта размещения (issuer/address);
- ФИО гостя/студента;
- даты проживания, покрывающие дату подачи либо будущий период;
- реквизиты/номер брони; подпись/печать обычно не обязательна.
`,
  landlord_declaration: `
Тип: Заявление/декларация арендодателя о предоставлении жилья.
Обязательные признаки:
- адрес жилья;
- однозначная формулировка, что заявителю предоставлено место проживания;
- подпись арендодателя;
- дата документа (желательно не старше 12 мес.).
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
  "doc_kind": "lease_standard|lease_okazjonalna|meldunek|owner|uzyczenie|hotel_dorm|landlord_declaration|other",
  "verdict": "pass" | "fail" | "uncertain",
  "message": "краткое резюме (по-русски, без служебных скобок)",
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
const TODAY_ISO = toYMD(TODAY);
const TODAY_DMY = toDMY(TODAY);

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

/** Жёсткая проверка пригодности + дружелюбные тексты */
function ruleCheck(docTypeHint, modelJson) {
  const out = { ...modelJson };
  out.errors = Array.isArray(out.errors) ? [...out.errors] : [];
  out.recommendations = Array.isArray(out.recommendations) ? [...out.recommendations] : [];

  const f = out.fieldsExtracted || {};
  const docDate = parseDate(f.doc_date);
  const vFrom = parseDate(f.valid_from);
  const vTo = parseDate(f.valid_to);
  const title = norm(out.doc_kind || "");
  const issuer = norm(f.issuer || "");

  // Базовая логика
  if (out.is_proof_of_address === false) {
    addError(
      out.errors,
      "not_proof",
      "Не является подтверждением адреса",
      "В документе нет обязательных признаков (договор/мелдунек/заявление собственника/отель и т.п.).",
      "critical"
    );
  }

  // Сроки
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
    addError(
      out.errors,
      "too_old",
      "Документ устарел",
      `Документ выдан более 12 месяцев назад (дата: ${toDMY(docDate)}). Нужен свежий документ.`,
      "major"
    );
  }

  // Общий адрес
  if (!f.address || !f.postal_code || !f.city) {
    addError(
      out.errors,
      "address_incomplete",
      "Неполный адрес",
      "Нужен полный польский адрес: улица, дом/квартира, индекс и город.",
      "critical"
    );
  }

  // Тип-специфика
  if (out.doc_kind === "meldunek") {
    const hasIssuer =
      containsAny(issuer, ["urząd", "urzad", "gmina", "miasto", " urz ", " um ", " ug "]) ||
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

  if (out.doc_kind === "lease_standard" || out.doc_kind === "lease_okazjonalna") {
    if (f.signatures_present === false)
      addError(
        out.errors,
        "no_signatures",
        "Нет подписей сторон",
        "Нужны подписи собственника/арендодателя и квартиросъёмщика.",
        "critical"
      );
    if (out.doc_kind === "lease_okazjonalna" && !containsAny(title, ["okazjonal"]))
      addError(
        out.errors,
        "not_okazjonalna",
        "Не видно признаков najmu okazjonalnego",
        "Должны быть: нотариальное заявление, адрес «na wypadek» и согласие владельца.",
        "major"
      );
  }

  if (out.doc_kind === "owner") {
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

  if (out.doc_kind === "uzyczenie") {
    if (f.signatures_present === false)
      addError(
        out.errors,
        "no_signatures",
        "Нет подписей сторон",
        "Для umowa użyczenia нужны подписи предоставляющего жильё и пользующегося.",
        "critical"
      );
    if (!vFrom && !vTo)
      addError(
        out.errors,
        "no_period",
        "Не указан период проживания",
        "Добавьте даты начала/окончания или явное указание, что действует сейчас.",
        "major"
      );
  }

  if (out.doc_kind === "hotel_dorm") {
    const looksLikeIssuer =
      containsAny(issuer, ["hotel", "hostel", "akademik", "dom studencki", "dorm"]) ||
      containsAny(title, ["hotel", "hostel", "akademik", "dorm"]);
    if (!looksLikeIssuer)
      addError(
        out.errors,
        "no_hotel_issuer",
        "Не распознан объект размещения",
        "Укажите наименование отеля/общежития (issuer) и адрес.",
        "major"
      );
    // Для отелей подпись обычно не обязательна, поэтому не требуем signatures_present
    if (!vFrom && !vTo)
      addError(
        out.errors,
        "no_stay_dates",
        "Нет дат проживания",
        "Нужны даты, покрывающие дату подачи или будущий период проживания.",
        "critical"
      );
  }

  if (out.doc_kind === "landlord_declaration") {
    if (f.signatures_present === false)
      addError(
        out.errors,
        "no_landlord_signature",
        "Нет подписи арендодателя",
        "Заявление должно быть подписано арендодателем.",
        "critical"
      );
    if (!vFrom && !vTo && !docDate)
      addError(
        out.errors,
        "no_date",
        "Нет даты документа",
        "Добавьте дату заявления (желательно не старше 12 месяцев).",
        "major"
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

/* ---------- Вспомогательные функции для изображений и PDF (совместимые с pdfjs-dist) ---------- */

// pdfjs-dist требует чистый Uint8Array
function toU8(x) {
  if (!x) return new Uint8Array();
  if (Buffer.isBuffer(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof Uint8Array) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  return new Uint8Array(x);
}

// Улучшаем изображение и готовим inputs для Vision
async function buildImageInputsFromBuffers(buffers) {
  let sharpLib = null;
  try { sharpLib = (await import("sharp")).default; } catch {}
  const inputs = [];
  for (const buf of buffers) {
    if (sharpLib) {
      const base = await sharpLib(buf)
        .rotate()
        .resize({ width: 2400, withoutEnlargement: true })
        .jpeg({ quality: 92 })
        .toBuffer();
      const enhanced = await sharpLib(base).grayscale().normalize().sharpen().jpeg({ quality: 95 }).toBuffer();
      inputs.push(
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base.toString("base64")}` } },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${enhanced.toString("base64")}` } }
      );
    } else {
      inputs.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}` } });
    }
  }
  return inputs;
}

// PDF -> буферы PNG первых N страниц (Uint8Array внутрь pdfjs)
async function renderPdfToPngBuffers(pdfBuffer, maxPages = 10, scale = 2.2) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const doc = await pdfjs.getDocument({ data: toU8(pdfBuffer), disableWorker: true }).promise;
  const pages = Math.min(doc.numPages, maxPages);
  const out = [];
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    out.push(canvas.toBuffer("image/png"));
  }
  return out;
}

// Склейка нескольких изображений вертикально в один JPEG
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

/* ---------- Основной обработчик ---------- */
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
    const form = formidable({
      multiples: false,
      maxFileSize: 40 * 1024 * 1024, // 40 МБ
      uploadDir: "/tmp",
      keepExtensions: true,
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    });

    const docTypeHint = (Array.isArray(fields.docType) ? fields.docType[0] : fields.docType) || "other";
    const fileRec = files.file ? (Array.isArray(files.file) ? files.file[0] : files.file) : null;

    if (!fileRec) {
      res.status(400).json({ error: "Файл не получен" });
      return;
    }

    const buf = await fsp.readFile(fileRec.filepath).finally(() => {
      fsp.unlink(fileRec.filepath).catch(() => {});
    });
    const mime = (fileRec.mimetype || "application/octet-stream").toLowerCase();

    const baseInstruction = `
Ты — эксперт, который проверяет, подходит ли предоставленный документ как подтверждение адреса проживания в Польше для подачи на karta pobytu czasowego.
На вход ты получаешь OCR-текст (или изображения) и подсказку doc_kind_hint="${docTypeHint}".
Работай по-русски (все тексты ответа на русском), верни СТРОГО JSON по схеме ниже.

Дата сегодня: ${TODAY_DMY} (ISO: ${TODAY_ISO}). Если дат нет — отметь ошибкой.

Допустимые документы:
- Договор аренды (umowa najmu, в т.ч. okazjonalna).
- Право собственности (акт/№ KW) + подтверждение проживания.
- Официальная регистрация по адресу (zaświadczenie o zameldowaniu).
- Договор безвозмездного пользования (umowa użyczenia).
- Подтверждения отеля/общежития с датами проживания.
- Заявление арендодателя об обеспечении места проживания.

Критерии пригодности (если нет — документ непригоден):
- Полный польский адрес (улица, дом/кв, индекс NN-NNN, город).
- ФИО заявителя (или однозначная ссылка).
- Сроки покрывают дату подачи; разумный период проживания вперёд.
- Для договоров/заявлений — подписи/печати/реквизиты; для meldunek — орган выдачи.

Инструкции:
1) Если текст нечитаем — verdict:"fail" и ошибка unreadable.
2) Определи вид документа (всегда выбери один из перечня ниже).
3) Извлеки ключевые поля (fieldsExtracted) и проверь валидность дат относительно ${TODAY_ISO}.
4) Сформируй errors[] с дружелюбными формулировками (без дублей).
5) Всегда верни verdict: pass|fail|uncertain + короткое человеческое message.

Типы для "doc_kind": lease_standard|lease_okazjonalna|meldunek|owner|uzyczenie|hotel_dorm|landlord_declaration|other

Схема ответа:
${OUTPUT_SPEC}

Правила:
${RULES.common}
Специфика по подсказке doc_kind_hint="${docTypeHint}":
${RULES[docTypeHint] || RULES.other}
`.trim();

    let messages;

    if (mime === "application/pdf") {
      // 1) пробуем вытянуть «живой» текст из PDF (pdf-parse принимает Buffer)
      let pdfParse;
      try {
        const mod = await import("pdf-parse");
        pdfParse = mod.default || mod;
      } catch { pdfParse = null; }

      let textOk = false;
      if (pdfParse) {
        try {
          const parsed = await pdfParse(buf);
          const pdfText = (parsed.text || "").trim();
          if (pdfText && pdfText.length > 40) {
            messages = [
              { role: "system", content: baseInstruction },
              { role: "user", content: `OCR-текст из PDF (фрагмент):\n\n${pdfText.slice(0, 30000)}` },
            ];
            textOk = true;
          }
        } catch {}
      }

      if (!textOk) {
        // 2) PDF-скан → рендерим до 10 страниц и склеиваем их в один длинный JPEG
        const pageBuffers = await renderPdfToPngBuffers(buf, 10, 2.2);
        if (!pageBuffers.length) {
          res.status(400).json({ error: "Не удалось обработать PDF. Загрузите фото/скан." });
          return;
        }
        const combinedJpeg = await combineBuffersVerticallyToJpeg(pageBuffers);
        const visionInputs = await buildImageInputsFromBuffers([combinedJpeg]);
        const singleInput = [visionInputs[0]]; // один вариант — стабильнее

        messages = [
          { role: "system", content: baseInstruction },
          {
            role: "user",
            content: [
              { type: "text", text: "На изображении — склеенные первые страницы PDF. Извлеки данные и оцени пригодность. Верни СТРОГО JSON." },
              ...singleInput,
            ],
          },
        ];
      }
    } else if (mime.startsWith("image/")) {
      // Фото: один вариант
      const inputs = await buildImageInputsFromBuffers([buf]);
      const single = [inputs[0]];
      messages = [
        { role: "system", content: baseInstruction },
        {
          role: "user",
          content: [
            { type: "text", text: "Проанализируй документ, извлеки поля и оцени пригодность. Верни СТРОГО JSON." },
            ...single,
          ],
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
      temperature: 0.0,
      max_tokens: 900,
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

    // Если модель уклонилась — превращаем в FAIL с понятной причиной
    if (!json || json.verdict === "uncertain") {
      json = json || {};
      json.is_proof_of_address = false;
      json.verdict = "fail";
      json.errors = Array.isArray(json.errors) ? json.errors : [];
      addError(
        json.errors,
        "low_quality",
        "Недостаточно данных для уверенной проверки",
        "Загрузите более чёткий файл (при необходимости — все страницы в одном изображении), чтобы были видны подписи/печати и полный адрес.",
        "major"
      );
      if (!json.message) {
        json.message = "Не удалось уверенно определить корректность документа.";
      }
    }

    const finalJson = ruleCheck(docTypeHint, json);
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
