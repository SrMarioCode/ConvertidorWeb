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
  const presetBtns = document.querySelectorAll(".js-preset-btn");

  const fileInput = document.getElementById("file-input");
  const dropzoneCard = document.getElementById("dropzone-card");
  const dropzoneTitle = document.getElementById("dropzone-dynamic-title");
  const dropzoneHint = document.getElementById("dropzone-dynamic-hint");
  const selectFilesBtn = document.getElementById("select-files-btn");
  const demoImageBtn = document.getElementById("demo-image-btn");

  const losslessCheckbox = document.getElementById("lossless-checkbox");
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
  // 2. INICIALIZACIÓN DEL WEB WORKER Y ESTADO DE LA COLA SECUENCIAL
  // ==========================================================================
  const worker = new Worker("/static/js/worker.js", { type: "module" });

  /**
   * Lista de tareas de conversión en memoria.
   * Guardamos solo la referencia al `File` original (que apunta al disco del
   * usuario sin ocupar RAM extra) y la URL del `Blob` de salida.
   */
  const itemsMap = new Map();
  const pendingQueue = [];
  let isWorkerBusy = false;
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
    if (mime.includes("png") || name.endsWith(".png")) return "png";
    if (mime.includes("jpeg") || mime.includes("jpg") || name.endsWith(".jpg") || name.endsWith(".jpeg")) return "jpeg";
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

    const sourceId = sourceSelect.value;
    const targetId = targetSelect.value;
    const sourceLabel = sourceId === "auto" ? "tu imagen" : `tu imagen ${sourceOption.text.trim()}`;
    const targetLabel = targetOption.text.split("(")[0].trim();
    const targetEngine = targetOption.dataset.engine || "OffscreenCanvas";

    // Actualizamos el filtro `accept` del input de archivos
    if (sourceOption && sourceOption.dataset.accept) {
      fileInput.setAttribute("accept", sourceOption.dataset.accept);
    }

    // Actualizamos los textos dinámicos del área de subida
    dropzoneTitle.textContent = `Sube o arrastra ${sourceLabel} para convertirla a ${targetLabel}`;
    dropzoneHint.textContent = `Motor activo: ${targetEngine} · Procesamiento local 1 a 1 sin saturar la memoria RAM.`;

    // Resaltamos el chip de acceso rápido si coincide con la selección actual
    presetBtns.forEach((btn) => {
      const matches =
        btn.dataset.source === sourceId && btn.dataset.target === targetId;
      btn.classList.toggle("is-selected", matches);
    });
  }

  sourceSelect.addEventListener("change", syncCapsuleUI);
  targetSelect.addEventListener("change", syncCapsuleUI);

  // Botón de intercambio rápido (Origen ⇄ Destino)
  swapBtn.addEventListener("click", () => {
    const currentSource = sourceSelect.value;
    const currentTarget = targetSelect.value;

    // Verificamos si el formato de origen existe como destino válido
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
    } else if (currentSource === "auto") {
      // Si estaba en 'Auto', ponemos PNG como destino al intercambiar
      targetSelect.value = currentTarget === "png" ? "webp" : "png";
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

  qualityRange.addEventListener("input", () => {
    qualityValueLabel.textContent = `${qualityRange.value}%`;
  });

  // ==========================================================================
  // 4. RASTERIZACIÓN LIGERA PARA ARCHIVOS VECTORIALES SVG
  // ==========================================================================
  /**
   * Algunos motores de navegador no permiten `createImageBitmap(svgBlob)` dentro
   * de un Web Worker. Para garantizar compatibilidad del 100% con SVG, lo
   * dibujamos en un lienzo temporal en el hilo principal y transferimos el
   * `ImageBitmap` al Worker sin copiar memoria.
   *
   * @param {File} svgFile
   * @returns {Promise<ImageBitmap>}
   */
  function rasterizeSvgToBitmap(svgFile) {
    return new Promise((resolve, reject) => {
      const tempUrl = URL.createObjectURL(svgFile);
      const img = new Image();
      img.onload = async () => {
        try {
          const width = img.naturalWidth || 1024;
          const height = img.naturalHeight || 1024;
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
        reject(new Error("No se pudo interpretar el archivo vectorial SVG."));
      };
      img.src = tempUrl;
    });
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
    const item = itemsMap.get(itemId);

    if (!item) {
      isWorkerBusy = false;
      processNextInQueue();
      return;
    }

    updateQueueHeaderAndRamStatus();
    updateItemCardStatus(item, "working", "Convirtiendo en Worker...");

    try {
      const isSvg =
        item.file.type === "image/svg+xml" ||
        item.file.name.toLowerCase().endsWith(".svg");

      if (isSvg) {
        const svgBitmap = await rasterizeSvgToBitmap(item.file);
        worker.postMessage(
          {
            id: item.id,
            transferredBitmap: svgBitmap,
            targetFormat: item.targetFormat,
            lossless: item.lossless,
            quality: item.quality,
          },
          [svgBitmap] // Transferencia de propiedad 0-copy al Worker
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
      processNextInQueue();
    }
  }

  // Respuesta del Web Worker cuando termina de convertir una imagen
  worker.addEventListener("message", (event) => {
    const {
      id,
      status,
      outputBlob,
      width,
      height,
      durationMs,
      engineUsed,
      errorMessage,
    } = event.data;

    const item = itemsMap.get(id);
    if (item) {
      // Si ya tenía un ObjectURL anterior (por ejemplo, al reconvertir), lo liberamos primero
      if (item.downloadUrl) {
        URL.revokeObjectURL(item.downloadUrl);
        item.downloadUrl = null;
      }

      if (status === "done" && outputBlob) {
        item.downloadUrl = URL.createObjectURL(outputBlob);
        item.outputSize = outputBlob.size;
        item.width = width;
        item.height = height;
        item.durationMs = durationMs;
        item.engineUsed = engineUsed;
        updateItemCardFinished(item);
      } else {
        updateItemCardStatus(item, "error", errorMessage || "Error en conversión");
      }
    }

    // Liberamos el candado y pasamos a la siguiente imagen en la fila
    isWorkerBusy = false;
    processNextInQueue();
  });

  // ==========================================================================
  // 6. CREACIÓN Y ACTUALIZACIÓN DE TARJETAS EN LA LISTA DE DESCARGA
  // ==========================================================================
  function createQueueItemCard(item) {
    const row = document.createElement("article");
    row.className = "queue-item";
    row.id = `queue-item-${item.id}`;

    row.innerHTML = `
      <div class="queue-thumb-box" aria-hidden="true">
        <span>${item.sourceFormat.toUpperCase()}</span>
      </div>
      <div class="queue-info">
        <div class="queue-filename" title="${item.file.name}">${item.file.name}</div>
        <div class="queue-meta">
          <span class="queue-badge">${item.sourceFormat.toUpperCase()} ➔ ${item.targetExt.toUpperCase()}</span>
          <span>Original: <strong>${formatBytes(item.file.size)}</strong></span>
          <span class="js-item-details">En cola para procesar...</span>
        </div>
      </div>
      <div class="queue-actions">
        <span class="queue-badge is-working js-item-status">En cola</span>
        <a class="btn-primary js-download-link" hidden>Descargar</a>
      </div>
    `;

    return row;
  }

  function updateItemCardStatus(item, state, text) {
    const card = document.getElementById(`queue-item-${item.id}`);
    if (!card) return;
    const statusBadge = card.querySelector(".js-item-status");
    const detailsSpan = card.querySelector(".js-item-details");
    const downloadLink = card.querySelector(".js-download-link");

    if (statusBadge) {
      statusBadge.hidden = false;
      statusBadge.textContent = state === "working" ? "Procesando" : "Error";
      statusBadge.className = `queue-badge ${state === "working" ? "is-working" : ""}`;
    }
    if (detailsSpan) {
      detailsSpan.textContent = text;
    }
    if (downloadLink) {
      downloadLink.hidden = true;
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
    const files = Array.from(fileList || []).filter(
      (f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|avif|svg|bmp|gif|ico)$/i.test(f.name)
    );

    if (files.length === 0) return;

    // Si el selector de origen estaba en "Auto", mostramos el formato detectado
    // de la primera imagen subida si coincide con nuestro catálogo
    const firstDetected = detectFormatFromFile(files[0]);
    if (
      sourceSelect.value === "auto" &&
      Array.from(sourceSelect.options).some((opt) => opt.value === firstDetected)
    ) {
      sourceSelect.value = firstDetected;
      // Si origen y destino quedaron iguales (ej. sube un WebP y el destino era WebP),
      // cambiamos automáticamente el destino a PNG para ofrecer una conversión útil
      if (targetSelect.value === firstDetected) {
        targetSelect.value = firstDetected === "png" ? "webp" : "png";
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
      item.targetFormat = targetFormat;
      item.targetExt = targetExt;
      item.lossless = lossless;
      item.quality = quality;
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

    // 3. Ocultamos la sección con transición suave y limpiamos el DOM
    await hideElement(queueSection);
    queueList.innerHTML = "";
    ramStatusText.textContent = "Memoria liberada · 0 imágenes en sesión";
  });

  // Inicializamos el estado visual de la cápsula al cargar la página
  syncCapsuleUI();
})();
