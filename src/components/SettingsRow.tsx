import type { ReactNode } from "react";
import {
  Box,
  Checkbox,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import { ink, fog } from "../theme";

/**
 * The VS Code settings editor, rebuilt on this app's own palette.
 *
 * Every setting is one row: a `Group: Name` label, a sentence of prose under
 * it, and the control under that. No cards, no boxes — the whitespace and the
 * label hierarchy do the grouping, which is what makes a long settings list
 * scannable. A row whose value differs from what is stored gets a coloured bar
 * on its left edge and a reset button, so "what did I change" is answerable
 * without diffing anything.
 *
 * Sections are declared as data rather than JSX (see `SectionDef`) because the
 * same declaration drives three things at once: the tree on the left, the
 * search filter, and the rendered list.
 */

export interface SettingDef {
  /** Unique within its section; used for the scroll anchor. */
  id: string;
  /** The prefix before the colon, e.g. "Project" in "Project: Name". */
  group: string;
  name: string;
  description?: ReactNode;
  /** Extra words the search box should match, beyond group and name. */
  keywords?: string;
  /** The input itself. */
  control: ReactNode;
  /**
   * `bool` puts the description beside the checkbox instead of above it,
   * the way a checkbox setting reads in VS Code.
   */
  variant?: "block" | "bool";
  /** Differs from the stored value: draws the bar and offers a reset. */
  modified?: boolean;
  onReset?: () => void;
  /** Rendered under the control — a preview, a hint, a result. */
  footer?: ReactNode;
}

export interface SectionDef {
  id: string;
  /** Heading shown above the section, and the label in the tree. */
  title: string;
  /** One line under the heading. */
  blurb?: ReactNode;
  settings: SettingDef[];
  /** Anything that is not a settings row — a list editor, a notice. */
  extra?: ReactNode;
  /** Hide the section when nothing matches the search and extra is present. */
  extraKeywords?: string;
}

export const haystack = (setting: SettingDef) =>
  `${setting.group} ${setting.name} ${setting.keywords ?? ""}`.toLowerCase();

/** Rows in `section` that match `query`. An empty query matches everything. */
export function filterSettings(section: SectionDef, query: string): SettingDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return section.settings;
  const words = q.split(/\s+/);
  return section.settings.filter((setting) => {
    const hay = haystack(setting);
    return words.every((word) => hay.includes(word));
  });
}

/** True when the section still has something to show under `query`. */
export function sectionMatches(section: SectionDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (filterSettings(section, q).length > 0) return true;
  const hay = `${section.title} ${section.extraKeywords ?? ""}`.toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

// ---------------------------------------------------------------- one row

export function SettingRow({
  setting,
  anchor,
}: {
  setting: SettingDef;
  /** DOM id for the scroll target; the same setting may appear twice. */
  anchor: string;
}) {
  const bool = setting.variant === "bool";

  return (
    <Box
      id={anchor}
      sx={{
        pl: 2,
        borderLeft: "2px solid",
        borderColor: setting.modified ? "primary.main" : "transparent",
        scrollMarginTop: 12,
        "&:hover .setting-reset": { opacity: 1 },
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography sx={{ fontSize: 13, color: fog[300] }}>
          {setting.group}:{" "}
          <Box component="span" sx={{ fontWeight: 700, color: fog[100] }}>
            {setting.name}
          </Box>
        </Typography>

        {setting.modified && (
          <Typography sx={{ fontSize: 12, fontStyle: "italic", color: fog[300] }}>
            (Modified)
          </Typography>
        )}

        {setting.modified && setting.onReset && (
          <Tooltip title="Reset to the stored value">
            <IconButton
              className="setting-reset"
              size="small"
              onClick={setting.onReset}
              sx={{ opacity: 0, transition: "opacity .15s", p: 0.25 }}
            >
              <RestartAltRoundedIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {!bool && setting.description && (
        <Typography sx={{ fontSize: 12.5, color: fog[300], mt: 0.5, maxWidth: 720 }}>
          {setting.description}
        </Typography>
      )}

      <Box sx={{ mt: bool ? 0.5 : 1 }}>
        {bool ? (
          <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
            {setting.control}
            <Typography
              sx={{ fontSize: 12.5, color: fog[300], pt: 0.5, maxWidth: 700 }}
            >
              {setting.description}
            </Typography>
          </Stack>
        ) : (
          setting.control
        )}
      </Box>

      {setting.footer && <Box sx={{ mt: 1 }}>{setting.footer}</Box>}
    </Box>
  );
}

// ------------------------------------------------------------- the controls

const fieldSx = (mono?: boolean) => ({
  bgcolor: ink[900],
  fontFamily: mono ? "var(--font-mono)" : undefined,
  fontSize: mono ? 12 : 13,
  "& .MuiOutlinedInput-notchedOutline": { borderColor: ink[600] },
});

/** A single-line or multi-line text box. Width is per-setting, as in VS Code. */
export function TextControl({
  value,
  onChange,
  width = 380,
  mono,
  placeholder,
  type,
  minRows,
  endAdornment,
  onBlur,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  width?: number | string;
  mono?: boolean;
  placeholder?: string;
  type?: "text" | "password" | "number";
  minRows?: number;
  endAdornment?: ReactNode;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  return (
    <TextField
      size="small"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      type={type}
      multiline={Boolean(minRows)}
      minRows={minRows}
      autoComplete="off"
      sx={{ width, maxWidth: "100%" }}
      slotProps={{ input: { sx: fieldSx(mono), endAdornment } }}
    />
  );
}

export function SelectControl<T extends string>({
  value,
  onChange,
  options,
  width = 380,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  width?: number | string;
}) {
  return (
    <Select
      size="small"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      // Without this an option whose value is "" — "inherit the default" —
      // renders as an empty box instead of its label.
      displayEmpty
      sx={{ width, maxWidth: "100%", ...fieldSx() }}
    >
      {options.map((option) => (
        <MenuItem
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          sx={{ fontSize: 13 }}
        >
          {option.label}
        </MenuItem>
      ))}
    </Select>
  );
}

export function BoolControl({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Checkbox
      size="small"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      sx={{ p: 0.25 }}
    />
  );
}

/** Inline `code` inside a description, matching the settings editor's style. */
export function Mono({ children }: { children: ReactNode }) {
  return (
    <Box
      component="code"
      sx={{
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        px: 0.6,
        py: 0.1,
        borderRadius: "4px",
        bgcolor: ink[700],
      }}
    >
      {children}
    </Box>
  );
}
