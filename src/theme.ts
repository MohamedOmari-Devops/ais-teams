import { createTheme } from "@mui/material/styles";

/**
 * MUI theme mapped onto the palette already used by the Tailwind tokens in
 * index.css, so MUI components and the hand-rolled layout stay one design.
 *
 * Corners are deliberately small (10px) everywhere except dialogs and the
 * window shell, which are rounder because they float.
 */

export type ColorMode = "light" | "dark";

/**
 * Colour tokens for `sx` and template strings. These are CSS variables, not
 * literals: their values live in index.css keyed off `data-theme` on <html>,
 * so anything painted through them follows the light/dark switch on its own.
 */
export const ink = {
  900: "var(--ais-ink-900)",
  800: "var(--ais-ink-800)",
  700: "var(--ais-ink-700)",
  600: "var(--ais-ink-600)",
  500: "var(--ais-ink-500)",
} as const;

export const fog = {
  300: "var(--ais-fog-300)",
  100: "var(--ais-fog-100)",
} as const;

export const accent = "var(--ais-accent)";

/**
 * The same palette as literals, per mode.
 *
 * MUI derives hover, disabled and contrast shades arithmetically, which it
 * cannot do with `var(...)`, so its `palette` gets real hex while everything
 * cosmetic above goes through the variables. The two must stay in sync with
 * the `:root` blocks in index.css.
 */
const literals = {
  dark: {
    ink: {
      900: "#0b0d12",
      800: "#12151d",
      700: "#1a1e28",
      600: "#232838",
      500: "#333a4d",
    },
    fog: { 300: "#9aa4bd", 100: "#e6eaf5" },
    accent: "#3d86ff",
    ok: "#3fbf7f",
    warn: "#e0a44a",
    bad: "#e2585f",
  },
  light: {
    ink: {
      900: "#f4f6fb",
      800: "#ffffff",
      700: "#eceff7",
      600: "#dde2ee",
      500: "#bfc7d9",
    },
    fog: { 300: "#5b6478", 100: "#12151d" },
    accent: "#106bfb",
    ok: "#17915a",
    warn: "#a86f12",
    bad: "#d03a44",
  },
} as const;

/** Builds the MUI theme for one mode. Component overrides use the variables,
 *  so only the palette actually differs between the two. */
export function makeTheme(mode: ColorMode) {
  const c = literals[mode];

  return createTheme({
    palette: {
      mode,
      primary: { main: c.accent, contrastText: "#ffffff" },
      success: { main: c.ok },
      warning: { main: c.warn },
      error: { main: c.bad },
      background: { default: c.ink[900], paper: c.ink[800] },
      text: { primary: c.fog[100], secondary: c.fog[300] },
      divider: c.ink[600],
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily: 'ui-sans-serif, system-ui, "Segoe UI", sans-serif',
      fontSize: 13,
      button: { textTransform: "none", fontWeight: 500 },
    },
    components: {
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: "none" },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 16,
            border: `1px solid ${ink[600]}`,
            backgroundColor: ink[800],
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 10,
            backgroundColor: ink[700],
            "& .MuiOutlinedInput-notchedOutline": { borderColor: ink[600] },
            "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: ink[500] },
          },
          input: { fontSize: 13 },
        },
      },
      MuiInputLabel: {
        styleOverrides: { root: { fontSize: 13 } },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: { root: { borderRadius: 10 } },
      },
      MuiChip: {
        styleOverrides: { root: { borderRadius: 8 } },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            borderRadius: 12,
            border: `1px solid ${ink[600]}`,
            backgroundColor: ink[800],
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: ink[600],
            color: fog[100],
            fontSize: 11,
            borderRadius: 8,
          },
        },
      },
    },
  });
}
