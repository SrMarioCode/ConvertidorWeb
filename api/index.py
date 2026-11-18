"""
Punto de entrada para funciones Serverless de Vercel.

Vercel busca por defecto un archivo dentro de la carpeta `api/` que exponga
la instancia `app` de FastAPI. Al importar `app` desde `app.main`, reutilizamos
exactamente el mismo servidor, rutas, plantillas Jinja2 y archivos estáticos.
"""

import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from app.main import app  # noqa: E402

__all__ = ["app"]
