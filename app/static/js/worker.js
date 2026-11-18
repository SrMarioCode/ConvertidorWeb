/**
 * ============================================================================
 * Hilo Secundario de Conversión (Web Worker) — app/static/js/worker.js
 * ============================================================================
 * ¿Por qué usamos un Web Worker dedicado?
 * ---------------------------------------
 * 1. NO CONGELA LA PANTALLA: La decodificación y codificación de millones de
 *    píxeles ocurre en un hilo separado del navegador.
 * 2. CONSUMO MÍNIMO DE MEMORIA RAM:
 *    - Recibimos el archivo binario (`Blob`) directamente, sin convertirlo
 *      nunca a cadenas de texto Base64.
 *    - Decodificamos con `createImageBitmap()`, dibujamos en `OffscreenCanvas`
 *      y ejecutamos inmediatamente `bitmap.close()` para devolver esa memoria
 *      RAM al sistema operativo antes siquiera de comprimir el archivo final.
 *    - Al terminar cada imagen, reducimos el `OffscreenCanvas` a `1x1` píxeles
 *      para vaciar el búfer gráfico inmediatamente.
 * 3. CARGA BAJO DEMANDA (`@jsquash` WebAssembly):
 *    - Para PNG, JPG y WebP usamos el motor C++ nativo del navegador.
 *    - Solo si el usuario pide AVIF (o si el navegador no codifica WebP de
 *      forma nativa), importamos dinámicamente `@jsquash` vía WebAssembly.
 * ============================================================================
 */

// Caché en memoria solo para los codificadores WebAssembly si llegan a usarse
let jsquashAvifEncode = null;
let jsquashWebpEncode = null;

/**
 * Carga bajo demanda (Lazy Load) el codificador WebAssembly de AVIF (@jsquash/avif)
 * únicamente cuando el usuario solicita convertir a AVIF y el navegador no lo
 * codifica de forma nativa en OffscreenCanvas.
 */
async function getAvifWasmEncoder() {
  if (!jsquashAvifEncode) {
    const module = await import("https://esm.sh/@jsquash/avif@1.3.0");
    jsquashAvifEncode = module.encode;
  }
  return jsquashAvifEncode;
}

/**
 * Carga bajo demanda (Lazy Load) el codificador WebAssembly de WebP (@jsquash/webp)
 * como respaldo si algún navegador no soporta `image/webp` en OffscreenCanvas.
 */
async function getWebpWasmEncoder() {
  if (!jsquashWebpEncode) {
    const module = await import("https://esm.sh/@jsquash/webp@1.4.0");
    jsquashWebpEncode = module.encode;
  }
  return jsquashWebpEncode;
}

/**
 * Empaqueta un Blob PNG dentro de un contenedor binario estándar `.ico` (Windows/Web Icon).
 * El estándar ICO permite incrustar directamente un flujo PNG sin pérdida para tamaños
 * de hasta 256x256 píxeles.
 *
 * @param {Blob} pngBlob - Imagen PNG ya codificada sin pérdida
 * @param {number} width - Ancho del icono (1..256)
 * @param {number} height - Alto del icono (1..256)
 * @returns {Promise<Blob>} Archivo .ico válido
 */
async function wrapPngInIcoContainer(pngBlob, width, height) {
  const pngBuffer = await pngBlob.arrayBuffer();
  const pngBytes = new Uint8Array(pngBuffer);
  const headerSize = 6 + 16; // 6 bytes ICONDIR + 16 bytes ICONDIRENTRY
  const icoBytes = new Uint8Array(headerSize + pngBytes.byteLength);
  const view = new DataView(icoBytes.buffer);

  // 1. Cabecera ICONDIR (6 bytes)
  view.setUint16(0, 0, true); // Reservado (0)
  view.setUint16(2, 1, true); // Tipo: 1 = Icono (.ico)
  view.setUint16(4, 1, true); // Cantidad de imágenes contenidas: 1

  // 2. Entrada ICONDIRENTRY (16 bytes)
  // En la especificación ICO, 256 píxeles se representa con el byte 0
  view.setUint8(6, width >= 256 ? 0 : width);
  view.setUint8(7, height >= 256 ? 0 : height);
  view.setUint8(8, 0);               // Paleta de colores (0 = sin paleta fija)
  view.setUint8(9, 0);               // Reservado (0)
  view.setUint16(10, 1, true);       // Planos de color (1)
  view.setUint16(12, 32, true);      // Bits por píxel (32-bit RGBA)
  view.setUint32(14, pngBytes.byteLength, true); // Tamaño de los datos PNG
  view.setUint32(18, headerSize, true);          // Offset donde inicia el PNG

  // 3. Copiamos los bytes del PNG sin pérdida
  icoBytes.set(pngBytes, headerSize);

  return new Blob([icoBytes], { type: "image/x-icon" });
}

/**
 * Codifica un objeto `ImageData` (RGBA) directamente en un archivo binario `.bmp`
 * de 32 bits sin compresión (100% sin pérdida).
 *
 * @param {ImageData} imageData - Píxeles RGBA del lienzo
 * @returns {Blob} Archivo .bmp válido
 */
function encodeImageDataToBmp(imageData) {
  const { width, height, data } = imageData;
  const pixelArraySize = width * height * 4;
  const fileHeaderSize = 14;
  const dibHeaderSize = 40;
  const headerTotal = fileHeaderSize + dibHeaderSize;
  const fileSize = headerTotal + pixelArraySize;

  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // 1. BITMAPFILEHEADER (14 bytes)
  view.setUint8(0, 0x42); // 'B'
  view.setUint8(1, 0x4d); // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(6, 0, true);
  view.setUint32(10, headerTotal, true);

  // 2. BITMAPINFOHEADER (40 bytes)
  view.setUint32(14, dibHeaderSize, true);
  view.setInt32(18, width, true);
  // Altura negativa indica orden de arriba hacia abajo (top-down DIB)
  view.setInt32(22, -height, true);
  view.setUint16(26, 1, true);       // Planos = 1
  view.setUint16(28, 32, true);      // 32 bits por píxel (BGRA)
  view.setUint32(30, 0, true);       // BI_RGB (sin compresión)
  view.setUint32(34, pixelArraySize, true);
  view.setInt32(38, 2835, true);     // 72 DPI horizontal
  view.setInt32(42, 2835, true);     // 72 DPI vertical
  view.setUint32(46, 0, true);
  view.setUint32(50, 0, true);

  // 3. Conversión de orden de canales RGBA (Canvas) -> BGRA (BMP)
  let dstOffset = headerTotal;
  for (let i = 0; i < data.length; i += 4) {
    bytes[dstOffset] = data[i + 2];     // Blue
    bytes[dstOffset + 1] = data[i + 1]; // Green
    bytes[dstOffset + 2] = data[i];     // Red
    bytes[dstOffset + 3] = data[i + 3]; // Alpha
    dstOffset += 4;
  }

  return new Blob([buffer], { type: "image/bmp" });
}

/**
 * Escucha los mensajes enviados desde el hilo principal (`app.js`).
 * Procesa una imagen a la vez y libera inmediatamente la memoria RAM.
 */
self.addEventListener("message", async (event) => {
  const {
    id,
    fileBlob,
    transferredBitmap,
    targetFormat,
    lossless,
    quality,
  } = event.data;

  const startTime = performance.now();
  let bitmap = null;
  let canvas = null;

  try {
    // 1. Obtener el ImageBitmap (ya sea transferido desde SVG o decodificado del Blob)
    if (transferredBitmap) {
      bitmap = transferredBitmap;
    } else {
      bitmap = await createImageBitmap(fileBlob);
    }

    let targetWidth = bitmap.width;
    let targetHeight = bitmap.height;

    // Si el destino es ICO (Favicon), escalamos proporcionalmente a máximo 256x256 px
    if (targetFormat === "ico" && (targetWidth > 256 || targetHeight > 256)) {
      const scale = Math.min(256 / targetWidth, 256 / targetHeight);
      targetWidth = Math.max(1, Math.round(targetWidth * scale));
      targetHeight = Math.max(1, Math.round(targetHeight * scale));
    }

    // 2. Crear OffscreenCanvas del tamaño exacto de salida
    canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext("2d", {
      willReadFrequently: targetFormat === "bmp" || targetFormat === "avif",
    });

    // Si el formato destino es JPEG (que no soporta transparencia), pintamos fondo blanco limpio
    if (targetFormat === "jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, targetWidth, targetHeight);
    }

    // Dibujamos los píxeles en el OffscreenCanvas
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

    // ¡PASO CLAVE DE AHORRO DE RAM!
    // Cerramos el ImageBitmap de inmediato para liberar el búfer decodificado de entrada.
    bitmap.close();
    bitmap = null;

    // Normalizamos la calidad entre 0.5 y 1.0 (1.0 si está activo el modo Sin Pérdida)
    const normalizedQuality = lossless ? 1.0 : Math.min(1, Math.max(0.5, quality / 100));

    let outputBlob = null;
    let engineUsed = "OffscreenCanvas Nativo";

    // 3. Codificación según el formato de destino elegido
    if (targetFormat === "png") {
      outputBlob = await canvas.convertToBlob({ type: "image/png" });
      engineUsed = "OffscreenCanvas (PNG Sin Pérdida)";
    } else if (targetFormat === "jpeg") {
      outputBlob = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: normalizedQuality,
      });
      engineUsed = `OffscreenCanvas (JPEG ${Math.round(normalizedQuality * 100)}%)`;
    } else if (targetFormat === "webp") {
      // Intentamos primero el codificador nativo de hardware del navegador
      const nativeWebp = await canvas.convertToBlob({
        type: "image/webp",
        quality: normalizedQuality,
      });

      if (nativeWebp && nativeWebp.type === "image/webp") {
        outputBlob = nativeWebp;
        engineUsed = `OffscreenCanvas (WebP ${Math.round(normalizedQuality * 100)}%)`;
      } else {
        // Respaldo WebAssembly (@jsquash/webp) si el navegador no codifica WebP nativamente
        const encodeWebp = await getWebpWasmEncoder();
        const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
        const wasmBuffer = await encodeWebp(imgData, {
          lossless: lossless ? 1 : 0,
          quality: Math.round(normalizedQuality * 100),
        });
        outputBlob = new Blob([wasmBuffer], { type: "image/webp" });
        engineUsed = "@jsquash/webp (WebAssembly)";
      }
    } else if (targetFormat === "avif") {
      // Probamos primero si el navegador soporta codificación AVIF nativa en OffscreenCanvas
      let nativeAvif = null;
      try {
        nativeAvif = await canvas.convertToBlob({
          type: "image/avif",
          quality: normalizedQuality,
        });
      } catch (_) {
        nativeAvif = null;
      }

      if (nativeAvif && nativeAvif.type === "image/avif") {
        outputBlob = nativeAvif;
        engineUsed = "OffscreenCanvas (AVIF Nativo)";
      } else {
        // Carga bajo demanda de @jsquash/avif (WebAssembly de Google Chrome Labs)
        const encodeAvif = await getAvifWasmEncoder();
        const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
        const avifBuffer = await encodeAvif(imgData, {
          quality: lossless ? 100 : Math.round(normalizedQuality * 100),
          speed: 6, // Velocidad equilibrada para no saturar CPU ni RAM
        });
        outputBlob = new Blob([avifBuffer], { type: "image/avif" });
        engineUsed = "@jsquash/avif (WebAssembly)";
      }
    } else if (targetFormat === "ico") {
      const pngForIco = await canvas.convertToBlob({ type: "image/png" });
      outputBlob = await wrapPngInIcoContainer(pngForIco, targetWidth, targetHeight);
      engineUsed = `Contenedor ICO Sin Pérdida (${targetWidth}×${targetHeight})`;
    } else if (targetFormat === "bmp") {
      const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
      outputBlob = encodeImageDataToBmp(imgData);
      engineUsed = "Codificador Binario BMP 32-bit";
    } else {
      throw new Error(`Formato de destino no reconocido: ${targetFormat}`);
    }

    // 4. Liberamos inmediatamente la memoria gráfica del OffscreenCanvas
    canvas.width = 1;
    canvas.height = 1;
    canvas = null;

    const durationMs = Math.round(performance.now() - startTime);

    // 5. Enviamos el Blob convertido de vuelta al hilo principal
    self.postMessage({
      id,
      status: "done",
      outputBlob,
      width: targetWidth,
      height: targetHeight,
      durationMs,
      engineUsed,
    });
  } catch (error) {
    // Aseguramos liberar cualquier recurso retenido en caso de error
    if (bitmap && typeof bitmap.close === "function") {
      bitmap.close();
    }
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }

    self.postMessage({
      id,
      status: "error",
      errorMessage:
        error instanceof Error
          ? error.message
          : "No se pudo procesar la imagen en el dispositivo.",
    });
  }
});
