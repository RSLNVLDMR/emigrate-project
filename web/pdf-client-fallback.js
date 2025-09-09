// web/pdf-client-fallback.js
(() => {
  const PDFJS_VER = "4.7.76";
  const PDFJS_SCRIPT = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.min.js`;
  const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build/pdf.worker.min.js`;

  let fileInput = null;
  let currentFile = null; // File, который реально отправим (PNG/JPEG после конвертации)

  function findInput() {
    fileInput =
      document.querySelector('input[type="file"][name="file"]') ||
      document.querySelector('input[type="file"]');
  }

  async function ensurePdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = PDFJS_SCRIPT;
      s.onload = resolve;
      s.onerror = () => reject(new Error("pdf.js load failed"));
      document.head.appendChild(s);
    });
    if (!window.pdfjsLib) throw new Error("pdf.js not available");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return window.pdfjsLib;
  }

  async function renderPdfToCombinedImage(file, maxPages = 3) {
    const pdfjsLib = await ensurePdfJs();
    const ab = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: ab }).promise;
    const pages = Math.min(maxPages, doc.numPages);

    // пробуем с высокого масштаба и уменьшаем, если файл выходит за 9 МБ
    let scale = 2.4;

    async function renderAtScale(scaleVal) {
      const bitmaps = [];
      let totalWidth = 0;
      let totalHeight = 0;

      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: scaleVal });

        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;

        // сохраняем Bitmap и размеры
        bitmaps.push(canvas);
        totalWidth = Math.max(totalWidth, canvas.width);
        totalHeight += canvas.height;
      }

      // склеиваем вертикально
      const out = document.createElement("canvas");
      out.width = totalWidth;
      out.height = totalHeight;
      const octx = out.getContext("2d");
      let y = 0;
      for (const bmp of bitmaps) {
        octx.drawImage(bmp, 0, y);
        y += bmp.height;
      }

      // JPEG обычно компактнее для сканов
      const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.92));
      return new File([blob], (file.name || "document").replace(/\.pdf$/i, ".jpg"), {
        type: "image/jpeg",
        lastModified: Date.now(),
      });
    }

    // подбираем масштаб, чтобы уложиться в лимит (≈9 МБ, запас к 10 МБ)
    for (;;) {
      const f = await renderAtScale(scale);
      if (f.size <= 9 * 1024 * 1024 || scale <= 1.6) return f;
      scale -= 0.2;
    }
  }

  async function onFileChange() {
    const f = fileInput?.files?.[0] || null;
    if (!f) {
      currentFile = null;
      return;
    }
    if (/application\/pdf/i.test(f.type) || /\.pdf$/i.test(f.name || "")) {
      try {
        currentFile = await renderPdfToCombinedImage(f, 3); // первые 3 страницы
        const preview = document.querySelector('[data-preview]');
        if (preview) {
          const url = URL.createObjectURL(currentFile);
          preview.innerHTML = `<img src="${url}" style="max-width:100%;border-radius:12px" alt="PDF pages preview"/>`;
        }
      } catch (e) {
        console.error("PDF fallback failed:", e);
        currentFile = f; // пусть сервер попробует сам
      }
    } else {
      currentFile = f;
    }
  }

  window.emgrGetUploadFile = function () {
    return currentFile || (fileInput?.files?.[0] || null);
  };

  function wire() {
    findInput();
    if (!fileInput) return;
    fileInput.addEventListener("change", onFileChange, { passive: true });

    // Если отправляете через form — этот блок можно удалить. Мы не перехватываем submit.
  }

  document.addEventListener("DOMContentLoaded", wire);
})();
