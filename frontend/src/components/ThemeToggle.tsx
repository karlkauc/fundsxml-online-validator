import { useState } from "react";

type Theme = "light" | "dark";

/** public/theme-init.js applies the stored/system theme before first paint. */
function current(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem("fxv-theme", next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      className="btn"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title={`Theme: ${theme}`}
    >
      {theme === "dark" ? "☾" : "☀"}
    </button>
  );
}
