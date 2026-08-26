import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import { cliDoctor, isTauri, readSettings, writeSettings } from "../lib/bridge";
import { ink, fog } from "../theme";
import type { CliProbe, CliProfile, GlobalSettings } from "../lib/types";

/**
 * Machine-local settings: the API key vault and the CLI backends that spend
 * those keys.
 *
 * These are deliberately not project data. A key synced through PocketBase
 * would be readable by every member of the project, and a binary path is
 * meaningless on anyone else's machine — so both live in one file next to the
 * CLIs, on the box that actually spawns them.
 */

/** Vault entries the built-in profiles read, in the order they are shown. */
const VAULT = [
  {
    id: "anthropic",
    label: "Anthropic",
    used: "Claude Code",
    hint: "sk-ant-…",
    note: "Optional — leave blank to keep using the sign-in the CLI already holds.",
  },
  {
    id: "openai",
    label: "OpenAI",
    used: "Codex CLI (ChatGPT), OpenCode",
    hint: "sk-…",
    note: "Optional — leave blank to use the ChatGPT sign-in stored by Codex.",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    used: "Kimi CLI, Kimi via Claude Code, OpenCode",
    hint: "sk-…",
    note: "Required for both Kimi backends. Get one at platform.moonshot.ai.",
  },
] as const;

const ARGV_KINDS: Array<{ value: CliProfile["argv"]; label: string }> = [
  { value: "claude", label: "Claude Code (-p --output-format stream-json)" },
  { value: "codex", label: "Codex (exec --json)" },
  { value: "openCode", label: "OpenCode (run)" },
  { value: "template", label: "Custom argv template" },
];

const OUTPUTS: Array<{ value: CliProfile["output"]; label: string }> = [
  { value: "claudeStreamJson", label: "Claude stream-json" },
  { value: "codexJsonl", label: "Codex JSON lines" },
  { value: "plain", label: "Plain text" },
];

const blankProfile = (id: string): CliProfile => ({
  id,
  label: id,
  description: "",
  bin: id,
  argv: "template",
  template: ["{prompt}"],
  extraArgs: [],
  promptVia: "arg",
  output: "plain",
  defaultModel: "",
  env: {},
  keyRefs: [],
  supports: {
    resume: false,
    systemPrompt: false,
    permissionMode: false,
    effort: false,
    tools: false,
    addDirs: false,
  },
  builtin: false,
  enabled: true,
});

const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** `KEY=value` per line, which round-trips cleanly through a textarea. */
const envToText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

const envFromText = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
};

/** One argument per line: an argv entry may legitimately contain spaces. */
const linesToArgs = (text: string) =>
  text.split("\n").map((l) => l.trim()).filter(Boolean);

// ------------------------------------------------------------------- state

export interface GlobalSettingsState {
  settings: GlobalSettings | null;
  dirty: boolean;
  saving: boolean;
  error: string;
  notice: string;
  setKey: (name: string, value: string) => void;
  setDefaultProfile: (id: string) => void;
  patchProfile: (id: string, patch: Partial<CliProfile>) => void;
  addProfile: (id: string) => void;
  removeProfile: (id: string) => void;
  /** Drop an override so the built-in profile that ships with the app returns. */
  resetProfile: (id: string) => Promise<void>;
  save: () => Promise<void>;
  reload: () => Promise<void>;
}

/**
 * Loads the settings file once and keeps an edited copy until Save.
 *
 * Editing in place would write API keys to disk on every keystroke, which is
 * both noisy and a good way to persist a half-pasted key.
 */
export function useGlobalSettings(): GlobalSettingsState {
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    try {
      setSettings(await readSettings());
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const commit = async (next: {
    defaultProfile: string;
    keys: Record<string, string>;
    profiles: CliProfile[];
  }) => {
    setSaving(true);
    setError("");
    try {
      setSettings(await writeSettings(next));
      setDirty(false);
      setNotice("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const edit = (next: (prev: GlobalSettings) => GlobalSettings) => {
    setSettings((prev) => (prev ? next(prev) : prev));
    setDirty(true);
    setNotice("");
  };

  return {
    settings,
    dirty,
    saving,
    error,
    notice,

    setKey: (name, value) =>
      edit((prev) => ({ ...prev, keys: { ...prev.keys, [name]: value } })),

    setDefaultProfile: (id) => edit((prev) => ({ ...prev, defaultProfile: id })),

    patchProfile: (id, patch) =>
      edit((prev) => ({
        ...prev,
        profiles: prev.profiles.map((p) =>
          p.id === id ? { ...p, ...patch } : p,
        ),
      })),

    addProfile: (id) =>
      edit((prev) => ({ ...prev, profiles: [...prev.profiles, blankProfile(id)] })),

    removeProfile: (id) =>
      edit((prev) => ({
        ...prev,
        profiles: prev.profiles.filter((p) => p.id !== id),
        defaultProfile:
          prev.defaultProfile === id ? "claude" : prev.defaultProfile,
      })),

    resetProfile: async (id) => {
      // Resetting writes straight through instead of waiting for Save: the row
      // would otherwise disappear from the list until the file was written,
      // since the built-in only comes back on the next read. Any other pending
      // edits ride along, which is what the Save button would have done anyway.
      if (!settings) return;
      await commit({
        defaultProfile: settings.defaultProfile,
        keys: settings.keys,
        profiles: settings.profiles.filter((p) => p.id !== id),
      });
    },

    save: async () => {
      if (!settings) return;
      await commit({
        defaultProfile: settings.defaultProfile,
        keys: settings.keys,
        profiles: settings.profiles,
      });
    },

    reload,
  };
}

// ------------------------------------------------------------------- panels

function DeviceNotice() {
  return (
    <Alert severity="info" sx={{ fontSize: 12 }}>
      This device has no local CLI, so it has no keys to hold. Open the desktop
      app on the machine that runs your agents to configure them — turns started
      here are queued and executed there.
    </Alert>
  );
}

function SaveBar({ state }: { state: GlobalSettingsState }) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", pt: 0.5 }}>
      <Button
        size="small"
        variant="contained"
        disabled={!state.dirty || state.saving}
        onClick={() => void state.save()}
      >
        {state.saving ? "Saving…" : "Save"}
      </Button>
      {state.dirty && (
        <Typography sx={{ fontSize: 11, color: fog[300] }}>
          Unsaved changes
        </Typography>
      )}
      {state.notice && (
        <Typography sx={{ fontSize: 11, color: "success.main" }}>
          {state.notice}
        </Typography>
      )}
      {state.error && (
        <Typography sx={{ fontSize: 11, color: "error.main" }}>
          {state.error}
        </Typography>
      )}
    </Stack>
  );
}

/** The key vault. One field per provider, plus anything a custom CLI needs. */
export function ApiKeysPanel({ state }: { state: GlobalSettingsState }) {
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const settings = state.settings;

  // A custom profile can reference a vault name nobody predefined; surface it
  // here rather than making the user guess why its key is never injected.
  const extra = useMemo(() => {
    if (!settings) return [] as string[];
    const known = new Set<string>(VAULT.map((v) => v.id));
    const referenced = new Set<string>();
    for (const profile of settings.profiles) {
      for (const ref of profile.keyRefs) if (!known.has(ref)) referenced.add(ref);
    }
    for (const name of Object.keys(settings.keys)) {
      if (!known.has(name)) referenced.add(name);
    }
    return [...referenced].sort();
  }, [settings]);

  if (!isTauri()) return <DeviceNotice />;
  if (!settings) return <Typography sx={{ fontSize: 12 }}>Loading…</Typography>;

  const field = (
    id: string,
    label: string,
    used: string,
    hint: string,
    note: string,
  ) => (
    <Box key={id}>
      <TextField
        label={label}
        size="small"
        fullWidth
        type={shown[id] ? "text" : "password"}
        value={settings.keys[id] ?? ""}
        onChange={(e) => state.setKey(id, e.target.value)}
        placeholder={hint}
        autoComplete="off"
        slotProps={{
          input: {
            sx: { fontFamily: "var(--font-mono)", fontSize: 12 },
            endAdornment: (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  onClick={() => setShown((s) => ({ ...s, [id]: !s[id] }))}
                  aria-label={shown[id] ? "Hide key" : "Show key"}
                >
                  {shown[id] ? (
                    <VisibilityOffRoundedIcon sx={{ fontSize: 16 }} />
                  ) : (
                    <VisibilityRoundedIcon sx={{ fontSize: 16 }} />
                  )}
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
      <Typography sx={{ fontSize: 10.5, color: fog[300], mt: 0.5 }}>
        {used ? `Used by ${used}. ` : ""}
        {note}
      </Typography>
    </Box>
  );

  return (
    <Stack spacing={2.5}>
      <Typography sx={{ fontSize: 11.5, color: fog[300] }}>
        Keys are stored on this machine only, in{" "}
        <code style={{ fontSize: 11 }}>{settings.path}</code>, and are handed to
        a CLI as environment variables when it runs. They are never written to
        PocketBase and never leave this device.
      </Typography>

      {VAULT.map((v) => field(v.id, v.label, v.used, v.hint, v.note))}

      {extra.length > 0 && (
        <>
          <Divider sx={{ borderColor: ink[600] }} />
          <Typography sx={{ fontSize: 11, fontWeight: 600 }}>
            Referenced by your custom backends
          </Typography>
          {extra.map((name) => field(name, name, "", "", ""))}
        </>
      )}

      <SaveBar state={state} />
    </Stack>
  );
}

/** One backend, collapsed to a row until it is opened. */
function ProfileRow({
  profile,
  state,
  open,
  onToggle,
  probe,
  onProbe,
}: {
  profile: CliProfile;
  state: GlobalSettingsState;
  open: boolean;
  onToggle: () => void;
  probe: CliProbe | undefined;
  onProbe: () => void;
}) {
  const isDefault = state.settings?.defaultProfile === profile.id;
  const patch = (p: Partial<CliProfile>) => state.patchProfile(profile.id, p);

  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: isDefault ? "primary.main" : ink[600],
        borderRadius: "10px",
        p: 1.5,
        bgcolor: ink[800],
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Tooltip title={profile.enabled ? "Enabled" : "Disabled"}>
          <Switch
            size="small"
            checked={profile.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
        </Tooltip>

        <Box
          sx={{ flex: 1, cursor: "pointer", minWidth: 0 }}
          onClick={onToggle}
        >
          <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
            <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>
              {profile.label}
            </Typography>
            {isDefault && (
              <Chip size="small" color="primary" label="default" sx={{ height: 17, "& .MuiChip-label": { fontSize: 9.5, px: 0.75 } }} />
            )}
            {!profile.builtin && (
              <Chip size="small" label="custom" sx={{ height: 17, bgcolor: ink[700], "& .MuiChip-label": { fontSize: 9.5, px: 0.75 } }} />
            )}
          </Stack>
          <Typography
            sx={{
              fontSize: 10.5,
              color: fog[300],
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {profile.bin}
            {profile.defaultModel ? ` · ${profile.defaultModel}` : ""}
          </Typography>
        </Box>

        {!isDefault && (
          <Button
            size="small"
            color="inherit"
            onClick={() => state.setDefaultProfile(profile.id)}
          >
            Make default
          </Button>
        )}
        <Button size="small" color="inherit" onClick={onProbe}>
          Test
        </Button>
        <Button size="small" color="inherit" onClick={onToggle}>
          {open ? "Close" : "Edit"}
        </Button>
      </Stack>

      {probe && (
        <Alert
          severity={probe.ok ? "success" : "warning"}
          sx={{ mt: 1, fontSize: 11, py: 0 }}
        >
          {probe.ok ? probe.version || "found" : probe.error || "not runnable"}
          {probe.missingKeys.length > 0 &&
            ` · missing key: ${probe.missingKeys.join(", ")}`}
        </Alert>
      )}

      {open && (
        <Stack spacing={1.75} sx={{ mt: 2 }}>
          {profile.description && (
            <Typography sx={{ fontSize: 11, color: fog[300] }}>
              {profile.description}
            </Typography>
          )}

          <Stack direction="row" spacing={1.5}>
            <TextField
              label="Name"
              size="small"
              fullWidth
              value={profile.label}
              onChange={(e) => patch({ label: e.target.value })}
            />
            <TextField
              label="Default model"
              size="small"
              fullWidth
              value={profile.defaultModel}
              onChange={(e) => patch({ defaultModel: e.target.value })}
              helperText="Used when no agent or project names one"
              slotProps={{ input: { sx: { fontFamily: "var(--font-mono)", fontSize: 12 } } }}
            />
          </Stack>

          <TextField
            label="Executable"
            size="small"
            fullWidth
            value={profile.bin}
            onChange={(e) => patch({ bin: e.target.value })}
            helperText="Name on PATH, or an absolute path"
            slotProps={{ input: { sx: { fontFamily: "var(--font-mono)", fontSize: 12 } } }}
          />

          <Stack direction="row" spacing={1.5}>
            <FormControl size="small" fullWidth>
              <InputLabel>Argument layout</InputLabel>
              <Select
                label="Argument layout"
                value={profile.argv}
                onChange={(e) =>
                  patch({ argv: e.target.value as CliProfile["argv"] })
                }
              >
                {ARGV_KINDS.map((k) => (
                  <MenuItem key={k.value} value={k.value} sx={{ fontSize: 12 }}>
                    {k.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>Output format</InputLabel>
              <Select
                label="Output format"
                value={profile.output}
                onChange={(e) =>
                  patch({ output: e.target.value as CliProfile["output"] })
                }
              >
                {OUTPUTS.map((o) => (
                  <MenuItem key={o.value} value={o.value} sx={{ fontSize: 12 }}>
                    {o.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 130 }}>
              <InputLabel>Prompt via</InputLabel>
              <Select
                label="Prompt via"
                value={profile.promptVia}
                onChange={(e) =>
                  patch({ promptVia: e.target.value as CliProfile["promptVia"] })
                }
              >
                <MenuItem value="stdin" sx={{ fontSize: 12 }}>stdin</MenuItem>
                <MenuItem value="arg" sx={{ fontSize: 12 }}>argument</MenuItem>
              </Select>
            </FormControl>
          </Stack>

          {profile.argv === "template" && (
            <TextField
              label="Argv template"
              size="small"
              fullWidth
              multiline
              minRows={4}
              value={profile.template.join("\n")}
              onChange={(e) => patch({ template: linesToArgs(e.target.value) })}
              helperText="One argument per line. {prompt} {model} {cwd} {system} {session}. An argument whose placeholder is empty is dropped, along with the flag before it."
              slotProps={{ input: { sx: { fontFamily: "var(--font-mono)", fontSize: 12 } } }}
            />
          )}

          <TextField
            label="Extra arguments"
            size="small"
            fullWidth
            multiline
            minRows={2}
            value={profile.extraArgs.join("\n")}
            onChange={(e) => patch({ extraArgs: linesToArgs(e.target.value) })}
            helperText="One per line, appended to every run"
            slotProps={{ input: { sx: { fontFamily: "var(--font-mono)", fontSize: 12 } } }}
          />

          <TextField
            label="Environment"
            size="small"
            fullWidth
            multiline
            minRows={3}
            value={envToText(profile.env)}
            onChange={(e) => patch({ env: envFromText(e.target.value) })}
            helperText="KEY=value per line. {anthropic} {openai} {moonshot} pull from the key vault; a variable whose key is blank is left unset so the CLI keeps its own sign-in."
            slotProps={{ input: { sx: { fontFamily: "var(--font-mono)", fontSize: 12 } } }}
          />

          <Box>
            <Typography sx={{ fontSize: 11, fontWeight: 600, mb: 0.5 }}>
              Understands
            </Typography>
            <Typography sx={{ fontSize: 10.5, color: fog[300], mb: 1 }}>
              Flags this CLI does not have are dropped instead of being passed
              and rejected. With <em>system prompt</em> off, the agent's persona
              is folded into the message instead.
            </Typography>
            <Stack direction="row" sx={{ flexWrap: "wrap", gap: 0.5 }}>
              {(
                [
                  ["resume", "resume sessions"],
                  ["systemPrompt", "system prompt"],
                  ["permissionMode", "permission mode"],
                  ["effort", "effort"],
                  ["tools", "tool allowlist"],
                  ["addDirs", "extra dirs"],
                ] as const
              ).map(([key, label]) => (
                <Chip
                  key={key}
                  size="small"
                  label={label}
                  onClick={() =>
                    patch({
                      supports: {
                        ...profile.supports,
                        [key]: !profile.supports[key],
                      },
                    })
                  }
                  color={profile.supports[key] ? "primary" : "default"}
                  variant={profile.supports[key] ? "filled" : "outlined"}
                  sx={{ height: 22, "& .MuiChip-label": { fontSize: 10.5 } }}
                />
              ))}
            </Stack>
          </Box>

          <Stack direction="row" spacing={1}>
            <Box sx={{ flex: 1 }} />
            {profile.builtin ? (
              <Button
                size="small"
                color="inherit"
                startIcon={<RestartAltRoundedIcon sx={{ fontSize: 15 }} />}
                onClick={() => void state.resetProfile(profile.id)}
              >
                Reset to default
              </Button>
            ) : (
              <Button
                size="small"
                color="error"
                startIcon={<DeleteOutlineRoundedIcon sx={{ fontSize: 15 }} />}
                onClick={() => state.removeProfile(profile.id)}
              >
                Delete
              </Button>
            )}
          </Stack>
        </Stack>
      )}
    </Box>
  );
}

/** The list of CLI backends, and which one runs by default. */
export function CliBackendsPanel({ state }: { state: GlobalSettingsState }) {
  const [open, setOpen] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, CliProbe>>({});
  const [newId, setNewId] = useState("");
  const settings = state.settings;

  if (!isTauri()) return <DeviceNotice />;
  if (!settings) return <Typography sx={{ fontSize: 12 }}>Loading…</Typography>;

  const probe = async (id: string) => {
    // Probing reads the file on disk, so an unsaved edit would test the old
    // binary and report a confusing result.
    if (state.dirty) await state.save();
    const result = await cliDoctor(id);
    setProbes((p) => ({ ...p, [id]: result }));
  };

  const add = () => {
    const id = slug(newId);
    if (!id || settings.profiles.some((p) => p.id === id)) return;
    state.addProfile(id);
    setNewId("");
    setOpen(id);
  };

  return (
    <Stack spacing={2}>
      <Typography sx={{ fontSize: 11.5, color: fog[300] }}>
        Every agent turn is one CLI process. Pick which CLI runs by default; a
        project or a single agent can override it. Reset returns a built-in
        backend to the version that ships with the app.
      </Typography>

      {settings.profiles.map((profile) => (
        <ProfileRow
          key={profile.id}
          profile={profile}
          state={state}
          open={open === profile.id}
          onToggle={() => setOpen((cur) => (cur === profile.id ? null : profile.id))}
          probe={probes[profile.id]}
          onProbe={() => void probe(profile.id)}
        />
      ))}

      <Divider sx={{ borderColor: ink[600] }} />

      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <TextField
          size="small"
          placeholder="my-cli"
          label="Add a CLI"
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          sx={{ maxWidth: 240 }}
        />
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          startIcon={<AddRoundedIcon sx={{ fontSize: 15 }} />}
          disabled={!slug(newId)}
          onClick={add}
        >
          Add
        </Button>
      </Stack>

      <SaveBar state={state} />
    </Stack>
  );
}
