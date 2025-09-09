// web/pdf-client-fallback.js
(() => {
  // где брать воркер pdf.js (cdn)
  const PDFJS_VER = "4.7.76";
  const PDFJS_WORKER =
    `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.worker.min.js`;

  // найдём первый инпут type=file (при желании поменяйте селектор)
  let fileInput = null;
  let checkBtn = null; // кнопка "Проверить" (не обязательно)
  let currentFile = null; // сюда кладём исходный или конвертированный файл

  function findControls() {
    fileInput =
      document.querySelector('input[type="file"][name="file"]') ||
      document.querySelector('input[type="file"]');

    checkBtn =
      document.querySelector('#checkBtn') ||
      document.querySelector('button[data-action="verify"]') ||
      null;
  }

  async function ensurePdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.min.js`;
      s.onload = resolve;
      s.onerror = () => reject(new Error("pdf.js load failed"));
      document.head.appendChild(s);
    });
    // настроим воркер
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return window.pdfjsLib;
    }
    throw new Error("pdf.js not available");
  }

  async function pdfFirstPageToPng(file) {
    const pdfjsLib = await ensurePdfJs();
    const ab = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: ab }).promise;
    const page = await doc.getPage(1);

    const scale = 1.8;
    const viewport = page.getViewport({ scale });

    // создаём канвас на клиенте
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx, viewport }).promise;

    // получаем Blob PNG и упаковываем в File
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png", 0.95));
    const pngFile = new File([blob], (file.name || "document").replace(/\.pdf$/i, ".png"), {
      type: "image/png",
      lastModified: Date.now(),
    });
    return pngFile;
  }

  async function onFileChange() {
    const f = fileInput?.files?.[0] || null;
    if (!f) {
      currentFile = null;
      return;
    }
    if (/application\/pdf/i.test(f.type) || /\.pdf$/i.test(f.name || "")) {
      // PDF → рендерим 1-ю страницу в PNG
      try {
        // можно показать в интерфейсе спиннер, если есть контейнер
        currentFile = await pdfFirstPageToPng(f);

        // если у вас есть превью — отрисуем превью PNG
        const preview = document.querySelector('[data-preview]');
        if (preview) {
          const url = URL.createObjectURL(currentFile);
          preview.innerHTML = `<img src="${url}" style="max-width:100%;border-radius:12px" alt="PDF page 1"/>`;
        }
      } catch (e) {
        console.error("PDF render fallback failed:", e);
        // если не получилось — оставим исходный файл (сервер попробует текстовым парсером)
        currentFile = f;
      }
    } else {
      currentFile = f;
    }
  }

  // Экспортируем маленький helper: забрать файл для отправки
  window.emgrGetUploadFile = function () {
    if (currentFile) return currentFile;
    const f = fileInput?.files?.[0] || null;
    return f || null;
  };

  function wireUp() {
    findControls();
    if (!fileInput) return; // нет загрузки — нечего делать
    fileInput.addEventListener("change", onFileChange, { passive: true });

    // если у вас кнопка "Проверить" вручную формирует FormData — менять не нужно.
    // Если используете new FormData(form) — перехватим submit и подкинем наш файл.
    const form = fileInput.closest("form");
    if (form) {
      form.addEventListener("submit", async (e) => {
        // если отправка уже перехватывается вашим кодом — этот блок можно удалить.
        if (form.dataset.emgrHandled) return;
        e.preventDefault();

        const file = window.emgrGetUploadFile();
        if (!file) {
          alert("Сначала загрузите файл");
          return;
        }

        const fd = new FormData(form);
        fd.delete("file");
        fd.append("file", file, file.name);

        try {
          const res = await fetch(form.action || "/api/verify-address", {
            method: "POST",
            body: fd,
          });
          const json = await res.json();
          // отдаём результат вашему коду через событие
          form.dispatchEvent(new CustomEvent("emgr:verify:done", { detail: json }));
        } catch (err) {
          form.dispatchEvent(new CustomEvent("emgr:verify:error", { detail: err }));
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", wireUp);
})();
