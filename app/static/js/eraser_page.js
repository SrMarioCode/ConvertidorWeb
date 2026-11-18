/**
 * ============================================================================
 * Controlador de la Página Dedicada `/borrador` — app/static/js/eraser_page.js
 * ============================================================================
 * Conecta la vista `/borrador` con:
 * 1. El motor de borrado manual con lápiz (`window.ConvertidorEraser`).
 * 2. La carga de archivos locales (Drag & Drop / selector / imagen demo).
 * 3. El Web Worker (`worker.js`) para exportar la imagen transparente final en
 *    PNG, WebP, AVIF o ICO sin perder calidad y con mínimo consumo de RAM.
 * ============================================================================
 */

(function initEraserPage() {
  const fileInput = document.getElementById("eraser-file-input");
  const dropzone = document.getElementById("eraser-dropzone");
  const selectFileBtn = document.getElementById("eraser-select-file-btn");
  const demoBtn = document.getElementById("eraser-demo-btn");

  const studioEl = document.getElementById("eraser-studio");
  const exportBar = document.getElementById("eraser-export-bar");
  const exportFormatSelect = document.getElementById("eraser-export-format");
  const downloadBtn = document.getElementById("eraser-download-btn");
  const downloadBtnText = document.getElementById("eraser-download-btn-text");
  const changeImageBtn = document.getElementById("eraser-change-image-btn");
  const releaseRamBtn = document.getElementById("eraser-release-ram-btn");
  const telemetryText = document.getElementById("eraser-telemetry-text");

  if (!fileInput || !dropzone || !window.ConvertidorEraser) return;

  const controller = window.ConvertidorEraser.createEraserController();
  if (!controller) return;

  let worker = null;
  function getWorker() {
    if (!worker) {
      try {
        worker = new Worker("/static/js/worker.js", { type: "module" });
      } catch (_) {
        worker = null;
      }
    }
    return worker;
  }

  function updateDownloadButtonLabel() {
    if (!exportFormatSelect || !downloadBtnText) return;
    const option = exportFormatSelect.options[exportFormatSelect.selectedIndex];
    const ext = (option?.dataset?.ext || exportFormatSelect.value).toUpperCase();
    downloadBtnText.textContent = `Descargar .${ext} sin fondo`;
  }

  async function openImageInStudio(file) {
    if (!file) return;
    dropzone.hidden = true;
    exportBar.hidden = false;
    await controller.loadFile(file);
    updateDownloadButtonLabel();
  }

  function resetToDropzone() {
    controller.clear();
    studioEl.hidden = true;
    exportBar.hidden = true;
    dropzone.hidden = false;
  }

  // Selector de archivos y Drag & Drop
  selectFileBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    fileInput.click();
  });

  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) {
      try {
        await openImageInStudio(file);
      } catch (err) {
        resetToDropzone();
        if (telemetryText) {
          telemetryText.textContent =
            err instanceof Error ? err.message : "Error al cargar la imagen.";
        }
      }
    }
  });

  ["dragenter", "dragover"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("is-dragover");
    });
  });

  ["dragleave", "drop"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("is-dragover");
    });
  });

  dropzone.addEventListener("drop", async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      await openImageInStudio(file);
    }
  });

  // Imagen de ejemplo con un objeto central claro sobre fondo de color para practicar el borrador
  demoBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const c = document.createElement("canvas");
    c.width = 960;
    c.height = 540;
    const ctx = c.getContext("2d");

    // Fondo degradado suave para borrar con el lápiz
    const bgGrad = ctx.createLinearGradient(0, 0, 960, 540);
    bgGrad.addColorStop(0, "#dbeafe");
    bgGrad.addColorStop(1, "#bfdbfe");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, 960, 540);

    // Sombras/elementos de fondo secundarios para probar el borrado manual
    ctx.fillStyle = "#93c5fd";
    ctx.beginPath();
    ctx.arc(170, 140, 80, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(800, 400, 95, 0, Math.PI * 2);
    ctx.fill();

    // Sujeto principal nítido al centro (insignia tipo cámara/imagen)
    ctx.fillStyle = "#0b57d0";
    ctx.beginPath();
    ctx.roundRect(300, 120, 360, 300, 48);
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(480, 260, 86, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#0b57d0";
    ctx.beginPath();
    ctx.arc(480, 260, 48, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#a8c7fa";
    ctx.beginPath();
    ctx.arc(590, 175, 16, 0, Math.PI * 2);
    ctx.fill();

    c.toBlob(async (blob) => {
      c.width = 1;
      c.height = 1;
      if (!blob) return;
      const demoFile = new File([blob], "objeto-con-fondo.png", {
        type: "image/png",
      });
      await openImageInStudio(demoFile);
    }, "image/png");
  });

  exportFormatSelect?.addEventListener("change", updateDownloadButtonLabel);

  changeImageBtn?.addEventListener("click", () => {
    fileInput.click();
  });

  releaseRamBtn?.addEventListener("click", () => {
    resetToDropzone();
  });

  // Descarga final con transparencia respetando el formato elegido
  downloadBtn?.addEventListener("click", async () => {
    if (!exportFormatSelect) return;

    const targetFormat = exportFormatSelect.value;
    const option = exportFormatSelect.options[exportFormatSelect.selectedIndex];
    const targetExt = option?.dataset?.ext || targetFormat;

    downloadBtn.disabled = true;
    const prevText = downloadBtnText?.textContent || "";
    if (downloadBtnText) {
      downloadBtnText.textContent = "Exportando sin pérdida...";
    }

    try {
      const { blob, file } = await controller.exportTransparentPng();
      const baseName = (controller.getSourceFile()?.name || "imagen").replace(/\.[^/.]+$/, "");
      const outputFilename = `${baseName}-sin-fondo.${targetExt}`;

      if (targetFormat === "png") {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = outputFilename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }

      // Para WebP, AVIF o ICO delegamos al Web Worker de baja RAM
      const activeWorker = getWorker();
      if (!activeWorker) {
        throw new Error("El Worker de exportación no está disponible.");
      }

      const convertedBlob = await new Promise((resolve, reject) => {
        const jobId = Date.now();
        const onMsg = (event) => {
          if (event.data?.id !== jobId) return;
          activeWorker.removeEventListener("message", onMsg);
          activeWorker.removeEventListener("error", onErr);
          if (event.data.status === "done" && event.data.outputBlob) {
            resolve(event.data.outputBlob);
          } else {
            reject(new Error(event.data?.errorMessage || "Error al exportar."));
          }
        };
        const onErr = () => {
          activeWorker.removeEventListener("message", onMsg);
          activeWorker.removeEventListener("error", onErr);
          reject(new Error("Error en el Worker al exportar."));
        };

        activeWorker.addEventListener("message", onMsg);
        activeWorker.addEventListener("error", onErr);
        activeWorker.postMessage({
          id: jobId,
          fileBlob: file,
          targetFormat,
          lossless: true,
          quality: 100,
        });
      });

      const url = URL.createObjectURL(convertedBlob);
      const link = document.createElement("a");
      link.href = url;
      link.download = outputFilename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      if (telemetryText) {
        telemetryText.textContent =
          err instanceof Error ? err.message : "No se pudo descargar la imagen.";
      }
    } finally {
      downloadBtn.disabled = false;
      if (downloadBtnText) {
        downloadBtnText.textContent = prevText;
        updateDownloadButtonLabel();
      }
    }
  });
})();
