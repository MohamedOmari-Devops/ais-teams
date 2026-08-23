import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import App from "./App";
import theme from "./theme";
import { isTauri } from "./lib/bridge";
import "./index.css";

// Outside the frameless Tauri window there is no transparent backdrop to show
// through, so the page paints its own.
if (!isTauri()) document.documentElement.classList.add("web");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
