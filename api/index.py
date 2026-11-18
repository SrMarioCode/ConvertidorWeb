"""
Punto de entrada para funciones Serverless de Vercel.

Vercel busca por defecto un archivo dentro de la carpeta `api/` que exponga
la instancia `app` de FastAPI. Al importar `app` desde `app.main`, reutilizamos
exactamente el mismo servidor, rutas, plantillas Jinja2 y archivos estáticos.
"""

from app.main import app

__all__ = ["app"]
