/**
 * ============================================================================
 * Controlador Principal del Convertidor — app/static/js/app.js
 * ============================================================================
 * Guía educativa de la arquitectura de este archivo:
 * 1. Gestión de Animaciones Declarativas (`canTransitionDisplay` + `@starting-style`).
 * 2. Sincronización del "Botón / Cápsula Gigante" ("De [Origen] ➔ a [Destino]").
 * 3. Cola Secuencial 1-por-1 (Low-RAM Queue):
 *    En lugar de lanzar 10 conversiones al mismo tiempo (lo que multiplicaría
 *    por 10 el uso de memoria RAM), enviamos las imágenes al Web Worker en
 *    estricto orden secuencial, esperando a que termine y libere la memoria de
 *    la imagen actual antes de enviar la siguiente.
 * 4. Gestión del Ciclo de Vida de `ObjectURL`:
 *    Cada archivo convertido genera un enlace local `blob:...` para descarga
 *    instantánea. Cuando el usuario limpia la lista, llamamos a
 *    `URL.revokeObjectURL()` para devolver esa memoria al navegador.
 * ============================================================================
 */

(function initConverterApp() {
  // Referencias a elementos del DOM en `/convertir`
  const sourceSelect = document.getElementById("source-format-select");
  const targetSelect = document.getElementById("target-format-select");
  const swapBtn = document.getElementById("swap-formats-btn");
  const capsuleActionBtn = document.getElementById("capsule-action-btn");
  const capsuleActionText = document.getElementById("capsule-action-text");
  const presetBtns = document.querySelectorAll(".js-preset-btn");

  const fileInput = document.getElementById("file-input");
  const dropzoneCard = document.getElementById("dropzone-card");
  const dropzoneTitle = document.getElementById("dropzone-dynamic-title");
  const dropzoneHint = document.getElementById("dropzone-dynamic-hint");
  const selectFilesBtn = document.getElementById("select-files-btn");
  const demoImageBtn = document.getElementById("demo-image-btn");

  const losslessCheckbox = document.getElementById("lossless-checkbox");
  const losslessLabelSpan = losslessCheckbox?.parentElement?.querySelector("span");
  const customQualityWrap = document.getElementById("custom-quality-wrap");
  const qualityRange = document.getElementById("quality-range");
  const qualityValueLabel = document.getElementById("quality-value-label");
  const ramStatusText = document.getElementById("ram-status-text");

  const queueSection = document.getElementById("queue-section");
  const queueList = document.getElementById("queue-list");
  const queueCounterTitle = document.getElementById("queue-counter-title");
  const reconvertAllBtn = document.getElementById("reconvert-all-btn");
  const downloadAllBtn = document.getElementById("download-all-btn");
  const clearQueueBtn = document.getElementById("clear-queue-btn");

  if (!sourceSelect || !targetSelect || !fileInput) return;

  // ==========================================================================
  // 1. DETECCIÓN DE TRANSICIONES DISCRETAS (`animate-element-entry-exit`)
  // ==========================================================================
  let supportsDisplayTransition;
  function canTransitionDisplay() {
    if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
    if (
      !window.CSS?.supports?.("transition-behavior", "allow-discrete") ||
      !document.body
    ) {
      return false;
    }
    const probe = document.createElement("div");
    probe.style.cssText =
      "transition: display 1s allow-discrete !important; display: block;";
    document.body.appendChild(probe);
    getComputedStyle(probe).display;
    probe.style.display = "none";
    supportsDisplayTransition = getComputedStyle(probe).display === "block";
    probe.remove();
    return supportsDisplayTransition;
  }

  function showElement(el) {
    if (!el) return;
    el.removeAttribute("data-closing");
    el.hidden = false;
  }

  async function hideElement(el) {
    if (!el) return;
    if (canTransitionDisplay()) {
      el.hidden = true;
    } else {
      el.setAttribute("data-closing", "");
    }

    const animations = el.getAnimations();
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }

    if (el.hasAttribute("data-closing")) {
      el.removeAttribute("data-closing");
      el.hidden = true;
    }
  }

  // ==========================================================================
  // 2. INICIALIZACIÓN PROTEGIDA DEL WEB WORKER Y ESTADO DE LA COLA SECUENCIAL
  // ==========================================================================
  let worker = null;
  try {
    worker = new Worker("/static/js/worker.js", { type: "module" });
  } catch (_) {
    worker = null;
  }

  /**
   * Lista de tareas de conversión en memoria.
   * Guardamos solo la referencia al `File` original (que apunta al disco del
   * usuario sin ocupar RAM extra) y la URL del `Blob` de salida.
   */
  const itemsMap = new Map();
  const pendingQueue = [];
  let isWorkerBusy = false;
  let activeItemId = null;
  let itemCounter = 0;

  /**
   * Formatea bytes a una cadena legible (KB o MB).
   * @param {number} bytes
   * @returns {string}
   */
  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(2)} MB`;
  }

  /**
   * Detecta el identificador corto del formato a partir del MIME o nombre de archivo.
   * @param {File} file
   * @returns {string}
   */
  function detectFormatFromFile(file) {
    const mime = (file.type || "").toLowerCase();
    const name = (file.name || "").toLowerCase();
    if (mime.includes("png") || name.endsWith(".png") || name.endsWith(".apng")) return "png";
    if (
      mime.includes("jpeg") ||
      mime.includes("jpg") ||
      /\.(jpe?g|jfif|pjpeg|pjp)$/i.test(name)
    ) {
      return "jpeg";
    }
    if (mime.includes("webp") || name.endsWith(".webp")) return "webp";
    if (mime.includes("avif") || name.endsWith(".avif")) return "avif";
    if (mime.includes("svg") || name.endsWith(".svg")) return "svg";
    if (mime.includes("bmp") || name.endsWith(".bmp")) return "bmp";
    if (mime.includes("gif") || name.endsWith(".gif")) return "gif";
    if (mime.includes("icon") || name.endsWith(".ico")) return "ico";
    return "img";
  }

  /**
   * Reemplaza la extensión original del archivo por la nueva extensión de salida.
   * @param {string} originalName
   * @param {string} targetExt
   * @returns {string}
   */
  function buildOutputFilename(originalName, targetExt) {
    const baseName = originalName.replace(/\.[^/.]+$/, "");
    return `${baseName || "imagen"}-convertida.${targetExt}`;
  }

  // ==========================================================================
  // 3. SINCRONIZACIÓN VISUAL DEL BOTÓN GIGANTE ("DE QUÉ A QUÉ")
  // ==========================================================================
  function syncCapsuleUI() {
    const sourceOption = sourceSelect.options[sourceSelect.selectedIndex];
    const targetOption = targetSelect.options[targetSelect.selectedIndex];
    if (!sourceOption || !targetOption) return;

    const sourceId = sourceSelect.value;
    const targetId = targetSelect.value;
    const sourceShort =
      sourceId === "auto"
        ? "Auto"
        : sourceOption.text.split("(")[0].split("/")[0].trim();
    const sourceLabel =
      sourceId === "auto" ? "tu imagen" : `tu imagen ${sourceOption.text.trim()}`;
    const targetLabel = targetOption.text.split("(")[0].trim();
    const targetEngine = targetOption.dataset.engine || "OffscreenCanvas";

    // Actualizamos el filtro `accept` del input de archivos
    if (sourceOption.dataset.accept) {
      fileInput.setAttribute("accept", sourceOption.dataset.accept);
    }

    // Actualizamos el texto del botón dentro de la Cápsula Gigante ("De qué a qué")
    if (capsuleActionText) {
      capsuleActionText.textContent = `Subir imagen (${sourceShort} ➔ ${targetLabel})`;
    }

    // Actualizamos los textos dinámicos del área de subida
    dropzoneTitle.textContent = `Sube o arrastra ${sourceLabel} para convertirla a ${targetLabel}`;
    dropzoneHint.textContent = `Motor activo: ${targetEngine} · Procesamiento local 1 a 1 sin saturar la memoria RAM.`;

    // Adaptamos la barra de calidad según capacidades del formato de destino
    const strictlyLossless =
      targetId === "png" || targetId === "ico" || targetId === "bmp";
    const isLossyOnly = targetOption.dataset.lossless === "false";

    if (strictlyLossless) {
      losslessCheckbox.checked = true;
      losslessCheckbox.disabled = true;
      if (losslessLabelSpan) {
        losslessLabelSpan.textContent = `100% Sin pérdida garantizado (${targetLabel})`;
      }
      hideElement(customQualityWrap);
    } else {
      losslessCheckbox.disabled = false;
      if (losslessLabelSpan) {
        losslessLabelSpan.textContent = isLossyOnly
          ? "Máxima calidad (100%)"
          : "Máxima calidad / Sin pérdida (100%)";
      }
      if (losslessCheckbox.checked) {
        hideElement(customQualityWrap);
      } else {
        showElement(customQualityWrap);
      }
    }

    // Resaltamos el chip de acceso rápido si coincide con la selección actual
    presetBtns.forEach((btn) => {
      const matches =
        btn.dataset.source === sourceId && btn.dataset.target === targetId;
      btn.classList.toggle("is-selected", matches);
    });
  }

  sourceSelect.addEventListener("change", () => {
    if (
      sourceSelect.value !== "auto" &&
      sourceSelect.value === targetSelect.value
    ) {
      targetSelect.value = sourceSelect.value === "webp" ? "png" : "webp";
    }
    syncCapsuleUI();
  });

  targetSelect.addEventListener("change", () => {
    if (
      sourceSelect.value !== "auto" &&
      sourceSelect.value === targetSelect.value
    ) {
      sourceSelect.value = targetSelect.value === "png" ? "webp" : "png";
    }
    syncCapsuleUI();
  });

  // Botón de intercambio rápido (Origen ⇄ Destino)
  swapBtn.addEventListener("click", () => {
    const currentSource = sourceSelect.value;
    const currentTarget = targetSelect.value;

    const canTargetAcceptSource = Array.from(targetSelect.options).some(
      (opt) => opt.value === currentSource
    );
    const canSourceAcceptTarget = Array.from(sourceSelect.options).some(
      (opt) => opt.value === currentTarget
    );

    if (canSourceAcceptTarget) {
      sourceSelect.value = currentTarget;
    }
    if (canTargetAcceptSource) {
      targetSelect.value = currentSource;
    } else {
      targetSelect.value = currentTarget === "png" ? "webp" : "png";
    }

    // Garantizamos que nunca queden Origen y Destino iguales tras intercambiar
    if (
      sourceSelect.value !== "auto" &&
      sourceSelect.value === targetSelect.value
    ) {
      targetSelect.value = sourceSelect.value === "webp" ? "png" : "webp";
    }

    syncCapsuleUI();
  });

  // Botón de acción principal dentro de la Cápsula Gigante
  capsuleActionBtn.addEventListener("click", () => {
    fileInput.click();
  });

  // Píldoras de combinaciones rápidas ("PNG ➔ WebP", etc.)
  presetBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      sourceSelect.value = btn.dataset.source;
      targetSelect.value = btn.dataset.target;
      syncCapsuleUI();
      dropzoneCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });

  // Controles de calidad (100% sin pérdida por defecto vs. deslizador opcional)
  losslessCheckbox.addEventListener("change", () => {
    if (losslessCheckbox.checked) {
      hideElement(customQualityWrap);
    } else {
      showElement(customQualityWrap);
    }
  });

  window.ConvertidorEraser?.syncModernRangeSlider?.(
    qualityRange,
    `${qualityRange.value}%`
  );

  qualityRange.addEventListener("input", () => {
    qualityValueLabel.textContent = `${qualityRange.value}%`;
    window.ConvertidorEraser?.syncModernRangeSlider?.(
      qualityRange,
      `${qualityRange.value}%`
    );
  });

  // ==========================================================================
  // 4. DECODIFICACIÓN Y RASTERIZACIÓN EN HILO PRINCIPAL (SVG, ICO Y RESPALDO)
  // ==========================================================================
  /**
   * Extrae dimensiones intrínsecas (`width`, `height` o `viewBox`) de un archivo SVG
   * para conservar la proporción exacta incluso cuando el `<svg>` solo define `viewBox`.
   *
   * @param {File|Blob} svgBlob
   * @returns {Promise<{width: number, height: number} | null>}
   */
  async function parseSvgDimensions(svgBlob) {
    try {
      const text = await svgBlob.text();
      const svgTagMatch = text.match(/<svg\b[^>]*>/i);
      const rootSvgTag = svgTagMatch ? svgTagMatch[0] : text;
      const viewBoxMatch = rootSvgTag.match(
        /viewBox\s*=\s*["']\s*([-\d.]+)[,\s]+([-\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*["']/i
      );
      const widthMatch = rootSvgTag.match(
        /\bwidth\s*=\s*["']\s*([\d.]+)\s*(?:px)?\s*["']/i
      );
      const heightMatch = rootSvgTag.match(
        /\bheight\s*=\s*["']\s*([\d.]+)\s*(?:px)?\s*["']/i
      );

      let w = widthMatch ? parseFloat(widthMatch[1]) : 0;
      let h = heightMatch ? parseFloat(heightMatch[1]) : 0;

      if ((!w || !h) && viewBoxMatch) {
        const vbW = parseFloat(viewBoxMatch[3]);
        const vbH = parseFloat(viewBoxMatch[4]);
        if (vbW > 0 && vbH > 0) {
          if (w > 0 && !h) {
            h = Math.round(w * (vbH / vbW));
          } else if (h > 0 && !w) {
            w = Math.round(h * (vbW / vbH));
          } else {
            const scale = vbW < 512 && vbH < 512 ? Math.min(1024 / vbW, 1024 / vbH) : 1;
            w = Math.max(1, Math.round(vbW * scale));
            h = Math.max(1, Math.round(vbH * scale));
          }
        }
      }

      if (w > 0 && h > 0) {
        return { width: Math.round(w), height: Math.round(h) };
      }
    } catch (_) {
      // Ignoramos errores de lectura de texto y usamos dimensiones del elemento <img>
    }
    return null;
  }

  /**
   * Decodifica cualquier imagen (`SVG`, `ICO` o formatos que fallen en `createImageBitmap`
   * del Worker) usando el decodificador `<img>` del hilo principal y devuelve un `ImageBitmap`.
   *
   * @param {File} file
   * @returns {Promise<ImageBitmap>}
   */
  async function decodeFileToBitmapOnMainThread(file) {
    const isSvg =
      file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");

    let sourceBlob = file;
    let svgDims = null;
    if (isSvg) {
      if (file.type !== "image/svg+xml") {
        sourceBlob = new Blob([file], { type: "image/svg+xml" });
      }
      svgDims = await parseSvgDimensions(sourceBlob);
    }

    return new Promise((resolve, reject) => {
      const tempUrl = URL.createObjectURL(sourceBlob);
      const img = new Image();
      img.onload = async () => {
        try {
          const width =
            (svgDims && svgDims.width) || img.naturalWidth || img.width || 1024;
          const height =
            (svgDims && svgDims.height) || img.naturalHeight || img.height || 1024;
          const tempCanvas = document.createElement("canvas");
          tempCanvas.width = width;
          tempCanvas.height = height;
          const ctx = tempCanvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          URL.revokeObjectURL(tempUrl);

          const bitmap = await createImageBitmap(tempCanvas);
          tempCanvas.width = 1;
          tempCanvas.height = 1;
          resolve(bitmap);
        } catch (err) {
          URL.revokeObjectURL(tempUrl);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(tempUrl);
        reject(
          new Error(
            isSvg
              ? "No se pudo interpretar el archivo vectorial SVG."
              : "No se pudo decodificar el archivo de imagen."
          )
        );
      };
      img.src = tempUrl;
    });
  }

  const rasterizeSvgToBitmap = decodeFileToBitmapOnMainThread;

  /**
   * Respaldo completo de conversión en el hilo principal (`<canvas>`) en caso de que
   * el Web Worker no esté disponible o sufra un error no recuperable.
   *
   * @param {object} item
   */
  async function convertOnMainThread(item) {
    const startTime = performance.now();
    const bitmap = await decodeFileToBitmapOnMainThread(item.file);

    let targetWidth = bitmap.width;
    let targetHeight = bitmap.height;
    if (item.targetFormat === "ico" && (targetWidth > 256 || targetHeight > 256)) {
      const scale = Math.min(256 / targetWidth, 256 / targetHeight);
      targetWidth = Math.max(1, Math.round(targetWidth * scale));
      targetHeight = Math.max(1, Math.round(targetHeight * scale));
    }

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");

    if (item.targetFormat === "jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, targetWidth, targetHeight);
    }

    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const normalizedQuality = item.lossless
      ? 1.0
      : Math.min(1, Math.max(0.5, item.quality / 100));

    let outputBlob = null;
    if (item.targetFormat === "bmp") {
      const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
      canvas.width = 1;
      canvas.height = 1;
      const { width, height, data } = imgData;
      const pixelArraySize = width * height * 4;
      const headerTotal = 54;
      const buffer = new ArrayBuffer(headerTotal + pixelArraySize);
      const view = new DataView(buffer);
      const bytes = new Uint8Array(buffer);
      view.setUint8(0, 0x42);
      view.setUint8(1, 0x4d);
      view.setUint32(2, headerTotal + pixelArraySize, true);
      view.setUint32(10, headerTotal, true);
      view.setUint32(14, 40, true);
      view.setInt32(18, width, true);
      view.setInt32(22, -height, true);
      view.setUint16(26, 1, true);
      view.setUint16(28, 32, true);
      view.setUint32(34, pixelArraySize, true);
      let dst = headerTotal;
      for (let i = 0; i < data.length; i += 4) {
        bytes[dst] = data[i + 2];
        bytes[dst + 1] = data[i + 1];
        bytes[dst + 2] = data[i];
        bytes[dst + 3] = data[i + 3];
        dst += 4;
      }
      outputBlob = new Blob([buffer], { type: "image/bmp" });
    } else if (item.targetFormat === "ico") {
      const pngBlob = await new Promise((res) =>
        canvas.toBlob(res, "image/png")
      );
      canvas.width = 1;
      canvas.height = 1;
      const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
      const icoBytes = new Uint8Array(22 + pngBytes.byteLength);
      const view = new DataView(icoBytes.buffer);
      view.setUint16(2, 1, true);
      view.setUint16(4, 1, true);
      view.setUint8(6, targetWidth >= 256 ? 0 : targetWidth);
      view.setUint8(7, targetHeight >= 256 ? 0 : targetHeight);
      view.setUint16(10, 1, true);
      view.setUint16(12, 32, true);
      view.setUint32(14, pngBytes.byteLength, true);
      view.setUint32(18, 22, true);
      icoBytes.set(pngBytes, 22);
      outputBlob = new Blob([icoBytes], { type: "image/x-icon" });
    } else {
      const mimeMap = {
        png: "image/png",
        jpeg: "image/jpeg",
        webp: "image/webp",
        avif: "image/avif",
      };
      const targetMime = mimeMap[item.targetFormat] || "image/png";
      outputBlob = await new Promise((res) =>
        canvas.toBlob(res, targetMime, normalizedQuality)
      );
      canvas.width = 1;
      canvas.height = 1;
    }

    if (!outputBlob) {
      throw new Error("No se pudo codificar la imagen en el navegador.");
    }

    if (item.downloadUrl) {
      URL.revokeObjectURL(item.downloadUrl);
    }
    item.downloadUrl = URL.createObjectURL(outputBlob);
    item.outputSize = outputBlob.size;
    item.width = targetWidth;
    item.height = targetHeight;
    item.durationMs = Math.round(performance.now() - startTime);
    item.engineUsed = "Canvas Principal (Modo Respaldo)";
    updateItemCardFinished(item);
  }

  // ==========================================================================
  // 5. PROCESAMIENTO EN COLA SECUENCIAL (1 IMAGEN A LA VEZ PARA CUIDAR LA RAM)
  // ==========================================================================
  function updateQueueHeaderAndRamStatus() {
    const total = itemsMap.size;
    const pendingCount = pendingQueue.length + (isWorkerBusy ? 1 : 0);
    queueCounterTitle.textContent = `Imágenes en la sesión (${total})`;

    if (pendingCount > 0) {
      ramStatusText.textContent = `Procesando 1 a 1 en Worker (${pendingCount} restante${pendingCount === 1 ? "" : "s"})...`;
    } else {
      ramStatusText.textContent = `Worker en reposo · Búfer de RAM liberado`;
    }
  }

  async function processNextInQueue() {
    if (isWorkerBusy || pendingQueue.length === 0) {
      updateQueueHeaderAndRamStatus();
      return;
    }

    isWorkerBusy = true;
    const itemId = pendingQueue.shift();
    activeItemId = itemId;
    const item = itemsMap.get(itemId);

    if (!item) {
      isWorkerBusy = false;
      activeItemId = null;
      processNextInQueue();
      return;
    }

    updateQueueHeaderAndRamStatus();
    updateItemCardStatus(item, "working", "Convirtiendo en Worker...");

    try {
      if (!worker) {
        await convertOnMainThread(item);
        isWorkerBusy = false;
        activeItemId = null;
        processNextInQueue();
        return;
      }

      const lowerName = item.file.name.toLowerCase();
      const shouldPreDecodeOnMainThread =
        item._retriedOnMainThread ||
        item.file.type === "image/svg+xml" ||
        lowerName.endsWith(".svg") ||
        item.file.type === "image/x-icon" ||
        item.file.type === "image/vnd.microsoft.icon" ||
        lowerName.endsWith(".ico");

      if (shouldPreDecodeOnMainThread) {
        const preDecodedBitmap = await rasterizeSvgToBitmap(item.file);
        worker.postMessage(
          {
            id: item.id,
            transferredBitmap: preDecodedBitmap,
            targetFormat: item.targetFormat,
            lossless: item.lossless,
            quality: item.quality,
          },
          [preDecodedBitmap] // Transferencia de propiedad 0-copy al Worker
        );
      } else {
        worker.postMessage({
          id: item.id,
          fileBlob: item.file,
          targetFormat: item.targetFormat,
          lossless: item.lossless,
          quality: item.quality,
        });
      }
    } catch (err) {
      updateItemCardStatus(
        item,
        "error",
        err instanceof Error ? err.message : "Error al preparar la imagen"
      );
      isWorkerBusy = false;
      activeItemId = null;
      processNextInQueue();
    }
  }

  if (worker) {
    // Respuesta del Web Worker cuando termina de convertir una imagen
    worker.addEventListener("message", async (event) => {
      const {
        id,
        status,
        outputBlob,
        blob,
        width,
        height,
        durationMs,
        engineUsed,
        errorMessage,
        message,
        code,
      } = event.data;

      const finalBlob = outputBlob || blob;
      const item = itemsMap.get(id);

      // Si createImageBitmap falló en el Worker, reintentamos decodificando con <img> en el hilo principal
      if (
        item &&
        status === "error" &&
        code === "DECODE_FAILED" &&
        !item._retriedOnMainThread
      ) {
        item._retriedOnMainThread = true;
        pendingQueue.unshift(item.id);
        isWorkerBusy = false;
        activeItemId = null;
        processNextInQueue();
        return;
      }

      if (item) {
        // Si ya tenía un ObjectURL anterior (por ejemplo, al reconvertir), lo liberamos primero
        if (item.downloadUrl) {
          URL.revokeObjectURL(item.downloadUrl);
          item.downloadUrl = null;
        }

        if ((status === "done" || status === "success") && finalBlob) {
          item.downloadUrl = URL.createObjectURL(finalBlob);
          item.outputSize = finalBlob.size;
          item.width = width;
          item.height = height;
          item.durationMs = durationMs;
          item.engineUsed = engineUsed || "OffscreenCanvas + Worker";
          updateItemCardFinished(item);
        } else {
          updateItemCardStatus(
            item,
            "error",
            errorMessage || message || "Error en conversión"
          );
        }
      }

      // Liberamos el candado y pasamos a la siguiente imagen en la fila
      isWorkerBusy = false;
      activeItemId = null;
      processNextInQueue();
    });

    // Recuperación automática si el Worker lanza un error no capturado
    const handleWorkerCrash = async (errEvent) => {
      const currentItem = activeItemId ? itemsMap.get(activeItemId) : null;
      if (currentItem) {
        try {
          await convertOnMainThread(currentItem);
        } catch (fallbackErr) {
          updateItemCardStatus(
            currentItem,
            "error",
            fallbackErr instanceof Error
              ? fallbackErr.message
              : errEvent?.message || "Error en el Worker de conversión"
          );
        }
      }
      isWorkerBusy = false;
      activeItemId = null;
      processNextInQueue();
    };

    worker.addEventListener("error", handleWorkerCrash);
    worker.addEventListener("messageerror", handleWorkerCrash);
  }

  // ==========================================================================
  // 6. CREACIÓN Y ACTUALIZACIÓN DE TARJETAS EN LA LISTA DE DESCARGA
  // ==========================================================================
  function createQueueItemCard(item) {
    const row = document.createElement("article");
    row.className = "queue-item";
    row.id = `queue-item-${item.id}`;

    row.innerHTML = `
      <div class="queue-thumb-box" aria-hidden="true">
        <span class="js-source-ext">${item.sourceFormat.toUpperCase()}</span>
      </div>
      <div class="queue-info">
        <div class="queue-filename"></div>
        <div class="queue-meta">
          <span class="queue-badge">${item.sourceFormat.toUpperCase()} ➔ ${item.targetExt.toUpperCase()}</span>
          <span class="js-original-size"></span>
          <span class="js-item-details">En cola para procesar...</span>
        </div>
      </div>
      <div class="queue-actions">
        <span class="queue-badge is-working js-item-status">En cola</span>
        <button type="button" class="btn-secondary js-erase-bg-btn" title="Abrir borrador manual de fondo con lápiz">
          Borrar fondo
        </button>
        <a class="btn-primary js-download-link" hidden>Descargar</a>
      </div>
    `;

    const filenameEl = row.querySelector(".queue-filename");
    if (filenameEl) {
      filenameEl.textContent = item.file.name;
      filenameEl.setAttribute("title", item.file.name);
    }

    const originalSizeEl = row.querySelector(".js-original-size");
    if (originalSizeEl) {
      originalSizeEl.innerHTML = `Original: <strong>${formatBytes(item.file.size)}</strong>`;
    }

    const eraseBtn = row.querySelector(".js-erase-bg-btn");
    if (eraseBtn) {
      eraseBtn.addEventListener("click", () => {
        openEraserModalForItem(item.id);
      });
    }

    return row;
  }

  function updateItemCardStatus(item, state, text) {
    const card = document.getElementById(`queue-item-${item.id}`);
    if (!card) return;
    const statusBadge = card.querySelector(".js-item-status");
    const detailsSpan = card.querySelector(".js-item-details");
    const downloadLink = card.querySelector(".js-download-link");
    const formatBadge = card.querySelector(".queue-badge");

    if (formatBadge) {
      formatBadge.textContent = `${item.sourceFormat.toUpperCase()} ➔ ${item.targetExt.toUpperCase()}`;
    }

    if (statusBadge) {
      statusBadge.hidden = false;
      if (state === "queued") {
        statusBadge.textContent = "En cola";
        statusBadge.className = "queue-badge is-working js-item-status";
      } else {
        statusBadge.textContent = state === "working" ? "Procesando" : "Error";
        statusBadge.className = `queue-badge ${state === "working" ? "is-working" : ""} js-item-status`;
      }
    }
    if (detailsSpan) {
      detailsSpan.textContent = text;
    }
    if (downloadLink) {
      downloadLink.hidden = true;
      downloadLink.removeAttribute("href");
    }
  }

  function updateItemCardFinished(item) {
    const card = document.getElementById(`queue-item-${item.id}`);
    if (!card) return;

    const statusBadge = card.querySelector(".js-item-status");
    const detailsSpan = card.querySelector(".js-item-details");
    const downloadLink = card.querySelector(".js-download-link");
    const formatBadge = card.querySelector(".queue-badge");

    if (formatBadge) {
      formatBadge.textContent = `${item.sourceFormat.toUpperCase()} ➔ ${item.targetExt.toUpperCase()}`;
    }

    if (statusBadge) {
      statusBadge.className = "queue-badge is-done js-item-status";
      statusBadge.textContent = "Listo";
    }

    if (detailsSpan) {
      detailsSpan.innerHTML = `
        Convertido: <strong>${formatBytes(item.outputSize)}</strong> ·
        ${item.width}×${item.height} px ·
        ${item.durationMs} ms (${item.engineUsed})
      `;
    }

    if (downloadLink) {
      downloadLink.href = item.downloadUrl;
      downloadLink.download = buildOutputFilename(item.file.name, item.targetExt);
      downloadLink.textContent = `Descargar .${item.targetExt.toUpperCase()}`;
      downloadLink.hidden = false;
    }
  }

  // ==========================================================================
  // 7. RECEPCIÓN DE ARCHIVOS DEL USUARIO (SUBIDA, ARRASTRAR Y DEMO)
  // ==========================================================================
  function handleIncomingFiles(fileList) {
    const rawFiles = Array.from(fileList || []);
    if (rawFiles.length === 0) return;

    const files = rawFiles.filter(
      (f) =>
        f.type.startsWith("image/") ||
        /\.(png|jpe?g|jfif|pjpeg|pjp|webp|avif|svg|bmp|gif|ico|apng)$/i.test(
          f.name
        )
    );

    if (files.length === 0) {
      ramStatusText.textContent =
        "Formato no compatible · Sube archivos PNG, JPG, WebP, AVIF, SVG, ICO, BMP o GIF.";
      return;
    }

    // Si el selector de origen estaba en "Auto", mostramos el formato detectado
    // de la primera imagen subida si coincide con nuestro catálogo
    const firstDetected = detectFormatFromFile(files[0]);
    if (
      sourceSelect.value === "auto" &&
      Array.from(sourceSelect.options).some((opt) => opt.value === firstDetected)
    ) {
      sourceSelect.value = firstDetected;
      // Si origen y destino quedaron iguales (ej. sube un WebP y el destino era WebP),
      // cambiamos automáticamente el destino a PNG/WebP para ofrecer una conversión útil
      if (targetSelect.value === firstDetected) {
        targetSelect.value = firstDetected === "webp" ? "png" : "webp";
      }
      syncCapsuleUI();
    }

    showElement(queueSection);

    const targetOption = targetSelect.options[targetSelect.selectedIndex];
    const targetFormat = targetSelect.value;
    const targetExt = targetOption.dataset.ext || targetFormat;
    const lossless = losslessCheckbox.checked;
    const quality = Number(qualityRange.value) || 92;

    files.forEach((file) => {
      itemCounter += 1;
      const item = {
        id: itemCounter,
        file,
        sourceFormat: detectFormatFromFile(file),
        targetFormat,
        targetExt,
        lossless,
        quality,
        downloadUrl: null,
        outputSize: 0,
        width: 0,
        height: 0,
        durationMs: 0,
        engineUsed: "",
        _retriedOnMainThread: false,
      };

      itemsMap.set(item.id, item);
      const card = createQueueItemCard(item);
      queueList.prepend(card);
      pendingQueue.push(item.id);
    });

    processNextInQueue();
  }

  // Eventos del botón y zona Drag & Drop
  selectFilesBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropzoneCard.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    fileInput.click();
  });

  dropzoneCard.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length > 0) {
      handleIncomingFiles(fileInput.files);
      fileInput.value = ""; // Permitir volver a elegir el mismo archivo si se desea
    }
  });

  // Soporte completo para arrastrar y soltar (Drag & Drop)
  ["dragenter", "dragover"].forEach((eventName) => {
    dropzoneCard.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzoneCard.classList.add("is-dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzoneCard.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzoneCard.classList.remove("is-dragover");
    });
  });

  dropzoneCard.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) {
      handleIncomingFiles(e.dataTransfer.files);
    }
  });

  // ==========================================================================
  // 8. GENERADOR DE IMAGEN DE DEMOSTRACIÓN EN 1 CLIC (SIN ARCHIVOS EXTERNOS)
  // ==========================================================================
  demoImageBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    const ctx = canvas.getContext("2d");

    // Dibujamos una ilustración geométrica limpia estilo Google Labs
    const grad = ctx.createLinearGradient(0, 0, 960, 540);
    grad.addColorStop(0, "#0b57d0");
    grad.addColorStop(0.55, "#1b6ef3");
    grad.addColorStop(1, "#00639b");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 960, 540);

    // Círculos decorativos con transparencia alfa
    ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
    ctx.beginPath();
    ctx.arc(780, 140, 190, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(168, 199, 250, 0.22)";
    ctx.beginPath();
    ctx.arc(180, 420, 150, 0, Math.PI * 2);
    ctx.fill();

    // Tarjeta central nítida para verificar conservación de bordes sin pérdida
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(180, 145, 600, 250, 28);
    ctx.fill();

    ctx.fillStyle = "#0b57d0";
    ctx.font = "bold 36px sans-serif";
    ctx.fillText("ConvertidorWeb · 100% Local", 230, 235);

    ctx.fillStyle = "#444746";
    ctx.font = "22px sans-serif";
    ctx.fillText("Prueba de nitidez sin pérdida (960 × 540 px)", 230, 290);

    ctx.fillStyle = "#137333";
    ctx.font = "bold 19px monospace";
    ctx.fillText("Web Worker + OffscreenCanvas + @jsquash", 230, 342);

    canvas.toBlob((blob) => {
      canvas.width = 1;
      canvas.height = 1;
      if (!blob) return;
      const demoFile = new File([blob], "muestra-alta-nitidez.png", {
        type: "image/png",
      });
      handleIncomingFiles([demoFile]);
    }, "image/png");
  });

  // ==========================================================================
  // 9. ACCIONES DE LOTE: RECONVERTIR, DESCARGAR TODAS Y LIBERAR MEMORIA RAM
  // ==========================================================================
  reconvertAllBtn.addEventListener("click", () => {
    const targetOption = targetSelect.options[targetSelect.selectedIndex];
    const targetFormat = targetSelect.value;
    const targetExt = targetOption.dataset.ext || targetFormat;
    const lossless = losslessCheckbox.checked;
    const quality = Number(qualityRange.value) || 92;

    itemsMap.forEach((item) => {
      if (item.downloadUrl) {
        URL.revokeObjectURL(item.downloadUrl);
        item.downloadUrl = null;
      }
      item.targetFormat = targetFormat;
      item.targetExt = targetExt;
      item.lossless = lossless;
      item.quality = quality;
      item._retriedOnMainThread = false;
      updateItemCardStatus(item, "queued", "En cola para reconvertir...");
      if (!pendingQueue.includes(item.id)) {
        pendingQueue.push(item.id);
      }
    });

    processNextInQueue();
  });

  downloadAllBtn.addEventListener("click", () => {
    itemsMap.forEach((item) => {
      if (item.downloadUrl) {
        const a = document.createElement("a");
        a.href = item.downloadUrl;
        a.download = buildOutputFilename(item.file.name, item.targetExt);
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    });
  });

  clearQueueBtn.addEventListener("click", async () => {
    // 1. Vaciamos la cola pendiente
    pendingQueue.length = 0;

    // 2. Revocamos todos los ObjectURLs activos para devolver la RAM al navegador
    itemsMap.forEach((item) => {
      if (item.downloadUrl) {
        URL.revokeObjectURL(item.downloadUrl);
      }
    });
    itemsMap.clear();

    // 3. Limpiamos la lista inmediatamente para evitar condiciones de carrera asíncronas
    queueList.innerHTML = "";
    ramStatusText.textContent = "Memoria liberada · 0 imágenes en sesión";
    await hideElement(queueSection);
  });

  // ==========================================================================
  // 10. DIÁLOGO MODAL DEL BORRADOR MANUAL DE FONDO (<dialog> + TOP LAYER)
  // ==========================================================================
  const eraserDialog = document.getElementById("eraser-dialog");
  const eraserDialogCloseBtn = document.getElementById("eraser-dialog-close-btn");
  const eraserDialogCancelBtn = document.getElementById("eraser-dialog-cancel-btn");
  const eraserDialogApplyBtn = document.getElementById("eraser-dialog-apply-btn");
  const eraserDialogSubtitle = document.getElementById("eraser-dialog-subtitle");

  const eraserController =
    eraserDialog && window.ConvertidorEraser
      ? window.ConvertidorEraser.createEraserController()
      : null;

  let editingItemId = null;

  function supportsTopLayerExit() {
    return window.CSS?.supports?.("overlay", "auto") && canTransitionDisplay();
  }

  async function closeTopLayerDialog(dialog, returnValue = "") {
    if (!dialog || !dialog.open) return;

    if (!supportsTopLayerExit()) {
      dialog.setAttribute("data-closing", "");
      const animations = dialog.getAnimations({ subtree: true });
      if (animations.length > 0) {
        await Promise.race([
          Promise.allSettled(animations.map((a) => a.finished)),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
      }
      if (!dialog.hasAttribute("data-closing")) return;
      dialog.removeAttribute("data-closing");
    }

    dialog.close(returnValue);
  }

  async function openEraserModalForItem(itemId) {
    const item = itemsMap.get(itemId);
    if (!item || !eraserDialog || !eraserController) return;

    editingItemId = itemId;
    if (eraserDialogSubtitle) {
      eraserDialogSubtitle.textContent = `Editando "${item.file.name}" · Pinta con el lápiz para borrar el fondo.`;
    }

    eraserDialog.removeAttribute("data-closing");
    eraserDialog.showModal();

    try {
      await eraserController.loadFile(item.file);
    } catch (err) {
      await closeTopLayerDialog(eraserDialog, "error");
      ramStatusText.textContent =
        err instanceof Error ? err.message : "No se pudo abrir la imagen en el borrador.";
    }
  }

  if (eraserDialog) {
    eraserDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeTopLayerDialog(eraserDialog, "cancel");
    });

    eraserDialog.addEventListener("close", () => {
      eraserDialog.returnValue = "";
      editingItemId = null;
      if (eraserController) {
        eraserController.clear();
      }
    });

    eraserDialogCloseBtn?.addEventListener("click", () => {
      closeTopLayerDialog(eraserDialog, "cancel");
    });

    eraserDialogCancelBtn?.addEventListener("click", () => {
      closeTopLayerDialog(eraserDialog, "cancel");
    });

    eraserDialogApplyBtn?.addEventListener("click", async () => {
      if (!eraserController || editingItemId === null) return;
      const item = itemsMap.get(editingItemId);
      if (!item) {
        closeTopLayerDialog(eraserDialog, "cancel");
        return;
      }

      eraserDialogApplyBtn.disabled = true;
      try {
        const { file: editedFile } = await eraserController.exportTransparentPng();

        if (item.downloadUrl) {
          URL.revokeObjectURL(item.downloadUrl);
          item.downloadUrl = null;
        }

        item.file = editedFile;
        item.sourceFormat = "png";
        item._retriedOnMainThread = false;

        // Si el formato destino era JPEG (sin transparencia), cambiamos a PNG
        // para preservar el fondo transparente que el usuario acaba de borrar.
        let switchedToPng = false;
        if (item.targetFormat === "jpeg") {
          item.targetFormat = "png";
          item.targetExt = "png";
          targetSelect.value = "png";
          switchedToPng = true;
          syncCapsuleUI();
        }

        const card = document.getElementById(`queue-item-${item.id}`);
        if (card) {
          const filenameEl = card.querySelector(".queue-filename");
          const sourceExtEl = card.querySelector(".js-source-ext");
          const originalSizeEl = card.querySelector(".js-original-size");
          if (filenameEl) {
            filenameEl.textContent = editedFile.name;
            filenameEl.setAttribute("title", editedFile.name);
          }
          if (sourceExtEl) {
            sourceExtEl.textContent = "PNG";
          }
          if (originalSizeEl) {
            originalSizeEl.innerHTML = `Editada: <strong>${formatBytes(editedFile.size)}</strong>`;
          }
        }

        updateItemCardStatus(
          item,
          "queued",
          switchedToPng
            ? "Fondo borrado · Exportando a PNG transparente..."
            : "Fondo borrado · Reconvirtiendo..."
        );
        if (!pendingQueue.includes(item.id)) {
          pendingQueue.push(item.id);
        }

        await closeTopLayerDialog(eraserDialog, "apply");
        processNextInQueue();
      } catch (err) {
        ramStatusText.textContent =
          err instanceof Error ? err.message : "No se pudo aplicar el borrado.";
      } finally {
        eraserDialogApplyBtn.disabled = false;
      }
    });
  }

  // Inicializamos el estado visual de la cápsula al cargar la página
  syncCapsuleUI();
})();

