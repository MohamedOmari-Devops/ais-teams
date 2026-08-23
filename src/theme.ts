import { createTheme } from "@mui/material/styles";

/**
 * MUI theme mapped onto the palette already used by the Tailwind tokens in
 * index.css, so MUI components and the hand-rolled layout stay one design.
 *
 * Corners are deliberately small (10px) everywhere except dialogs and the
 * window shell, which are rounder because they float.
 */
export const ink = {
  900: "#0b0d12",
  800: "#12151d",
  700: "#1a1e28",
  600: "#232838",
  500: "#333a4d",
} as const;

export const fog = {
  300: "#9aa4bd",
  100: "#e6eaf5",
} as const;

export const accent = "#7c5cff";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: accent, contrastText: "#ffffff" },
    success: { main: "#3fbf7f" },
    warning: { main: "#e0a44a" },
    error: { main: "#e2585f" },
    background: { default: ink[900], paper: ink[800] },
    text: { primary: fog[100], secondary: fog[300] },
    divider: ink[600],
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
        tooltip: { backgroundColor: ink[600], fontSize: 11, borderRadius: 8 },
      },
    },
  },
});

export default theme;
