import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ColorModeProvider } from "./color-mode";
import { isTauri } from "./lib/bridge";
import "./index.css";

// Outside the frameless Tauri window there is no transparent backdrop to show
// through, so the page paints its own.
if (!isTauri()) document.documentElement.classList.add("web");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ColorModeProvider>
      <App />
    </ColorModeProvider>
  </React.StrictMode>,
);
