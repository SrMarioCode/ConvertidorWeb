"""
Configuración y catálogo de formatos de imagen para ConvertidorWeb.

¿Por qué separamos este archivo de `main.py`?
---------------------------------------------
En aplicaciones profesionales con FastAPI y Jinja2, separar los datos estáticos
y la configuración (`config.py`) de las rutas HTTP (`main.py`) permite:
1. Mantener las rutas limpias y fáciles de leer.
2. Pasar estos diccionarios directamente a las plantillas Jinja2 para generar
   menús desplegables, tarjetas y tablas usando bucles `{% for ... %}` sin
   repetir código HTML.
"""

from typing import TypedDict


class ImageFormat(TypedDict):
    """Estructura tipada que describe cada formato de imagen soportado."""
    id: str
    name: str
    mime: str
    extension: str
    badge: str
    engine: str
    lossless_capable: bool
    supports_alpha: bool
    description: str


class QuickPreset(TypedDict):
    """Combinaciones populares de conversión ('De qué a qué') para un clic."""
    source: str
    target: str
    label: str
    subtitle: str


# =============================================================================
# 1. Formatos de ENTRADA aceptados por el navegador
# =============================================================================
INPUT_FORMATS: list[dict[str, str]] = [
    {
        "id": "auto",
        "name": "Cualquier imagen (Auto)",
        "accept": "image/png,image/jpeg,image/webp,image/avif,image/svg+xml,image/bmp,image/gif,image/x-icon,.ico",
        "description": "Detecta automáticamente el formato al elegir o arrastrar tu archivo.",
    },
    {
        "id": "png",
        "name": "PNG",
        "accept": "image/png",
        "description": "Gráficos con transparencia y bordes nítidos sin pérdida.",
    },
    {
        "id": "jpeg",
        "name": "JPG / JPEG",
        "accept": "image/jpeg",
        "description": "Fotografías digitales estándar de cámaras y teléfonos.",
    },
    {
        "id": "webp",
        "name": "WebP",
        "accept": "image/webp",
        "description": "Formato moderno desarrollado por Google para la web.",
    },
    {
        "id": "avif",
        "name": "AVIF",
        "accept": "image/avif",
        "description": "Compresión de última generación basada en el códec AV1.",
    },
    {
        "id": "svg",
        "name": "SVG (Vectorial)",
        "accept": "image/svg+xml",
        "description": "Gráficos vectoriales escalables que se rasterizan en alta nitidez.",
    },
    {
        "id": "bmp",
        "name": "BMP",
        "accept": "image/bmp",
        "description": "Mapa de bits clásico sin compresión.",
    },
    {
        "id": "gif",
        "name": "GIF",
        "accept": "image/gif",
        "description": "Formato gráfico clásico (convierte el fotograma principal sin pérdida).",
    },
]


# =============================================================================
# 2. Formatos de SALIDA (a los que podemos convertir sin perder calidad)
# =============================================================================
OUTPUT_FORMATS: list[ImageFormat] = [
    {
        "id": "webp",
        "name": "WebP",
        "mime": "image/webp",
        "extension": "webp",
        "badge": "Recomendado Web",
        "engine": "OffscreenCanvas + @jsquash/webp",
        "lossless_capable": True,
        "supports_alpha": True,
        "description": "Equilibrio ideal creado por Google: soporta transparencia y calidad 100% con menor peso.",
    },
    {
        "id": "png",
        "name": "PNG",
        "mime": "image/png",
        "extension": "png",
        "badge": "100% Sin Pérdida",
        "engine": "OffscreenCanvas Nativo",
        "lossless_capable": True,
        "supports_alpha": True,
        "description": "Conserva absolutamente cada píxel exacto y el canal alfa (transparencia).",
    },
    {
        "id": "avif",
        "name": "AVIF",
        "mime": "image/avif",
        "extension": "avif",
        "badge": "Ultra Eficiente",
        "engine": "WebAssembly (@jsquash/avif)",
        "lossless_capable": True,
        "supports_alpha": True,
        "description": "Formato de próxima generación; carga el módulo WebAssembly solo cuando lo eliges para ahorrar RAM.",
    },
    {
        "id": "jpeg",
        "name": "JPG / JPEG",
        "mime": "image/jpeg",
        "extension": "jpg",
        "badge": "Universal",
        "engine": "OffscreenCanvas Nativo",
        "lossless_capable": False,
        "supports_alpha": False,
        "description": "Compatible con cualquier dispositivo o programa. Rellena fondos transparentes en blanco limpio.",
    },
    {
        "id": "ico",
        "name": "ICO (Favicon)",
        "mime": "image/x-icon",
        "extension": "ico",
        "badge": "Iconos / Web",
        "engine": "Empaquetador Binario PNG-ICO",
        "lossless_capable": True,
        "supports_alpha": True,
        "description": "Genera un archivo de icono estándar para sitios web y aplicaciones de escritorio sin perder nitidez.",
    },
    {
        "id": "bmp",
        "name": "BMP (32-bit)",
        "mime": "image/bmp",
        "extension": "bmp",
        "badge": "Píxeles Puros",
        "engine": "Codificador Binario Directo",
        "lossless_capable": True,
        "supports_alpha": True,
        "description": "Mapa de bits sin ningún tipo de compresión (píxeles RGBA crudos).",
    },
]


# =============================================================================
# 3. Accesos rápidos ("De qué a qué") para mostrar debajo del botón gigante
# =============================================================================
QUICK_PRESETS: list[QuickPreset] = [
    {
        "source": "png",
        "target": "webp",
        "label": "PNG ➔ WebP",
        "subtitle": "Ideal para acelerar sitios web manteniendo transparencia",
    },
    {
        "source": "jpeg",
        "target": "png",
        "label": "JPG ➔ PNG",
        "subtitle": "Edición gráfica sin artefactos adicionales",
    },
    {
        "source": "auto",
        "target": "avif",
        "label": "Cualquier imagen ➔ AVIF",
        "subtitle": "Compresión moderna con motor WebAssembly bajo demanda",
    },
    {
        "source": "webp",
        "target": "png",
        "label": "WebP ➔ PNG",
        "subtitle": "Máxima compatibilidad con programas de diseño tradicionales",
    },
    {
        "source": "svg",
        "target": "png",
        "label": "SVG ➔ PNG",
        "subtitle": "Rasterización nítida de vectores a mapa de bits",
    },
    {
        "source": "png",
        "target": "ico",
        "label": "PNG ➔ ICO",
        "subtitle": "Crea el favicon.ico perfecto para tu proyecto web",
    },
]
