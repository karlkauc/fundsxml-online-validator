// Apply the stored/preferred theme before React mounts to avoid a flash.
// Lives in a separate file because the SPA's CSP (script-src 'self') blocks
// inline scripts.
(() => {
  const stored = localStorage.getItem("fxv-theme");
  const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
  const theme = stored || preferred;
  document.documentElement.classList.toggle("dark", theme === "dark");
})();
