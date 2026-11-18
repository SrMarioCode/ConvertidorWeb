/**
 * ============================================================================
 * Controlador de Tema Claro / Oscuro — app/static/js/theme.js
 * ============================================================================
 * ¿Cómo funciona este archivo?
 * ----------------------------
 * Sigue el estándar moderno de la plataforma web (`meta[name="color-scheme"]`):
 * 1. Por defecto, `<meta name="color-scheme" content="light dark">` sigue la
 *    preferencia del sistema operativo sin necesitar JavaScript.
 * 2. Cuando el usuario pulsa el botón de tema en la barra superior, calculamos
 *    el esquema opuesto al que se está viendo actualmente.
 * 3. Si el nuevo esquema coincide con el del sistema operativo, borramos el
 *    valor de `localStorage` y volvemos a `"light dark"` (automático).
 *    Si difiere, guardamos `"light"` o `"dark"` y actualizamos el `<meta>`.
 * ============================================================================
 */

(function initThemeController() {
  const metaScheme = document.querySelector('meta[name="color-scheme"]');
  const toggleBtn = document.getElementById("theme-toggle-btn");

  if (!metaScheme || !toggleBtn) return;

  /**
   * Devuelve el esquema preferido actualmente por el sistema operativo.
   * @returns {"dark" | "light"}
   */
  function getSystemScheme() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  /**
   * Devuelve el esquema que se está mostrando efectivamente en pantalla ahora.
   * @returns {"dark" | "light"}
   */
  function getCurrentRenderedScheme() {
    const content = metaScheme.content;
    if (content === "dark" || content === "light") {
      return content;
    }
    return getSystemScheme();
  }

  /**
   * Alterna entre el esquema actual y su opuesto, respetando el retorno
   * al modo automático del sistema cuando ambos coinciden.
   */
  toggleBtn.addEventListener("click", () => {
    const current = getCurrentRenderedScheme();
    const target = current === "dark" ? "light" : "dark";
    const system = getSystemScheme();

    try {
      if (target === system) {
        // El usuario volvió al tema nativo de su sistema: limpiamos el override
        localStorage.removeItem("color-scheme");
        metaScheme.content = "light dark";
      } else {
        // El usuario eligió el tema opuesto al de su sistema: lo fijamos
        localStorage.setItem("color-scheme", target);
        metaScheme.content = target;
      }
    } catch (_) {
      metaScheme.content = target;
    }
  });

  // Sincronización entre pestañas abiertas del mismo sitio
  window.addEventListener("storage", (event) => {
    if (event.key === "color-scheme") {
      metaScheme.content = event.newValue ?? "light dark";
    }
  });
})();
