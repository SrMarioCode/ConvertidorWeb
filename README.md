# ConvertidorWeb — Conversión de Imágenes Sin Pérdida y de Bajo Consumo en RAM

Aplicación web minimalista (inspirada en el lenguaje de diseño de Google Material 3 y Google Squoosh) construida con **FastAPI** y plantillas **Jinja2**, diseñada para convertir todo tipo de imágenes directamente en el dispositivo del usuario sin perder calidad y consumiendo la menor carga posible de memoria RAM.

---

## Estructura del Proyecto (Guía de Aprendizaje)

```text
ConvertidorWeb/
├── requirements.txt           # Dependencias del servidor Python (FastAPI, Uvicorn, Jinja2)
├── vercel.json                # Configuración de despliegue zero-config para FastAPI en Vercel
├── README.md                  # Documentación técnica y educativa del proyecto
├── api/
│   └── index.py               # Punto de entrada ASGI Serverless con resolución automática de sys.path
├── app/
│   ├── __init__.py
│   ├── config.py              # Catálogo centralizado de formatos de entrada (incl. ICO), salida y presets
│   ├── main.py                # Servidor FastAPI: rutas HTML ("/", "/convertir", "/borrador"), API JSON y favicon
│   ├── templates/             # Plantillas Jinja2 con herencia y rutas relativas a la raíz (anti Mixed-Content)
│   │   ├── partials/
│   │   │   └── eraser_studio.html # Componente reutilizable del estudio de borrado manual con lápiz
│   │   ├── base.html          # Plantilla maestra (barra de navegación, favicon SVG, tema claro/oscuro, pie de página)
│   │   ├── index.html         # Página de Inicio ("/") que explica la web y la gestión de RAM
│   │   ├── converter.html     # Herramienta ("/convertir") con Cápsula Gigante y modal <dialog> del borrador
│   │   └── eraser.html        # Página dedicada ("/borrador") del borrador manual de fondo con lápiz
│   └── static/                # Archivos servidos al navegador / CDN
│       ├── css/
│       │   └── styles.css     # Sistema de diseño Google Material 3 con light-dark(), <dialog>, sliders y 2D panning
│       └── js/
│           ├── theme.js       # Controlador del tema claro/oscuro sincronizado con <meta name="color-scheme">
│           ├── eraser.js      # Motor del borrador manual con historial de trazos vectoriales y máscara separada
│           ├── eraser_page.js # Controlador de la vista dedicada /borrador y exportación transparente
│           ├── app.js         # Lógica del Botón Gigante, cola 1-a-1, respaldo y diálogo modal del borrador
│           └── worker.js      # Web Worker aislado: OffscreenCanvas + @jsquash single-threaded (AVIF/WebP WASM) + ICO/BMP
└── tests/
    └── test_app.py            # Suite de pruebas automatizadas (Pytest + HTTPX TestClient)
```

---

## ¿Cómo logramos máxima calidad y mínimo consumo de RAM?

1. **Cero cadenas Base64 (`FileReader.readAsDataURL`)**:
   En lugar de transformar la imagen en una cadena de texto gigante en la memoria de JavaScript (lo cual incrementa el peso un +33%), pasamos la referencia binaria (`Blob` / `File`) directamente al motor nativo con `createImageBitmap()`.
2. **Hilo secundario dedicado (`worker.js`) con respaldo automático**:
   Toda la decodificación y codificación ocurre fuera del hilo principal usando `OffscreenCanvas`, evitando que la interfaz se congele. Si un archivo vectorial (`SVG`), icono (`ICO`) o imagen especial requiere decodificación DOM, `app.js` lo rasteriza en el hilo principal y transfiere el `ImageBitmap` sin copias (`0-copy`).
3. **Liberación explícita e inmediata (`bitmap.close()` y `canvas = 1×1`)**:
   Apenas se dibuja la imagen en el `OffscreenCanvas`, llamamos a `bitmap.close()`, y justo después de extraer `getImageData()` vaciamos el `OffscreenCanvas` (`1×1`) **antes** de reservar el búfer de salida en WebAssembly o BMP.
4. **Cola estrictamente secuencial (1 por 1)**:
   Si el usuario arrastra varias imágenes, `app.js` las procesa en fila de una en una. Nunca se acumulan múltiples mapas de bits descomprimidos en la RAM al mismo tiempo.
5. **Carga bajo demanda de WebAssembly (`@jsquash` Single-Threaded)**:
   Para formatos estándar (`PNG`, `JPG`, `WebP`) usamos el codificador nativo en C++ del navegador (o `@jsquash/webp` con `lossless: 1, exact: 1` para WebP sin pérdida). Para `AVIF`, el Worker instancia directamente el módulo WebAssembly single-threaded (`avif_enc.wasm`) con control real de cuantización (`cqLevel: 0` sin pérdida y `subsample: 3` YUV444) sin crear sub-workers cross-origin.
6. **Borrador manual con historial vectorial por trazos (`eraser.js`)**:
   En `/borrador` y dentro del `<dialog>` de `/convertir`, en vez de guardar copias completas de píxeles (`ImageData`) por cada paso de Deshacer, almacenamos únicamente las coordenadas ligeras de cada trazo (`{ tool, size, softness, points }`) junto a una máscara de borrado separada (`maskCanvas`). Incluye lápiz **Borrador** directo, lápiz de **Selección** rojo (para marcar y confirmar el recorte en lote), **Restaurar**, **Mover 2D / Zoom**, y liberación inmediata al cerrar (`originalBitmap.close()` + lienzos `1×1`).

---

## Cómo ejecutar el proyecto y las pruebas

1. **Instalar dependencias** (en un entorno virtual):
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Iniciar el servidor de desarrollo con FastAPI / Uvicorn**:
   ```bash
   uvicorn app.main:app --reload --port 8000
   ```

3. **Ejecutar la suite de pruebas automatizadas**:
   ```bash
   pytest -v
   ```

4. **Abrir en el navegador**:
   - Página de Inicio y Explicación: `http://localhost:8000/`
   - Convertidor Interactivo: `http://localhost:8000/convertir`
   - Borrador de Fondo Manual con Lápiz: `http://localhost:8000/borrador`
   - Catálogo JSON (API): `http://localhost:8000/api/formats`
   - Estado del Servidor: `http://localhost:8000/health`