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
from typing import Any
from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import INPUT_FORMATS, OUTPUT_FORMATS, QUICK_PRESETS

# =============================================================================
# 1. Rutas del sistema de archivos (usando `pathlib` para compatibilidad universal)
# =============================================================================
BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

SVG_FAVICON = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    'stroke="#0b57d0" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
    '<rect x="3" y="3" width="18" height="18" rx="4" ry="4"/>'
    '<circle cx="8.5" cy="8.5" r="1.5"/>'
    '<polyline points="21 15 16 10 5 21"/>'
    "</svg>"
)

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
# `app.mount("/static", ...)` sirve las hojas de estilo y scripts en `/static/*`
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# `Jinja2Templates` compila las plantillas HTML y resuelve bloques `{% extends %}`
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

# Sobrescribimos `url_for` en el entorno global de Jinja2 para que siempre
# devuelva rutas relativas a la raíz (`/`, `/convertir`, `/static/...`) en lugar
# de URLs absolutas `http://...`, evitando bloqueos de Mixed Content detrás de
# proxies inversos HTTPS o despliegues serverless como Vercel.
templates.env.globals["url_for"] = (
    lambda name, **path_params: str(app.url_path_for(name, **path_params))
)


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


@app.get("/api/index", response_class=HTMLResponse, include_in_schema=False)
@app.get("/api/index.py", response_class=HTMLResponse, include_in_schema=False)
async def api_index_alias(request: Request) -> HTMLResponse:
    """
    Rutas defensivas de compatibilidad para entornos Serverless (`/api/index`):
    Delegan directamente en la página de inicio para evitar errores 404 si se
    invoca el punto de entrada serverless directamente.
    """
    return await home_page(request)


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

    Además, integra el modal de Borrador Manual de Fondo para limpiar
    transparencias con lápiz antes de exportar al formato final.

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

    # Evitamos colisiones donde el formato de origen y destino sean idénticos (ej. ?de=png&a=png)
    if selected_source == selected_target:
        selected_target = "png" if selected_source == "webp" else "webp"

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


@app.get("/borrador", response_class=HTMLResponse, name="eraser")
async def eraser_page(request: Request) -> HTMLResponse:
    """
    Ruta del Borrador Manual de Fondo (`/borrador`):
    Permite subir una imagen y seleccionar manualmente con el lápiz qué zonas
    borrar o marcar para volverlas transparentes en tiempo real, con arquitectura
    de máscara vectorial para consumir el mínimo absoluto de memoria RAM.
    """
    # Solo ofrecemos formatos de salida que conservan canal alfa (transparencia)
    transparent_formats = [fmt for fmt in OUTPUT_FORMATS if fmt["supports_alpha"]]

    return templates.TemplateResponse(
        request=request,
        name="eraser.html",
        context={
            "active_page": "eraser",
            "page_title": "Borrador de Fondo Manual — ConvertidorWeb",
            "transparent_formats": transparent_formats,
        },
    )


# =============================================================================
# 5. Rutas de API JSON, Favicon y Manejo Personalizado de Errores 404
# =============================================================================
@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    """Sirve un icono vectorial limpio para evitar errores 404 en el navegador."""
    return Response(content=SVG_FAVICON, media_type="image/svg+xml")


@app.get("/api/formats", response_class=JSONResponse, name="api_formats")
async def get_supported_formats() -> JSONResponse:
    """
    Devuelve en formato JSON el catálogo completo de formatos de entrada y salida,
    junto con detalles técnicos sobre el motor de conversión en el cliente.
    """
    engine_info = {
        "execution": "Client-Side (Browser Web Worker)",
        "native_api": "createImageBitmap + OffscreenCanvas.convertToBlob()",
        "wasm_codecs": "@jsquash/avif & @jsquash/webp (Lazy-loaded on demand)",
        "ram_strategy": "Sequential 1-by-1 queue + explicit bitmap.close() deallocation",
    }
    return JSONResponse(
        content={
            "engine_architecture": engine_info,
            "engine": engine_info,
            "input_formats": INPUT_FORMATS,
            "output_formats": OUTPUT_FORMATS,
            "quick_presets": QUICK_PRESETS,
            "popular_conversions": QUICK_PRESETS,
        }
    )


@app.get("/health", response_class=JSONResponse, name="health")
async def health_check() -> JSONResponse:
    """Endpoint ligero para verificar que el servidor FastAPI está activo."""
    return JSONResponse(content={"status": "ok", "service": "ConvertidorWeb"})


@app.exception_handler(404)
async def custom_404_handler(
    request: Request, exc: StarletteHTTPException | Exception
) -> Any:
    """
    Manejador personalizado para rutas no encontradas (404):
    - Si es una ruta de API (`/api/*`), devuelve JSON `{"detail": "Not Found"}`.
    - Si es navegación del usuario en el navegador, muestra la interfaz principal
      con código de estado 404 para no romper la experiencia visual.
    """
    if request.url.path.startswith("/api/"):
        return JSONResponse(status_code=404, content={"detail": "Not Found"})

    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "active_page": "home",
            "page_title": "Página no encontrada — ConvertidorWeb",
            "input_formats": INPUT_FORMATS,
            "output_formats": OUTPUT_FORMATS,
            "quick_presets": QUICK_PRESETS,
        },
        status_code=404,
    )
