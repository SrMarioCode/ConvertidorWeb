"""
Punto de entrada principal del servidor web (FastAPI + Jinja2).

Arquitectura de este archivo:
-----------------------------
1. Inicializamos la aplicación `FastAPI`.
2. Montamos el directorio `/static` para servir hojas de estilo CSS, el script
   de interfaz (`app.js`) y el hilo secundario de conversión (`worker.js`).
3. Configuramos `Jinja2Templates` apuntando a `app/templates`.
4. Definimos dos vistas HTML separadas que heredan de `base.html`:
   - `GET /`          -> Página de Inicio explicando el funcionamiento, el ahorro
                         de memoria RAM y los formatos compatibles.
   - `GET /convertir` -> Herramienta interactiva con el Botón Gigante ("De qué a qué"),
                         subida de imágenes y conversión local sin pérdida.
5. Definimos una ruta API JSON (`/api/formats`) para consultar programáticamente
   el catálogo de formatos soportados.
"""

from pathlib import Path
from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import INPUT_FORMATS, OUTPUT_FORMATS, QUICK_PRESETS

# =============================================================================
# 1. Rutas del sistema de archivos (usando `pathlib` para compatibilidad universal)
# =============================================================================
BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

# =============================================================================
# 2. Instancia principal de FastAPI
# =============================================================================
app = FastAPI(
    title="ConvertidorWeb — Conversión de Imágenes Sin Pérdida",
    description=(
        "Aplicación web minimalista impulsada por FastAPI + Jinja2 que convierte "
        "imágenes directamente en el dispositivo del usuario mediante Web Workers, "
        "OffscreenCanvas y WebAssembly (@jsquash) con consumo mínimo de RAM."
    ),
    version="1.0.0",
)

# =============================================================================
# 3. Archivos estáticos y motor de plantillas Jinja2
# =============================================================================
# `app.mount("/static", ...)` permite que en el HTML usemos `url_for('static', path=...)`
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# `Jinja2Templates` compila las plantillas HTML y resuelve bloques `{% extends %}`
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


# =============================================================================
# 4. Rutas de Páginas Web (Server-Side Rendering con Jinja2)
# =============================================================================
@app.get("/", response_class=HTMLResponse, name="home")
async def home_page(request: Request) -> HTMLResponse:
    """
    Ruta de Inicio (`/`):
    Explica de forma visual y sencilla cómo funciona la página, por qué no
    consume memoria RAM en exceso (procesamiento secuencial en Web Worker +
    liberación inmediata de `ImageBitmap`), qué formatos soporta y ofrece
    accesos directos al convertidor.
    """
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "active_page": "home",
            "page_title": "ConvertidorWeb — Convierte imágenes sin perder calidad",
            "input_formats": INPUT_FORMATS,
            "output_formats": OUTPUT_FORMATS,
            "quick_presets": QUICK_PRESETS,
        },
    )


@app.get("/convertir", response_class=HTMLResponse, name="converter")
async def converter_page(
    request: Request,
    de: str = Query(default="auto", description="Formato de origen preseleccionado"),
    a: str = Query(default="webp", description="Formato de destino preseleccionado"),
) -> HTMLResponse:
    """
    Ruta del Convertidor (`/convertir`):
    Presenta el Botón/Cápsula Gigante ("Convertir de [Origen] ➔ a [Destino]"),
    despliega suavemente la zona de subida y procesa las imágenes de una en una
    en el dispositivo del usuario sin saturar la memoria RAM.

    Nota: Acepta parámetros opcionales en la URL (ej. `/convertir?de=png&a=webp`)
    para que los botones de la página de Inicio preconfiguren automáticamente
    el convertidor.
    """
    # Validamos que los parámetros `de` y `a` existan en nuestro catálogo;
    # si alguien escribe un valor inválido en la URL, usamos valores seguros por defecto.
    valid_inputs = {fmt["id"] for fmt in INPUT_FORMATS}
    valid_outputs = {fmt["id"] for fmt in OUTPUT_FORMATS}

    selected_source = de.lower() if de.lower() in valid_inputs else "auto"
    selected_target = a.lower() if a.lower() in valid_outputs else "webp"

    return templates.TemplateResponse(
        request=request,
        name="converter.html",
        context={
            "active_page": "converter",
            "page_title": "Convertir Imágenes — ConvertidorWeb",
            "input_formats": INPUT_FORMATS,
            "output_formats": OUTPUT_FORMATS,
            "quick_presets": QUICK_PRESETS,
            "selected_source": selected_source,
            "selected_target": selected_target,
        },
    )


# =============================================================================
# 5. Rutas de API JSON (Metadatos y Estado del Servidor)
# =============================================================================
@app.get("/api/formats", response_class=JSONResponse, name="api_formats")
async def get_supported_formats() -> JSONResponse:
    """
    Devuelve en formato JSON el catálogo completo de formatos de entrada y salida,
    junto con detalles técnicos sobre el motor de conversión en el cliente.
    """
    return JSONResponse(
        content={
            "engine_architecture": {
                "execution": "Client-Side (Browser Web Worker)",
                "native_api": "createImageBitmap + OffscreenCanvas.convertToBlob()",
                "wasm_codecs": "@jsquash/avif & @jsquash/webp (Lazy-loaded on demand)",
                "ram_strategy": "Sequential 1-by-1 queue + explicit bitmap.close() deallocation",
            },
            "input_formats": INPUT_FORMATS,
            "output_formats": OUTPUT_FORMATS,
            "quick_presets": QUICK_PRESETS,
        }
    )


@app.get("/health", response_class=JSONResponse, name="health")
async def health_check() -> JSONResponse:
    """Endpoint ligero para verificar que el servidor FastAPI está activo."""
    return JSONResponse(content={"status": "ok", "service": "ConvertidorWeb"})
