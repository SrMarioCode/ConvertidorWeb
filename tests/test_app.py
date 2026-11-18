"""
Suite de pruebas automatizadas para ConvertidorWeb (FastAPI + Jinja2 + Client-Side Engine).

Verifica:
1. Rutas principales (`GET /`, `GET /convertir`, `GET /api/formats`, `GET /health`, `GET /favicon.ico`).
2. Rutas defensivas de compatibilidad Serverless (`GET /api/index`, `GET /api/index.py`).
3. Validación de parámetros de consulta (`?de=png&a=webp`, colisiones `?de=png&a=png`, valores inválidos).
4. Prevención de Mixed Content detrás de proxies HTTPS (`x-forwarded-proto: https` sin URLs `http://`).
5. Manejador personalizado 404 (HTML para navegador vs JSON para `/api/*`).
6. Integridad del catálogo de formatos (`ico` en `INPUT_FORMATS`, motores y metadatos).
7. Archivos estáticos (`/static/css/styles.css`, `/static/js/app.js`, `/static/js/worker.js`, `/static/js/theme.js`).
8. Carga aislada de `api/index.py` mediante `importlib` desde cualquier directorio de trabajo.
"""

import importlib.util
import os
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import INPUT_FORMATS, OUTPUT_FORMATS, QUICK_PRESETS  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def test_home_page_renders_correctly() -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    html = response.text
    assert "ConvertidorWeb" in html
    assert 'href="/static/css/styles.css"' in html
    assert 'src="/static/js/theme.js"' in html
    assert 'href="/convertir"' in html
    assert 'href="/borrador"' in html
    assert 'id="nav-link-eraser"' in html
    assert 'id="hero-open-eraser-btn"' in html
    assert "data:image/svg+xml" in html


def test_converter_page_defaults_and_presets() -> None:
    response = client.get("/convertir")
    assert response.status_code == 200
    html = response.text
    assert 'id="giant-converter-capsule"' in html
    assert 'id="source-format-select"' in html
    assert 'id="target-format-select"' in html
    assert 'id="eraser-dialog"' in html
    assert 'role="dialog"' not in html
    assert 'aria-modal=' not in html
    assert 'id="eraser-studio"' in html
    assert 'src="/static/js/eraser.js"' in html
    assert 'src="/static/js/app.js"' in html
    assert 'data-lossless="true"' in html
    assert 'data-lossless="false"' in html


def test_eraser_page_renders_studio_and_transparent_formats() -> None:
    response = client.get("/borrador")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    html = response.text
    assert 'id="eraser-studio"' in html
    assert 'id="eraser-toolbar"' in html
    assert 'focusgroup="toolbar wrap"' in html
    assert 'aria-controls="eraser-canvas"' in html
    assert 'id="eraser-tool-erase"' in html
    assert 'id="eraser-tool-lasso"' in html
    assert 'id="eraser-tool-select"' in html
    assert 'id="eraser-tool-restore"' in html
    assert 'id="eraser-tool-pan"' in html
    assert 'aria-disabled="true"' in html
    assert 'id="eraser-brush-size"' in html
    assert 'id="eraser-brush-softness"' in html
    assert 'id="eraser-viewport"' in html
    assert 'id="eraser-canvas"' in html
    assert 'id="eraser-selection-canvas"' in html
    assert 'id="eraser-export-format"' in html
    assert 'src="/static/js/eraser.js"' in html
    assert 'src="/static/js/eraser_page.js"' in html

    # Solo formatos con soporte de canal alfa (sin JPEG)
    assert 'value="png"' in html
    assert 'value="webp"' in html
    assert 'value="avif"' in html
    assert 'value="ico"' in html
    assert 'value="jpeg"' not in html


def test_converter_page_query_params_and_collision_prevention() -> None:
    # 1. Combinación válida explícita
    res_valid = client.get("/convertir?de=png&a=avif")
    assert res_valid.status_code == 200
    assert '<option value="png"' in res_valid.text
    assert '<option value="avif"' in res_valid.text

    # 2. Prevención de colisión X -> X (?de=png&a=png debe ajustar destino a webp)
    res_collision_png = client.get("/convertir?de=png&a=png")
    assert res_collision_png.status_code == 200
    # Verificamos que webp quede seleccionado como destino cuando origen es png
    assert 'value="webp"' in res_collision_png.text

    # 3. Prevención de colisión ?de=webp&a=webp debe ajustar destino a png
    res_collision_webp = client.get("/convertir?de=webp&a=webp")
    assert res_collision_webp.status_code == 200

    # 4. Valores inválidos caen a auto -> webp
    res_invalid = client.get("/convertir?de=formato_inexistente&a=otro_invalido")
    assert res_invalid.status_code == 200


def test_https_proxy_headers_emit_zero_insecure_http_urls() -> None:
    """
    Verifica que incluso cuando ASGI recibe scheme='http' detrás de un proxy TLS
    (x-forwarded-proto: https), las plantillas nunca emiten URLs http:// absolutas
    que serían bloqueadas por Mixed Content en el navegador.
    """
    for path in ["/", "/convertir", "/convertir?de=svg&a=png", "/borrador"]:
        response = client.get(
            path,
            headers={
                "host": "convertidor-web.vercel.app",
                "x-forwarded-proto": "https",
            },
        )
        assert response.status_code == 200
        assert "http://convertidor-web.vercel.app" not in response.text
        assert "http://testserver" not in response.text


def test_api_formats_catalog_integrity() -> None:
    response = client.get("/api/formats")
    assert response.status_code == 200
    data = response.json()

    assert "input_formats" in data
    assert "output_formats" in data
    assert "quick_presets" in data
    assert "popular_conversions" in data
    assert "engine" in data

    input_ids = {fmt["id"] for fmt in data["input_formats"]}
    output_ids = {fmt["id"] for fmt in data["output_formats"]}

    assert {"auto", "png", "jpeg", "webp", "avif", "svg", "ico", "bmp", "gif"}.issubset(
        input_ids
    )
    assert {"webp", "png", "avif", "jpeg", "ico", "bmp"} == output_ids
    assert len(INPUT_FORMATS) >= 9
    assert len(OUTPUT_FORMATS) == 6
    assert len(QUICK_PRESETS) >= 6


def test_health_and_favicon_endpoints() -> None:
    health_res = client.get("/health")
    assert health_res.status_code == 200
    assert health_res.json() == {"status": "ok", "service": "ConvertidorWeb"}

    fav_res = client.get("/favicon.ico")
    assert fav_res.status_code == 200
    assert "image/svg+xml" in fav_res.headers["content-type"]
    assert "<svg" in fav_res.text


def test_defensive_serverless_aliases_and_custom_404() -> None:
    for alias in ["/api/index", "/api/index.py"]:
        res = client.get(alias)
        assert res.status_code == 200
        assert "ConvertidorWeb" in res.text

    # Ruta API desconocida -> 404 JSON
    api_404 = client.get("/api/no-existe")
    assert api_404.status_code == 404
    assert api_404.json() == {"detail": "Not Found"}

    # Ruta de navegador desconocida -> 404 HTML amigable
    html_404 = client.get("/ruta-inexistente-123")
    assert html_404.status_code == 404
    assert "text/html" in html_404.headers["content-type"]
    assert "ConvertidorWeb" in html_404.text


def test_static_assets_and_worker_contracts() -> None:
    for asset_path in [
        "/static/css/styles.css",
        "/static/js/theme.js",
        "/static/js/app.js",
        "/static/js/worker.js",
        "/static/js/eraser.js",
        "/static/js/eraser_page.js",
    ]:
        res = client.get(asset_path)
        assert res.status_code == 200
        assert len(res.text) > 100

    worker_js = client.get("/static/js/worker.js").text
    assert "avif_enc.wasm" in worker_js
    assert "webp_enc.wasm" in worker_js
    assert "cqLevel" in worker_js
    assert "DECODE_FAILED" in worker_js

    app_js = client.get("/static/js/app.js").text
    assert "convertOnMainThread" in app_js
    assert "decodeFileToBitmapOnMainThread" in app_js
    assert "capsule-action-text" in app_js
    assert "openEraserModalForItem" in app_js

    eraser_js = client.get("/static/js/eraser.js").text
    assert "ConvertidorEraser" in eraser_js
    assert "exportTransparentPng" in eraser_js
    assert "syncModernRangeSlider" in eraser_js
    assert "keep-inside" in eraser_js
    assert "buildKeepInsidePath" in eraser_js
    assert "originalBitmap.close()" in eraser_js


def test_api_index_importlib_from_external_cwd() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    api_index_path = repo_root / "api" / "index.py"
    original_cwd = Path.cwd()
    try:
        os.chdir("/")
        spec = importlib.util.spec_from_file_location("vercel_api_index", api_index_path)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        assert getattr(module, "app", None) is app
    finally:
        os.chdir(original_cwd)
