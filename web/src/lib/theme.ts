const STORAGE_KEY = "ww-theme";

export type Theme = "dark" | "light";

export function getStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    // ignore (private mode, blocked storage)
  }
  return "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore
  }
}
