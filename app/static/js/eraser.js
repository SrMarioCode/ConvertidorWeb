/**
 * ============================================================================
 * Motor del Borrador Manual de Fondo con Lápiz — app/static/js/eraser.js
 * ============================================================================
 * Arquitectura educativa y de mínimo consumo de memoria RAM:
 * ----------------------------------------------------------
 * 1. SIN SNAPSHOTS PESADOS EN EL HISTORIAL:
 *    Un editor ingenuo guarda copias completas `ImageData` por cada trazo
 *    (una imagen 4K consumiría ~48 MB por cada paso de "Deshacer").
 *    Aquí guardamos únicamente las coordenadas vectoriales de cada trazo
 *    (`{ tool, size, softness, points }`), que ocupan apenas unos pocos KB.
 * 2. MÁSCARA DE BORRADO SEPARADA (`maskCanvas`):
 *    Mantenemos un único `ImageBitmap` original en memoria de GPU y una
 *    máscara alfa de borrado (`maskCanvas`).
 *    - "Borrador": pinta en `maskCanvas` y recorta directo en el lienzo
 *      visible usando `globalCompositeOperation = "destination-out"`.
 *    - "Encerrar" (`keep-inside`): el usuario rodea el sujeto con una línea;
 *      al soltar, rellenamos todo lo exterior con la regla `"evenodd"` sobre
 *      `maskCanvas` usando un `Path2D` compuesto (rectángulo total + polígono)
 *      en una sola pasada sin crear lienzos temporales gigantes.
 *    - "Restaurar": borra esa zona de `maskCanvas` y recompone únicamente
 *      el rectángulo modificado desde `originalBitmap`.
 *    - "Selección": pinta una máscara roja translúcida en un lienzo superior
 *      con opacidad CSS uniforme; al confirmar, convierte esos trazos en un
 *      único paso reversible del historial.
 * 3. LIBERACIÓN EXPLÍCITA DE RAM:
 *    Al limpiar o cerrar el editor se ejecuta `originalBitmap.close()` y todos
 *    los lienzos internos se reducen a `1×1` píxeles.
 * ============================================================================
 */

(function registerEraserEngine(globalScope) {
  /**
   * Decodifica un File/Blob (incluyendo SVG e ICO) a un `ImageBitmap` sin
   * mantener URLs temporales en memoria.
   *
   * @param {File|Blob} file
   * @returns {Promise<ImageBitmap>}
   */
  async function decodeImageFileToBitmap(file) {
    const lowerName = (file.name || "").toLowerCase();
    const isSvg = file.type === "image/svg+xml" || lowerName.endsWith(".svg");
    const isIco =
      file.type === "image/x-icon" ||
      file.type === "image/vnd.microsoft.icon" ||
      lowerName.endsWith(".ico");

    if (!isSvg && !isIco && typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file);
      } catch (_) {
        // Si createImageBitmap falla con algún formato especial, caemos a <img>
      }
    }

    let sourceBlob = file;
    if (isSvg && file.type !== "image/svg+xml") {
      sourceBlob = new Blob([file], { type: "image/svg+xml" });
    }

    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(sourceBlob);
      const img = new Image();
      img.onload = async () => {
        try {
          const width = img.naturalWidth || img.width || 1024;
          const height = img.naturalHeight || img.height || 1024;
          const tempCanvas = document.createElement("canvas");
          tempCanvas.width = width;
          tempCanvas.height = height;
          const ctx = tempCanvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          URL.revokeObjectURL(url);

          const bitmap = await createImageBitmap(tempCanvas);
          tempCanvas.width = 1;
          tempCanvas.height = 1;
          resolve(bitmap);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("No se pudo decodificar la imagen en el borrador."));
      };
      img.src = url;
    });
  }

  /**
   * Sincroniza las propiedades CSS personalizadas (`--attr-min`, `--attr-max`,
   * `--control-value`) de un `<input type="range">` según la guía `slider`.
   *
   * @param {HTMLInputElement} slider
   * @param {string} [valueText]
   */
  function syncModernRangeSlider(slider, valueText) {
    if (!slider) return;
    slider.style.setProperty("--attr-min", slider.min || "0");
    slider.style.setProperty("--attr-max", slider.max || "100");
    slider.style.setProperty("--control-value", slider.value);
    if (valueText) {
      slider.setAttribute("aria-valuetext", valueText);
    }
  }

  /**
   * Crea una instancia controladora conectada al parcial `partials/eraser_studio.html`.
   *
   * @param {object} [options]
   * @param {(state: object) => void} [options.onStateChange]
   * @returns {object} API del editor
   */
  function createEraserController(options = {}) {
    const studioEl = document.getElementById("eraser-studio");
    const toolbarEl = document.getElementById("eraser-toolbar");
    const viewportEl = document.getElementById("eraser-viewport");
    const stageEl = document.getElementById("eraser-stage");
    const canvas = document.getElementById("eraser-canvas");
    const selectionCanvas = document.getElementById("eraser-selection-canvas");
    const brushCursorEl = document.getElementById("eraser-brush-cursor");

    const toolButtons = document.querySelectorAll(".eraser-tool-btn[data-tool]");
    const brushSizeInput = document.getElementById("eraser-brush-size");
    const brushSizeLabel = document.getElementById("eraser-brush-size-value");
    const brushSoftnessInput = document.getElementById("eraser-brush-softness");
    const brushSoftnessLabel = document.getElementById("eraser-brush-softness-value");

    const undoBtn = document.getElementById("eraser-undo-btn");
    const redoBtn = document.getElementById("eraser-redo-btn");
    const resetBtn = document.getElementById("eraser-reset-btn");

    const zoomOutBtn = document.getElementById("eraser-zoom-out-btn");
    const zoomResetBtn = document.getElementById("eraser-zoom-reset-btn");
    const zoomInBtn = document.getElementById("eraser-zoom-in-btn");
    const swatchButtons = document.querySelectorAll(".eraser-swatch-btn[data-preview-bg]");

    const selectionBarEl = document.getElementById("eraser-selection-bar");
    const applySelectionBtn = document.getElementById("eraser-apply-selection-btn");
    const clearSelectionBtn = document.getElementById("eraser-clear-selection-btn");
    const telemetryTextEl = document.getElementById("eraser-telemetry-text");

    if (!studioEl || !viewportEl || !stageEl || !canvas || !selectionCanvas) {
      return null;
    }

    const ctx = canvas.getContext("2d", { alpha: true });
    const selCtx = selectionCanvas.getContext("2d", { alpha: true });

    // Lienzo interno de máscara de borrado (alpha = 255 -> zona borrada)
    const maskCanvas = document.createElement("canvas");
    const maskCtx = maskCanvas.getContext("2d", { alpha: true });

    // Pequeña caché de punta de pincel suavizado (solo 1 punta activa a la vez)
    let cachedTipKey = "";
    let cachedTipCanvas = null;

    // Estado del editor
    let originalBitmap = null;
    let sourceFile = null;
    let imgWidth = 0;
    let imgHeight = 0;
    let fitWidth = 0;
    let fitHeight = 0;
    let zoom = 1;

    let currentTool = "erase"; // "erase" | "lasso" | "select" | "restore" | "pan"
    let spacePanActive = false;
    let statusHintMessage = "";
    let brushSize = Number(brushSizeInput?.value) || 36;
    let brushSoftness = Number(brushSoftnessInput?.value) || 15;

    // Historial basado en trazos vectoriales (KB de RAM en lugar de MB por copia)
    const undoStack = [];
    const redoStack = [];
    const selectionStrokes = [];

    // Estado de puntero activo
    let activePointerId = null;
    let currentStroke = null;
    let panLastPointer = null;
    let lastStageClientRect = null;

    const SELECTION_COLOR = "#d93025"; // Rojo Google para marcar áreas a eliminar

    // ========================================================================
    // 1. UTILIDADES DE PUNTA DE PINCEL Y TRAZADO DETERMINISTA
    // ========================================================================
    function getEffectiveTool() {
      return spacePanActive ? "pan" : currentTool;
    }

    function getSoftBrushTip(size, softness, color) {
      const d = Math.max(2, Math.ceil(size));
      const key = `${d}:${softness}:${color}`;
      if (cachedTipKey === key && cachedTipCanvas) {
        return cachedTipCanvas;
      }

      if (!cachedTipCanvas) {
        cachedTipCanvas = document.createElement("canvas");
      }
      cachedTipCanvas.width = d;
      cachedTipCanvas.height = d;
      const tipCtx = cachedTipCanvas.getContext("2d");
      const r = d / 2;
      const innerR = Math.max(0, r * (1 - softness / 100));

      const grad = tipCtx.createRadialGradient(r, r, innerR, r, r, r);
      grad.addColorStop(0, color);
      grad.addColorStop(1, "rgba(0, 0, 0, 0)");

      tipCtx.clearRect(0, 0, d, d);
      tipCtx.fillStyle = grad;
      tipCtx.fillRect(0, 0, d, d);

      cachedTipKey = key;
      return cachedTipCanvas;
    }

    /**
     * Dibuja un segmento entre dos puntos `p0` y `p1` sobre el contexto indicado.
     * Usamos interpolación densa para que los trazos rápidos no dejen huecos.
     */
    function drawSegmentOnContext(targetCtx, p0, p1, size, softness, color, compositeOp) {
      targetCtx.save();
      targetCtx.globalCompositeOperation = compositeOp;

      if (softness <= 0) {
        targetCtx.strokeStyle = color;
        targetCtx.fillStyle = color;
        targetCtx.lineCap = "round";
        targetCtx.lineJoin = "round";
        targetCtx.lineWidth = size;
        targetCtx.beginPath();
        targetCtx.moveTo(p0.x, p0.y);
        if (p0.x === p1.x && p0.y === p1.y) {
          targetCtx.arc(p0.x, p0.y, size / 2, 0, Math.PI * 2);
          targetCtx.fill();
        } else {
          targetCtx.lineTo(p1.x, p1.y);
          targetCtx.stroke();
        }
      } else {
        const tip = getSoftBrushTip(size, softness, color);
        const r = tip.width / 2;
        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const dist = Math.hypot(dx, dy);
        const step = Math.max(1, size * 0.14);
        const steps = Math.max(1, Math.ceil(dist / step));

        for (let i = 0; i <= steps; i += 1) {
          const t = steps === 0 ? 0 : i / steps;
          const x = p0.x + dx * t;
          const y = p0.y + dy * t;
          targetCtx.drawImage(tip, x - r, y - r);
        }
      }

      targetCtx.restore();
    }

    /**
     * Dibuja un trazo completo (para reproducción al Deshacer/Rehacer).
     */
    function drawStrokeOnContext(targetCtx, stroke, color, compositeOp) {
      const { size, softness, points } = stroke;
      if (!points || points.length === 0) return;

      if (points.length === 1) {
        drawSegmentOnContext(
          targetCtx,
          points[0],
          points[0],
          size,
          softness,
          color,
          compositeOp
        );
        return;
      }

      if (softness <= 0) {
        targetCtx.save();
        targetCtx.globalCompositeOperation = compositeOp;
        targetCtx.strokeStyle = color;
        targetCtx.lineCap = "round";
        targetCtx.lineJoin = "round";
        targetCtx.lineWidth = size;
        targetCtx.beginPath();
        targetCtx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i += 1) {
          targetCtx.lineTo(points[i].x, points[i].y);
        }
        targetCtx.stroke();
        targetCtx.restore();
      } else {
        for (let i = 1; i < points.length; i += 1) {
          drawSegmentOnContext(
            targetCtx,
            points[i - 1],
            points[i],
            size,
            softness,
            color,
            compositeOp
          );
        }
      }
    }

    /**
     * Calcula el área de un polígono (fórmula del cordón / Shoelace) para validar
     * que el trazo de "Encerrar" realmente rodea una superficie y no fue un clic.
     */
    function calculatePolygonArea(points) {
      if (!points || points.length < 3) return 0;
      let sum = 0;
      for (let i = 0; i < points.length; i += 1) {
        const p1 = points[i];
        const p2 = points[(i + 1) % points.length];
        sum += p1.x * p2.y - p2.x * p1.y;
      }
      return Math.abs(sum) / 2;
    }

    /**
     * Construye un `Path2D` compuesto formado por un rectángulo exterior completo
     * más el polígono del usuario. Al rellenarlo con la regla `"evenodd"`, todo
     * lo exterior al contorno queda cubierto (borrado) y el interior intacto,
     * sin importar si el usuario dibujó en sentido horario o antihorario.
     */
    function buildKeepInsidePath(points) {
      if (!points || points.length < 3) return null;
      let minX = 0;
      let minY = 0;
      let maxX = imgWidth;
      let maxY = imgHeight;
      for (let i = 0; i < points.length; i += 1) {
        if (points[i].x < minX) minX = points[i].x;
        if (points[i].y < minY) minY = points[i].y;
        if (points[i].x > maxX) maxX = points[i].x;
        if (points[i].y > maxY) maxY = points[i].y;
      }

      const pad = 16;
      const path = new Path2D();
      path.rect(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2);
      path.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        path.lineTo(points[i].x, points[i].y);
      }
      path.closePath();
      return path;
    }

    /**
     * Renderiza la vista previa en vivo mientras el usuario rodea el objeto con
     * "Encerrar": tiñe de rojo suave la zona exterior que se borrará y muestra
     * una línea punteada de cierre automático hasta el punto inicial.
     */
    function renderLassoPreview(points) {
      selectionCanvas.classList.add("is-lasso-preview");
      selCtx.clearRect(0, 0, imgWidth, imgHeight);
      if (!points || points.length === 0) return;

      const rect = lastStageClientRect || stageEl.getBoundingClientRect();
      const scale = rect.width > 0 ? imgWidth / rect.width : 1;

      selCtx.save();

      if (points.length >= 3) {
        const outsidePath = buildKeepInsidePath(points);
        if (outsidePath) {
          selCtx.fillStyle = "rgba(217, 48, 37, 0.34)";
          selCtx.fill(outsidePath, "evenodd");
        }
      }

      if (points.length >= 2) {
        const first = points[0];
        const last = points[points.length - 1];
        selCtx.beginPath();
        selCtx.moveTo(last.x, last.y);
        selCtx.lineTo(first.x, first.y);
        selCtx.setLineDash([6 * scale, 5 * scale]);
        selCtx.lineWidth = Math.max(1.5, 2 * scale);
        selCtx.strokeStyle = "rgba(255, 255, 255, 0.92)";
        selCtx.stroke();
        selCtx.strokeStyle = "rgba(11, 87, 208, 0.85)";
        selCtx.lineDashOffset = 6 * scale;
        selCtx.stroke();
        selCtx.setLineDash([]);
        selCtx.lineDashOffset = 0;
      }

      selCtx.beginPath();
      selCtx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        selCtx.lineTo(points[i].x, points[i].y);
      }
      selCtx.lineCap = "round";
      selCtx.lineJoin = "round";

      if (points.length > 1) {
        selCtx.lineWidth = Math.max(2, 4.2 * scale);
        selCtx.strokeStyle = "rgba(255, 255, 255, 0.95)";
        selCtx.stroke();

        selCtx.lineWidth = Math.max(1.2, 2.2 * scale);
        selCtx.strokeStyle = "#0b57d0";
        selCtx.stroke();
      }

      // Marcador del punto de inicio del contorno
      selCtx.beginPath();
      selCtx.arc(points[0].x, points[0].y, Math.max(3, 5 * scale), 0, Math.PI * 2);
      selCtx.fillStyle = "#ffffff";
      selCtx.fill();
      selCtx.lineWidth = Math.max(1.5, 2 * scale);
      selCtx.strokeStyle = "#0b57d0";
      selCtx.stroke();

      selCtx.restore();
    }

    // ========================================================================
    // 2. COMPOSICIÓN Y ACTUALIZACIÓN PARCIAL DE ALTA EFICIENCIA
    // ========================================================================
    function recompositeRegion(x, y, w, h) {
      if (!originalBitmap) return;
      const rx = Math.max(0, Math.floor(x));
      const ry = Math.max(0, Math.floor(y));
      const rw = Math.min(imgWidth - rx, Math.ceil(x + w) - rx);
      const rh = Math.min(imgHeight - ry, Math.ceil(y + h) - ry);
      if (rw <= 0 || rh <= 0) return;

      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      ctx.clearRect(rx, ry, rw, rh);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(originalBitmap, rx, ry, rw, rh, rx, ry, rw, rh);
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(maskCanvas, rx, ry, rw, rh, rx, ry, rw, rh);
      ctx.restore();
    }

    function recompositeFullCanvas() {
      if (!originalBitmap) return;
      recompositeRegion(0, 0, imgWidth, imgHeight);
    }

    function applyEntryToMask(entry) {
      if (entry.tool === "erase") {
        drawStrokeOnContext(maskCtx, entry, "#000000", "source-over");
      } else if (entry.tool === "restore") {
        drawStrokeOnContext(maskCtx, entry, "#000000", "destination-out");
      } else if (entry.tool === "keep-inside" && Array.isArray(entry.points)) {
        const outsidePath = buildKeepInsidePath(entry.points);
        if (outsidePath) {
          maskCtx.save();
          maskCtx.globalCompositeOperation = "source-over";
          maskCtx.fillStyle = "#000000";
          maskCtx.fill(outsidePath, "evenodd");
          maskCtx.restore();
        }
      } else if (entry.tool === "batch" && Array.isArray(entry.strokes)) {
        entry.strokes.forEach((s) => {
          drawStrokeOnContext(maskCtx, s, "#000000", "source-over");
        });
      }
    }

    function rebuildMaskFromHistory() {
      maskCtx.clearRect(0, 0, imgWidth, imgHeight);
      undoStack.forEach(applyEntryToMask);
      recompositeFullCanvas();
    }

    function rebuildSelectionCanvas() {
      selectionCanvas.classList.remove("is-lasso-preview");
      selCtx.clearRect(0, 0, imgWidth, imgHeight);
      selectionStrokes.forEach((stroke) => {
        drawStrokeOnContext(selCtx, stroke, SELECTION_COLOR, "source-over");
      });
    }

    // ========================================================================
    // 3. SINCRONIZACIÓN DE INTERFAZ Y TELEMETRÍA
    // ========================================================================
    function setToolbarButtonDisabled(btn, isDisabled) {
      if (!btn) return;
      btn.setAttribute("aria-disabled", isDisabled ? "true" : "false");
    }

    function updateUIState() {
      const hasImage = Boolean(originalBitmap);
      const hasSelection = selectionStrokes.length > 0;
      const effectiveTool = getEffectiveTool();

      setToolbarButtonDisabled(
        undoBtn,
        !hasImage || (undoStack.length === 0 && !hasSelection)
      );
      setToolbarButtonDisabled(redoBtn, !hasImage || redoStack.length === 0);
      setToolbarButtonDisabled(
        resetBtn,
        !hasImage || (undoStack.length === 0 && !hasSelection)
      );

      if (applySelectionBtn) {
        applySelectionBtn.disabled = !hasImage || !hasSelection;
      }
      if (clearSelectionBtn) {
        clearSelectionBtn.disabled = !hasImage || !hasSelection;
      }

      if (selectionBarEl) {
        selectionBarEl.hidden = !(effectiveTool === "select" || hasSelection);
      }

      if (zoomResetBtn) {
        zoomResetBtn.textContent = `${Math.round(zoom * 100)}%`;
      }

      // Atributos visuales del lienzo y estudio según herramienta activa
      studioEl.dataset.activeTool = effectiveTool;
      stageEl.dataset.tool = effectiveTool;
      canvas.classList.toggle("is-panning-mode", effectiveTool === "pan");

      if (telemetryTextEl) {
        if (!hasImage) {
          telemetryTextEl.textContent =
            "Carga una imagen para empezar a borrar el fondo con el lápiz.";
        } else {
          const totalStrokes = undoStack.length + selectionStrokes.length;
          const pendingSel = hasSelection
            ? ` · ${selectionStrokes.length} trazo${selectionStrokes.length === 1 ? "" : "s"} de selección pendiente${selectionStrokes.length === 1 ? "" : "s"}`
            : "";
          const suffixHint = statusHintMessage
            ? ` · ${statusHintMessage}`
            : effectiveTool === "lasso"
              ? " · Rodea lo que quieres conservar y suelta para borrar lo de afuera"
              : "";
          telemetryTextEl.textContent = `${imgWidth} × ${imgHeight} px · ${totalStrokes} paso${totalStrokes === 1 ? "" : "s"} en historial (máscara ligera)${pendingSel}${suffixHint}`;
        }
      }

      if (typeof options.onStateChange === "function") {
        options.onStateChange({
          hasImage,
          width: imgWidth,
          height: imgHeight,
          undoCount: undoStack.length,
          selectionCount: selectionStrokes.length,
        });
      }
    }

    function selectTool(toolName) {
      currentTool = toolName;
      statusHintMessage = "";
      toolButtons.forEach((btn) => {
        const active = btn.dataset.tool === toolName;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
      });
      if ((toolName === "pan" || toolName === "lasso") && brushCursorEl) {
        brushCursorEl.hidden = true;
      }
      updateUIState();
    }

    function updateStageLayout(preserveZoom = true) {
      if (!imgWidth || !imgHeight) return;
      const availW = Math.max(200, (viewportEl.clientWidth || 780) - 32);
      const availH = Math.max(180, (viewportEl.clientHeight || 440) - 32);
      const fitScale = Math.min(availW / imgWidth, availH / imgHeight, 4);

      fitWidth = Math.max(64, Math.round(imgWidth * fitScale));
      fitHeight = Math.max(64, Math.round(imgHeight * fitScale));

      if (!preserveZoom) {
        zoom = 1;
      }

      stageEl.style.width = `${Math.round(fitWidth * zoom)}px`;
      stageEl.style.height = `${Math.round(fitHeight * zoom)}px`;
      lastStageClientRect = stageEl.getBoundingClientRect();
      updateUIState();
    }

    function setZoom(nextZoom) {
      const clamped = Math.min(5, Math.max(0.5, Math.round(nextZoom * 100) / 100));
      if (clamped === zoom) return;

      // Conservamos el punto central de desplazamiento al hacer zoom
      const prevW = stageEl.offsetWidth || fitWidth;
      const prevH = stageEl.offsetHeight || fitHeight;
      const centerRatioX =
        prevW > 0 ? (viewportEl.scrollLeft + viewportEl.clientWidth / 2) / prevW : 0.5;
      const centerRatioY =
        prevH > 0 ? (viewportEl.scrollTop + viewportEl.clientHeight / 2) / prevH : 0.5;

      zoom = clamped;
      updateStageLayout(true);

      const newW = stageEl.offsetWidth || fitWidth;
      const newH = stageEl.offsetHeight || fitHeight;
      viewportEl.scrollLeft = Math.max(0, centerRatioX * newW - viewportEl.clientWidth / 2);
      viewportEl.scrollTop = Math.max(0, centerRatioY * newH - viewportEl.clientHeight / 2);
    }

    // ========================================================================
    // 4. EVENTOS DE PUNTERO PARA DIBUJAR CON LÁPIZ / DEDO / RATÓN Y MOVER 2D
    // ========================================================================
    let lastCursorClient = null;

    function clientToCanvasCoords(clientX, clientY) {
      const rect = stageEl.getBoundingClientRect();
      lastStageClientRect = rect;
      if (!rect.width || !rect.height) return { x: 0, y: 0 };
      return {
        x: ((clientX - rect.left) / rect.width) * imgWidth,
        y: ((clientY - rect.top) / rect.height) * imgHeight,
      };
    }

    function updateBrushCursor(clientX, clientY) {
      if (typeof clientX === "number" && typeof clientY === "number") {
        lastCursorClient = { x: clientX, y: clientY };
      }

      const effectiveTool = getEffectiveTool();
      if (
        !brushCursorEl ||
        !originalBitmap ||
        effectiveTool === "pan" ||
        effectiveTool === "lasso" ||
        !lastCursorClient
      ) {
        if (brushCursorEl) brushCursorEl.hidden = true;
        return;
      }

      const rect = stageEl.getBoundingClientRect();
      lastStageClientRect = rect;
      if (!rect.width || !rect.height) return;

      const displayDiameter = Math.max(4, (brushSize / imgWidth) * rect.width);
      const localX = lastCursorClient.x - rect.left;
      const localY = lastCursorClient.y - rect.top;

      if (localX < 0 || localY < 0 || localX > rect.width || localY > rect.height) {
        brushCursorEl.hidden = true;
        return;
      }

      brushCursorEl.hidden = false;
      brushCursorEl.style.width = `${displayDiameter}px`;
      brushCursorEl.style.height = `${displayDiameter}px`;
      brushCursorEl.style.left = `${localX}px`;
      brushCursorEl.style.top = `${localY}px`;
      brushCursorEl.dataset.tool = effectiveTool;
    }

    canvas.addEventListener("pointerdown", (e) => {
      if (!originalBitmap || e.button !== 0 || activePointerId !== null) return;

      activePointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      lastStageClientRect = stageEl.getBoundingClientRect();
      statusHintMessage = "";

      const tool = getEffectiveTool();
      if (tool === "pan") {
        panLastPointer = { x: e.clientX, y: e.clientY };
        stageEl.classList.add("is-grabbing");
        return;
      }

      e.preventDefault();
      const pt = clientToCanvasCoords(e.clientX, e.clientY);
      updateBrushCursor(e.clientX, e.clientY);

      currentStroke = {
        tool,
        size: brushSize,
        softness: brushSoftness,
        points: [pt],
      };

      // Dibujamos el primer punto o vista previa inmediata
      if (tool === "erase") {
        drawSegmentOnContext(maskCtx, pt, pt, brushSize, brushSoftness, "#000000", "source-over");
        drawSegmentOnContext(ctx, pt, pt, brushSize, brushSoftness, "#000000", "destination-out");
      } else if (tool === "restore") {
        drawSegmentOnContext(maskCtx, pt, pt, brushSize, brushSoftness, "#000000", "destination-out");
        const pad = brushSize / 2 + 4;
        recompositeRegion(pt.x - pad, pt.y - pad, pad * 2, pad * 2);
      } else if (tool === "select") {
        drawSegmentOnContext(
          selCtx,
          pt,
          pt,
          brushSize,
          brushSoftness,
          SELECTION_COLOR,
          "source-over"
        );
      } else if (tool === "lasso") {
        renderLassoPreview(currentStroke.points);
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!originalBitmap) return;
      updateBrushCursor(e.clientX, e.clientY);

      if (activePointerId !== e.pointerId) return;

      if (panLastPointer) {
        viewportEl.scrollLeft -= e.clientX - panLastPointer.x;
        viewportEl.scrollTop -= e.clientY - panLastPointer.y;
        panLastPointer = { x: e.clientX, y: e.clientY };
        return;
      }

      if (!currentStroke) return;
      const pt = clientToCanvasCoords(e.clientX, e.clientY);
      const prevPt = currentStroke.points[currentStroke.points.length - 1];

      if (currentStroke.tool === "lasso") {
        // Diezmado ligero (1.5 px en coordenadas de imagen) para ahorrar RAM en trazos largos
        if (Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y) >= 1.5) {
          currentStroke.points.push(pt);
          renderLassoPreview(currentStroke.points);
        }
        return;
      }

      currentStroke.points.push(pt);

      if (currentStroke.tool === "erase") {
        drawSegmentOnContext(
          maskCtx,
          prevPt,
          pt,
          currentStroke.size,
          currentStroke.softness,
          "#000000",
          "source-over"
        );
        drawSegmentOnContext(
          ctx,
          prevPt,
          pt,
          currentStroke.size,
          currentStroke.softness,
          "#000000",
          "destination-out"
        );
      } else if (currentStroke.tool === "restore") {
        drawSegmentOnContext(
          maskCtx,
          prevPt,
          pt,
          currentStroke.size,
          currentStroke.softness,
          "#000000",
          "destination-out"
        );
        const pad = currentStroke.size / 2 + 4;
        const minX = Math.min(prevPt.x, pt.x) - pad;
        const minY = Math.min(prevPt.y, pt.y) - pad;
        const maxX = Math.max(prevPt.x, pt.x) + pad;
        const maxY = Math.max(prevPt.y, pt.y) + pad;
        recompositeRegion(minX, minY, maxX - minX, maxY - minY);
      } else if (currentStroke.tool === "select") {
        drawSegmentOnContext(
          selCtx,
          prevPt,
          pt,
          currentStroke.size,
          currentStroke.softness,
          SELECTION_COLOR,
          "source-over"
        );
      }
    });

    function finishActivePointer(e) {
      if (activePointerId === null || (e && activePointerId !== e.pointerId)) return;

      if (panLastPointer) {
        panLastPointer = null;
        stageEl.classList.remove("is-grabbing");
      }

      if (currentStroke) {
        if (currentStroke.tool === "lasso") {
          const wasCanceled = e?.type === "pointercancel";
          if (!wasCanceled && e) {
            const finalPt = clientToCanvasCoords(e.clientX, e.clientY);
            const lastPt = currentStroke.points[currentStroke.points.length - 1];
            if (Math.hypot(finalPt.x - lastPt.x, finalPt.y - lastPt.y) >= 0.5) {
              currentStroke.points.push(finalPt);
            }
          }

          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (let i = 0; i < currentStroke.points.length; i += 1) {
            const p = currentStroke.points[i];
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
          }

          const minAreaThreshold = Math.min(16, imgWidth * imgHeight * 0.01);
          const enclosesRegion =
            !wasCanceled &&
            currentStroke.points.length >= 3 &&
            maxX - minX >= 4 &&
            maxY - minY >= 4 &&
            calculatePolygonArea(currentStroke.points) >= minAreaThreshold;

          rebuildSelectionCanvas();

          if (enclosesRegion) {
            const keepInsideEntry = {
              tool: "keep-inside",
              points: currentStroke.points,
            };
            undoStack.push(keepInsideEntry);
            redoStack.length = 0;
            applyEntryToMask(keepInsideEntry);
            recompositeFullCanvas();
            statusHintMessage = "Todo lo exterior a la línea fue borrado (Ctrl+Z para deshacer)";
          } else if (!wasCanceled) {
            statusHintMessage = "Rodea un área mayor para conservarla y borrar lo de afuera";
          }
        } else if (currentStroke.tool === "select") {
          selectionStrokes.push(currentStroke);
        } else {
          undoStack.push(currentStroke);
          redoStack.length = 0;
        }
        currentStroke = null;
        updateUIState();
      }

      if (e && canvas.hasPointerCapture?.(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
      activePointerId = null;
    }

    canvas.addEventListener("pointerup", finishActivePointer);
    canvas.addEventListener("pointercancel", finishActivePointer);
    canvas.addEventListener("lostpointercapture", () => {
      finishActivePointer(null);
    });
    canvas.addEventListener("pointerleave", () => {
      lastCursorClient = null;
      if (brushCursorEl && activePointerId === null) {
        brushCursorEl.hidden = true;
      }
    });

    // Fallback 2D Panning cuando el navegador no soporta `scroll-axis-lock: none`
    if (!CSS.supports("scroll-axis-lock", "none")) {
      viewportEl.addEventListener(
        "wheel",
        (e) => {
          if (e.ctrlKey) return;
          e.preventDefault();
          viewportEl.scrollLeft += e.deltaX;
          viewportEl.scrollTop += e.deltaY;
        },
        { passive: false }
      );

      let viewportPanLast = null;
      viewportEl.addEventListener("pointerdown", (e) => {
        if (e.target === canvas) return;
        const rect = viewportEl.getBoundingClientRect();
        if (
          !e.isPrimary ||
          e.button !== 0 ||
          e.clientX - rect.left - viewportEl.clientLeft >= viewportEl.clientWidth ||
          e.clientY - rect.top - viewportEl.clientTop >= viewportEl.clientHeight
        ) {
          return;
        }
        viewportPanLast = { x: e.clientX, y: e.clientY };
        viewportEl.setPointerCapture(e.pointerId);
      });

      viewportEl.addEventListener("pointermove", (e) => {
        if (!viewportPanLast) return;
        viewportEl.scrollLeft -= e.clientX - viewportPanLast.x;
        viewportEl.scrollTop -= e.clientY - viewportPanLast.y;
        viewportPanLast = { x: e.clientX, y: e.clientY };
      });

      const endViewportPan = () => {
        viewportPanLast = null;
      };
      viewportEl.addEventListener("pointerup", endViewportPan);
      viewportEl.addEventListener("pointercancel", endViewportPan);
    }

    // Zoom rápido con Ctrl + rueda sobre el lienzo
    viewportEl.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey || !originalBitmap) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 0.87;
        setZoom(zoom * factor);
      },
      { passive: false }
    );

    // ========================================================================
    // 5. ACCIONES DE HERRAMIENTAS, HISTORIAL Y SELECCIÓN
    // ========================================================================
    function applySelectionErase() {
      if (!originalBitmap || selectionStrokes.length === 0) return;

      const batchEntry = {
        tool: "batch",
        strokes: selectionStrokes.splice(0, selectionStrokes.length),
      };
      undoStack.push(batchEntry);
      redoStack.length = 0;

      applyEntryToMask(batchEntry);
      selectionCanvas.classList.remove("is-lasso-preview");
      selCtx.clearRect(0, 0, imgWidth, imgHeight);
      recompositeFullCanvas();
      statusHintMessage = "Área seleccionada borrada";
      updateUIState();
    }

    function clearSelectionMask() {
      if (selectionStrokes.length === 0) return;
      selectionStrokes.length = 0;
      selectionCanvas.classList.remove("is-lasso-preview");
      selCtx.clearRect(0, 0, imgWidth, imgHeight);
      statusHintMessage = "Selección cancelada";
      updateUIState();
    }

    function undoLastAction() {
      if (!originalBitmap) return;
      if (selectionStrokes.length > 0) {
        selectionStrokes.pop();
        rebuildSelectionCanvas();
        statusHintMessage = "Trazo de selección deshecho";
        updateUIState();
        return;
      }
      if (undoStack.length === 0) return;
      const last = undoStack.pop();
      redoStack.push(last);
      rebuildMaskFromHistory();
      statusHintMessage = "Último paso deshecho";
      updateUIState();
    }

    function redoLastAction() {
      if (!originalBitmap || redoStack.length === 0) return;
      const next = redoStack.pop();
      undoStack.push(next);
      applyEntryToMask(next);
      recompositeFullCanvas();
      statusHintMessage = "Paso rehecho";
      updateUIState();
    }

    function resetAllEdits() {
      if (!originalBitmap) return;
      undoStack.length = 0;
      redoStack.length = 0;
      selectionStrokes.length = 0;
      selectionCanvas.classList.remove("is-lasso-preview");
      maskCtx.clearRect(0, 0, imgWidth, imgHeight);
      selCtx.clearRect(0, 0, imgWidth, imgHeight);
      recompositeFullCanvas();
      statusHintMessage = "Imagen original restaurada";
      updateUIState();
    }

    // Navegación por teclado del toolbar (`focusgroup` con fallback roving tabindex)
    if (toolbarEl && !("focusGroup" in HTMLElement.prototype)) {
      const toolbarItems = Array.from(
        toolbarEl.querySelectorAll('button[type="button"]')
      );
      if (toolbarItems.length > 0) {
        toolbarItems.forEach((btn, index) => {
          btn.tabIndex = index === 0 ? 0 : -1;
        });

        toolbarEl.addEventListener("focusin", ({ target }) => {
          const btn = target?.closest?.('button[type="button"]');
          if (!btn || !toolbarItems.includes(btn)) return;
          toolbarItems.forEach((item) => {
            item.tabIndex = item === btn ? 0 : -1;
          });
        });

        toolbarEl.addEventListener("keydown", (e) => {
          const currentBtn = e.target?.closest?.('button[type="button"]');
          const currentIndex = currentBtn ? toolbarItems.indexOf(currentBtn) : -1;
          if (currentIndex === -1) return;

          const vertical = toolbarEl.getAttribute("aria-orientation") === "vertical";
          const rtl = getComputedStyle(toolbarEl).direction === "rtl";
          const steps = vertical
            ? { ArrowDown: 1, ArrowUp: -1 }
            : { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 };

          let nextIndex = null;
          if (e.key in steps) {
            nextIndex =
              (currentIndex + steps[e.key] + toolbarItems.length) %
              toolbarItems.length;
          } else if (e.key === "Home") {
            nextIndex = 0;
          } else if (e.key === "End") {
            nextIndex = toolbarItems.length - 1;
          }

          if (nextIndex !== null) {
            e.preventDefault();
            toolbarItems[nextIndex].focus();
          }
        });
      }
    }

    // Conexión de botones de la barra de herramientas
    toolButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        selectTool(btn.dataset.tool);
      });
    });

    if (brushSizeInput) {
      syncModernRangeSlider(brushSizeInput, `${brushSizeInput.value} píxeles`);
      brushSizeInput.addEventListener("input", () => {
        brushSize = Number(brushSizeInput.value) || 36;
        if (brushSizeLabel) {
          brushSizeLabel.textContent = `${brushSize} px`;
        }
        syncModernRangeSlider(brushSizeInput, `${brushSize} píxeles`);
      });
    }

    if (brushSoftnessInput) {
      syncModernRangeSlider(brushSoftnessInput, `${brushSoftnessInput.value}%`);
      brushSoftnessInput.addEventListener("input", () => {
        brushSoftness = Number(brushSoftnessInput.value) || 0;
        if (brushSoftnessLabel) {
          brushSoftnessLabel.textContent = `${brushSoftness}%`;
        }
        syncModernRangeSlider(brushSoftnessInput, `${brushSoftness}%`);
      });
    }

    undoBtn?.addEventListener("click", () => {
      if (undoBtn.getAttribute("aria-disabled") === "true") return;
      undoLastAction();
    });
    redoBtn?.addEventListener("click", () => {
      if (redoBtn.getAttribute("aria-disabled") === "true") return;
      redoLastAction();
    });
    resetBtn?.addEventListener("click", () => {
      if (resetBtn.getAttribute("aria-disabled") === "true") return;
      resetAllEdits();
    });

    applySelectionBtn?.addEventListener("click", applySelectionErase);
    clearSelectionBtn?.addEventListener("click", clearSelectionMask);

    zoomOutBtn?.addEventListener("click", () => setZoom(zoom - 0.25));
    zoomResetBtn?.addEventListener("click", () => setZoom(1));
    zoomInBtn?.addEventListener("click", () => setZoom(zoom + 0.25));

    swatchButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const bg = btn.dataset.previewBg || "checker";
        stageEl.dataset.previewBg = bg;
        swatchButtons.forEach((other) => {
          const active = other === btn;
          other.classList.toggle("is-active", active);
          other.setAttribute("aria-pressed", active ? "true" : "false");
        });
      });
    });

    // Atajos de teclado cuando el estudio está visible
    const handleKeyDown = (e) => {
      if (studioEl.hidden) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" && document.activeElement !== brushSizeInput && document.activeElement !== brushSoftnessInput) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          redoLastAction();
        } else {
          undoLastAction();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redoLastAction();
      } else if (e.key === "[") {
        if (brushSizeInput) {
          brushSize = Math.max(Number(brushSizeInput.min), brushSize - 6);
          brushSizeInput.value = String(brushSize);
          if (brushSizeLabel) brushSizeLabel.textContent = `${brushSize} px`;
          syncModernRangeSlider(brushSizeInput, `${brushSize} píxeles`);
          updateBrushCursor();
        }
      } else if (e.key === "]") {
        if (brushSizeInput) {
          brushSize = Math.min(Number(brushSizeInput.max), brushSize + 6);
          brushSizeInput.value = String(brushSize);
          if (brushSizeLabel) brushSizeLabel.textContent = `${brushSize} px`;
          syncModernRangeSlider(brushSizeInput, `${brushSize} píxeles`);
          updateBrushCursor();
        }
      } else if (e.code === "Space" && tag !== "BUTTON" && tag !== "SELECT") {
        if (!spacePanActive) {
          spacePanActive = true;
          updateUIState();
          updateBrushCursor();
        }
        e.preventDefault();
      }
    };

    const handleKeyUp = (e) => {
      if (e.code === "Space" && spacePanActive) {
        spacePanActive = false;
        updateUIState();
        updateBrushCursor();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);

    const resizeObserver = new ResizeObserver(() => {
      if (!studioEl.hidden && originalBitmap) {
        updateStageLayout(true);
      }
    });
    resizeObserver.observe(viewportEl);

    // ========================================================================
    // 6. API PÚBLICA PARA CARGAR IMÁGENES, EXPORTAR Y LIBERAR MEMORIA RAM
    // ========================================================================
    async function loadFile(file) {
      clear();
      sourceFile = file;
      studioEl.hidden = false;
      if (telemetryTextEl) {
        telemetryTextEl.textContent = "Decodificando imagen en el dispositivo...";
      }

      const bitmap = await decodeImageFileToBitmap(file);
      originalBitmap = bitmap;
      imgWidth = bitmap.width;
      imgHeight = bitmap.height;

      canvas.width = imgWidth;
      canvas.height = imgHeight;
      selectionCanvas.width = imgWidth;
      selectionCanvas.height = imgHeight;
      maskCanvas.width = imgWidth;
      maskCanvas.height = imgHeight;

      maskCtx.clearRect(0, 0, imgWidth, imgHeight);
      selCtx.clearRect(0, 0, imgWidth, imgHeight);
      recompositeFullCanvas();

      // Ajustamos el tamaño inicial del pincel de forma proporcional a la imagen
      const suggestedSize = Math.min(
        180,
        Math.max(16, Math.round(Math.min(imgWidth, imgHeight) * 0.05))
      );
      brushSize = suggestedSize;
      if (brushSizeInput) {
        brushSizeInput.value = String(suggestedSize);
        if (brushSizeLabel) brushSizeLabel.textContent = `${suggestedSize} px`;
        syncModernRangeSlider(brushSizeInput, `${suggestedSize} píxeles`);
      }

      selectTool("erase");
      // Esperamos un frame para que el diálogo/contenedor tenga ancho real medible
      await new Promise((r) => requestAnimationFrame(r));
      updateStageLayout(false);
    }

    /**
     * Exporta el resultado actual con transparencia en formato PNG sin pérdida.
     * Si quedaron trazos rojos en el modo Selección sin confirmar, los incluye o
     * los ignora limpiamente; por seguridad aplicamos solo lo ya borrado en maskCanvas.
     *
     * @returns {Promise<{ blob: Blob, file: File, width: number, height: number }>}
     */
    async function exportTransparentPng() {
      if (!originalBitmap) {
        throw new Error("No hay ninguna imagen cargada en el borrador.");
      }

      // Si el usuario dejó trazos de selección rojos sin pulsar "Borrar área seleccionada",
      // los aplicamos automáticamente al exportar para no perder su selección.
      if (selectionStrokes.length > 0) {
        applySelectionErase();
      }

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) resolve(result);
          else reject(new Error("No se pudo exportar la imagen transparente."));
        }, "image/png");
      });

      const baseName = (sourceFile?.name || "imagen").replace(/\.[^/.]+$/, "");
      const editedFile = new File([blob], `${baseName}-sin-fondo.png`, {
        type: "image/png",
      });

      return {
        blob,
        file: editedFile,
        width: imgWidth,
        height: imgHeight,
      };
    }

    function clear() {
      pendingClearReset();
      if (originalBitmap && typeof originalBitmap.close === "function") {
        originalBitmap.close();
      }
      originalBitmap = null;
      sourceFile = null;
      imgWidth = 0;
      imgHeight = 0;
      zoom = 1;

      canvas.width = 1;
      canvas.height = 1;
      selectionCanvas.width = 1;
      selectionCanvas.height = 1;
      maskCanvas.width = 1;
      maskCanvas.height = 1;

      if (cachedTipCanvas) {
        cachedTipCanvas.width = 1;
        cachedTipCanvas.height = 1;
        cachedTipCanvas = null;
        cachedTipKey = "";
      }

      if (brushCursorEl) brushCursorEl.hidden = true;
      updateUIState();
    }

    function pendingClearReset() {
      undoStack.length = 0;
      redoStack.length = 0;
      selectionStrokes.length = 0;
      currentStroke = null;
      panLastPointer = null;
      lastCursorClient = null;
      activePointerId = null;
      spacePanActive = false;
      statusHintMessage = "";
      selectionCanvas.classList.remove("is-lasso-preview");
    }

    function hasPendingChanges() {
      return undoStack.length > 0 || selectionStrokes.length > 0;
    }

    return {
      loadFile,
      exportTransparentPng,
      clear,
      undo: undoLastAction,
      redo: redoLastAction,
      reset: resetAllEdits,
      hasPendingChanges,
      getSourceFile: () => sourceFile,
      refreshLayout: () => updateStageLayout(true),
    };
  }

  globalScope.ConvertidorEraser = {
    createEraserController,
    syncModernRangeSlider,
  };
})(window);
