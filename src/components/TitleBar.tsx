import { useEffect, useState } from "react";
import { Box, IconButton, Tooltip } from "@mui/material";
import RemoveRoundedIcon from "@mui/icons-material/RemoveRounded";
import CropSquareRoundedIcon from "@mui/icons-material/CropSquareRounded";
import FilterNoneRoundedIcon from "@mui/icons-material/FilterNoneRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import ExtensionRoundedIcon from "@mui/icons-material/ExtensionRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import DarkModeRoundedIcon from "@mui/icons-material/DarkModeRounded";
import { isTauri } from "../lib/bridge";
import { useColorMode } from "../color-mode";
import { ink, fog } from "../theme";

/**
 * Custom title bar for the frameless window.
 *
 * `data-tauri-drag-region` makes an area behave like a native caption: drag to
 * move, double-click to maximise. Buttons must sit outside it or they would be
 * swallowed by the drag handler.
 */
export default function TitleBar({
  subtitle,
  onOpenSettings,
  onOpenPlugins,
  onOpenArchitect,
}: {
  subtitle?: string;
  /** Opens project settings. Omitted before sign-in, where there is none. */
  onOpenSettings?: () => void;
  /** Opens the plugin browser. Omitted before sign-in. */
  onOpenPlugins?: () => void;
  /** Opens the master agent. Omitted before sign-in. */
  onOpenArchitect?: () => void;
}) {
  const [maximized, setMaximized] = useState(false);
  const { mode, toggle } = useColorMode();

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;

    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      setMaximized(await win.isMaximized());
      unlisten = await win.onResized(async () => {
        setMaximized(await win.isMaximized());
      });
    })();

    return () => unlisten?.();
  }, []);

  const act = async (name: "minimize" | "toggleMaximize" | "close") => {
    if (!isTauri()) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (name === "minimize") await win.minimize();
    else if (name === "toggleMaximize") await win.toggleMaximize();
    else await win.close();
  };

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        height: 38,
        flexShrink: 0,
        px: 1.5,
        borderBottom: `1px solid ${ink[600]}`,
        backgroundColor: ink[800],
        userSelect: "none",
      }}
    >
      <Box
        data-tauri-drag-region
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          flex: 1,
          height: "100%",
          minWidth: 0,
        }}
      >
        <Box
          data-tauri-drag-region
          sx={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: `linear-gradient(135deg, #7c5cff, #4aa8e0)`,
          }}
        />
        <Box
          data-tauri-drag-region
          sx={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.2 }}
        >
          AIS Teams
        </Box>
        {subtitle && (
          <Box
            data-tauri-drag-region
            sx={{
              fontSize: 11,
              color: fog[300],
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {subtitle}
          </Box>
        )}
      </Box>

      <Tooltip title={mode === "dark" ? "Light theme" : "Dark theme"}>
        <IconButton size="small" onClick={toggle}>
          {mode === "dark" ? (
            <LightModeRoundedIcon sx={{ fontSize: 15 }} />
          ) : (
            <DarkModeRoundedIcon sx={{ fontSize: 15 }} />
          )}
        </IconButton>
      </Tooltip>

      {onOpenArchitect && (
        <Tooltip title="Architect — describe a goal, get a team">
          <IconButton size="small" onClick={onOpenArchitect}>
            <AutoAwesomeRoundedIcon sx={{ fontSize: 15, color: "primary.main" }} />
          </IconButton>
        </Tooltip>
      )}

      {onOpenPlugins && (
        <Tooltip title="Plugins">
          <IconButton size="small" onClick={onOpenPlugins}>
            <ExtensionRoundedIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      )}

      {onOpenSettings && (
        <Tooltip title="Project settings">
          <IconButton size="small" onClick={onOpenSettings} sx={{ mr: 0.5 }}>
            <SettingsRoundedIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      )}

      <Tooltip title="Minimise">
        <IconButton size="small" onClick={() => void act("minimize")}>
          <RemoveRoundedIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title={maximized ? "Restore" : "Maximise"}>
        <IconButton size="small" onClick={() => void act("toggleMaximize")}>
          {maximized ? (
            <FilterNoneRoundedIcon sx={{ fontSize: 13 }} />
          ) : (
            <CropSquareRoundedIcon sx={{ fontSize: 15 }} />
          )}
        </IconButton>
      </Tooltip>
      <Tooltip title="Close">
        <IconButton
          size="small"
          onClick={() => void act("close")}
          sx={{ "&:hover": { backgroundColor: "#e2585f", color: "#fff" } }}
        >
          <CloseRoundedIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
