import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ThemeProvider } from "@mui/material/styles";
import { makeTheme, type ColorMode } from "./theme";

/**
 * Light/dark switching.
 *
 * The mode lives in one place — `data-theme` on <html> — which both the CSS
 * variables in index.css and the MUI theme read from. Until the user picks a
 * side we follow the OS, so the app matches the rest of the desktop; the first
 * explicit choice is remembered and the OS stops being consulted.
 *
 * index.html stamps the same attribute before the bundle loads, so launching
 * never flashes the wrong background.
 */

const KEY = "ais-teams.theme";

function storedMode(): ColorMode | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function systemMode(): ColorMode {
  return typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function initialMode(): ColorMode {
  return storedMode() ?? systemMode();
}

type ColorModeApi = {
  mode: ColorMode;
  setMode: (mode: ColorMode) => void;
  toggle: () => void;
};

const Ctx = createContext<ColorModeApi>({
  mode: "dark",
  setMode: () => {},
  toggle: () => {},
});

export const useColorMode = () => useContext(Ctx);

export function ColorModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ColorMode>(initialMode);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  // Only an explicit choice is written down — writing on every render would
  // pin the app to whatever the OS happened to say at first launch.
  const setMode = useCallback((next: ColorMode) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode / storage disabled: the choice just will not survive */
    }
    setModeState(next);
  }, []);

  const toggle = useCallback(
    () => setMode(mode === "dark" ? "light" : "dark"),
    [mode, setMode],
  );

  // Track the OS while the user has not overridden it.
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      if (!storedMode()) setModeState(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const theme = useMemo(() => makeTheme(mode), [mode]);
  const api = useMemo(() => ({ mode, setMode, toggle }), [mode, setMode, toggle]);

  return (
    <Ctx.Provider value={api}>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>
    </Ctx.Provider>
  );
}
