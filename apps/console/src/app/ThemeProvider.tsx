import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type Theme = "dark" | "light";
const STORAGE_KEY = "loopback.theme";

interface ThemeContextValue { readonly theme: Theme; readonly setTheme: (t: Theme) => void }
const ThemeContext = createContext<ThemeContextValue | null>(null);

function initialTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** Theme is low-frequency, app-wide state: React Context (ECC react-patterns state decision tree). */
export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const setTheme = useCallback((t: Theme) => {
    document.documentElement.setAttribute("data-theme", t);
    try { window.localStorage.setItem(STORAGE_KEY, t); } catch { /* storage unavailable: theme still applies */ }
    setThemeState(t);
  }, []);
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
