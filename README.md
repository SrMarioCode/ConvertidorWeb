# ConvertidorWeb — Conversión de Imágenes Sin Pérdida y de Bajo Consumo en RAM

Aplicación web minimalista (inspirada en el lenguaje de diseño de Google Material 3 y Google Squoosh) construida con **FastAPI** y plantillas **Jinja2**, diseñada para convertir todo tipo de imágenes directamente en el dispositivo del usuario sin perder calidad y consumiendo la menor carga posible de memoria RAM.

---

## Estructura del Proyecto (Guía de Aprendizaje)

```text
ConvertidorWeb/
├── requirements.txt           # Dependencias del servidor Python (FastAPI, Uvicorn, Jinja2)
├── README.md                  # Documentación técnica y educativa del proyecto
└── app/
    ├── __init__.py
    ├── config.py              # Catálogo centralizado de formatos de entrada, salida y presets
    ├── main.py                # Servidor FastAPI: rutas HTML ("/", "/convertir") y API ("/api/formats")
    ├── templates/             # Plantillas Jinja2 con herencia
    │   ├── base.html          # Plantilla maestra (barra de navegación, tema claro/oscuro, pie de página)
    │   ├── index.html         # Página de Inicio ("/") que explica la web y la gestión de RAM
    │   └── converter.html     # Herramienta ("/convertir") con el Botón Gigante "De qué a qué"
    └── static/                # Archivos servidos al navegador
        ├── css/
        │   └── styles.css     # Sistema de diseño Google Material 3 con variables CSS y light-dark()
        └── js/
            ├── theme.js       # Controlador del tema claro/oscuro sincronizado con <meta name="color-scheme">
            ├── app.js         # Lógica del Botón Gigante, subida Drag & Drop y cola secuencial 1-a-1
            └── worker.js      # Web Worker aislado: OffscreenCanvas + @jsquash (WebAssembly bajo demanda)
```

---

## ¿Cómo logramos máxima calidad y mínimo consumo de RAM?

1. **Cero cadenas Base64 (`FileReader.readAsDataURL`)**:
   En lugar de transformar la imagen en una cadena de texto gigante en la memoria de JavaScript (lo cual incrementa el peso un +33%), pasamos la referencia binaria (`Blob` / `File`) directamente al motor nativo con `createImageBitmap()`.
2. **Hilo secundario dedicado (`worker.js`)**:
   Toda la decodificación y codificación ocurre fuera del hilo principal usando `OffscreenCanvas`, evitando que la interfaz se congele.
3. **Liberación explícita e inmediata (`bitmap.close()`)**:
   Apenas se dibuja la imagen en el `OffscreenCanvas`, llamamos a `bitmap.close()` antes de iniciar la compresión del archivo de salida, y al terminar reducimos el lienzo a `1×1` píxeles.
4. **Cola estrictamente secuencial (1 por 1)**:
   Si el usuario arrastra varias imágenes, `app.js` las procesa en fila de una en una. Nunca se acumulan múltiples mapas de bits descomprimidos en la RAM al mismo tiempo.
5. **Carga bajo demanda de WebAssembly (`@jsquash`)**:
   Para formatos estándar (`PNG`, `JPG`, `WebP`) usamos el codificador nativo en C++ del navegador. Para formatos de próxima generación como `AVIF`, el Worker importa `@jsquash/avif` solo cuando el usuario elige ese formato.

---

## Cómo ejecutar el proyecto

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

3. **Abrir en el navegador**:
   - Página de Inicio y Explicación: `http://localhost:8000/`
   - Convertidor Interactivo: `http://localhost:8000/convertir`
   - Catálogo JSON (API): `http://localhost:8000/api/formats`