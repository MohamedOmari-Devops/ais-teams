import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  InputAdornment,
  Stack,
  Typography,
} from "@mui/material";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import KeyboardArrowRightRoundedIcon from "@mui/icons-material/KeyboardArrowRightRounded";
import { cliDoctor, isTauri, readSettings, writeSettings } from "../lib/bridge";
import {
  BoolControl,
  Mono,
  SelectControl,
  SettingRow,
  TextControl,
  type SectionDef,
  type SettingDef,
} from "./SettingsRow";
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

const SUPPORT_FLAGS = [
  ["resume", "resume sessions"],
  ["systemPrompt", "system prompt"],
  ["permissionMode", "permission mode"],
  ["effort", "effort"],
  ["tools", "tool allowlist"],
  ["addDirs", "extra dirs"],
] as const;

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
  /** The file as it is on disk, for the "(Modified)" markers. */
  pristine: GlobalSettings | null;
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
  const [pristine, setPristine] = useState<GlobalSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    try {
      const loaded = await readSettings();
      setSettings(loaded);
      setPristine(loaded);
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
      const saved = await writeSettings(next);
      setSettings(saved);
      setPristine(saved);
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
    pristine,
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

// ------------------------------------------------------------------ pieces

function DeviceNotice() {
  return (
    <Alert severity="info" sx={{ fontSize: 12.5 }}>
      This device has no local CLI, so it has no keys to hold. Open the desktop
      app on the machine that runs your agents to configure them — turns started
      here are queued and executed there.
    </Alert>
  );
}

/** A key field with the reveal toggle every password box needs. */
function KeyControl({
  value,
  onChange,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  hint: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <TextControl
      value={value}
      onChange={onChange}
      placeholder={hint}
      mono
      width={460}
      type={shown ? "text" : "password"}
      endAdornment={
        <InputAdornment position="end">
          <IconButton
            size="small"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? "Hide key" : "Show key"}
          >
            {shown ? (
              <VisibilityOffRoundedIcon sx={{ fontSize: 16 }} />
            ) : (
              <VisibilityRoundedIcon sx={{ fontSize: 16 }} />
            )}
          </IconButton>
        </InputAdornment>
      }
    />
  );
}

/**
 * One backend in the list: a summary line that expands into its own settings.
 *
 * Nesting rows inside a row is how VS Code renders a setting that is really a
 * small object, and it keeps a five-backend list from becoming five screens.
 */
function ProfileItem({
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

  const stored = state.pristine?.profiles.find((p) => p.id === profile.id);
  const changed = (field: keyof CliProfile) =>
    stored
      ? JSON.stringify(stored[field]) !== JSON.stringify(profile[field])
      : false;

  const rows: SettingDef[] = [
    {
      id: "label",
      group: profile.label,
      name: "Display name",
      description: "What this backend is called in the pickers.",
      control: (
        <TextControl value={profile.label} onChange={(v) => patch({ label: v })} width={320} />
      ),
      modified: changed("label"),
    },
    {
      id: "bin",
      group: profile.label,
      name: "Executable",
      description: "A name on PATH, or an absolute path to the binary.",
      control: (
        <TextControl value={profile.bin} onChange={(v) => patch({ bin: v })} mono width={460} />
      ),
      modified: changed("bin"),
    },
    {
      id: "model",
      group: profile.label,
      name: "Default model",
      description: "Used when neither the agent nor the project names one.",
      control: (
        <TextControl
          value={profile.defaultModel}
          onChange={(v) => patch({ defaultModel: v })}
          mono
          width={320}
        />
      ),
      modified: changed("defaultModel"),
    },
    {
      id: "argv",
      group: profile.label,
      name: "Argument layout",
      description: "How the command line is assembled for this CLI.",
      control: (
        <SelectControl
          value={profile.argv}
          onChange={(v) => patch({ argv: v })}
          options={ARGV_KINDS}
          width={460}
        />
      ),
      modified: changed("argv"),
    },
    {
      id: "output",
      group: profile.label,
      name: "Output format",
      description: "How the CLI's stdout is read back into the transcript.",
      control: (
        <SelectControl
          value={profile.output}
          onChange={(v) => patch({ output: v })}
          options={OUTPUTS}
          width={460}
        />
      ),
      modified: changed("output"),
    },
    {
      id: "promptVia",
      group: profile.label,
      name: "Prompt delivery",
      description:
        "stdin keeps long prompts off the command line, which Windows caps near 32 KB.",
      control: (
        <SelectControl
          value={profile.promptVia}
          onChange={(v) => patch({ promptVia: v })}
          options={[
            { value: "stdin", label: "stdin" },
            { value: "arg", label: "argument" },
          ]}
          width={220}
        />
      ),
      modified: changed("promptVia"),
    },
  ];

  if (profile.argv === "template") {
    rows.push({
      id: "template",
      group: profile.label,
      name: "Argv template",
      description: (
        <>
          One argument per line. <Mono>{"{prompt}"}</Mono> <Mono>{"{model}"}</Mono>{" "}
          <Mono>{"{cwd}"}</Mono> <Mono>{"{system}"}</Mono> <Mono>{"{session}"}</Mono>{" "}
          are substituted; an argument whose placeholder is empty is dropped,
          along with the flag in front of it.
        </>
      ),
      control: (
        <TextControl
          value={profile.template.join("\n")}
          onChange={(v) => patch({ template: linesToArgs(v) })}
          mono
          minRows={4}
          width={560}
        />
      ),
      modified: changed("template"),
    });
  }

  rows.push(
    {
      id: "extraArgs",
      group: profile.label,
      name: "Extra arguments",
      description: "One per line, appended to every run.",
      control: (
        <TextControl
          value={profile.extraArgs.join("\n")}
          onChange={(v) => patch({ extraArgs: linesToArgs(v) })}
          mono
          minRows={2}
          width={560}
        />
      ),
      modified: changed("extraArgs"),
    },
    {
      id: "env",
      group: profile.label,
      name: "Environment",
      description: (
        <>
          <Mono>KEY=value</Mono> per line. <Mono>{"{anthropic}"}</Mono>{" "}
          <Mono>{"{openai}"}</Mono> <Mono>{"{moonshot}"}</Mono> pull from the key
          vault; a variable whose key is blank is left unset, so a CLI you signed
          into keeps its own credentials.
        </>
      ),
      control: (
        <TextControl
          value={envToText(profile.env)}
          onChange={(v) => patch({ env: envFromText(v) })}
          mono
          minRows={3}
          width={560}
        />
      ),
      modified: changed("env"),
    },
    {
      id: "supports",
      group: profile.label,
      name: "Understands",
      description:
        "Flags this CLI does not have are dropped rather than passed and rejected. With system prompt off, the agent's persona is folded into the message instead.",
      control: (
        <Stack direction="row" sx={{ flexWrap: "wrap", gap: 0.5 }}>
          {SUPPORT_FLAGS.map(([key, label]) => (
            <Chip
              key={key}
              size="small"
              label={label}
              onClick={() =>
                patch({
                  supports: { ...profile.supports, [key]: !profile.supports[key] },
                })
              }
              color={profile.supports[key] ? "primary" : "default"}
              variant={profile.supports[key] ? "filled" : "outlined"}
              sx={{ height: 22, "& .MuiChip-label": { fontSize: 11 } }}
            />
          ))}
        </Stack>
      ),
      modified: changed("supports"),
    },
  );

  return (
    <Box sx={{ borderTop: `1px solid ${ink[600]}` }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          py: 1,
          cursor: "pointer",
          "&:hover": { bgcolor: ink[700] },
        }}
        onClick={onToggle}
      >
        <KeyboardArrowRightRoundedIcon
          sx={{
            fontSize: 17,
            color: fog[300],
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform .15s",
          }}
        />
        <BoolControl
          checked={profile.enabled}
          onChange={(v) => patch({ enabled: v })}
        />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
            <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
              {profile.label}
            </Typography>
            {isDefault && (
              <Chip
                size="small"
                color="primary"
                label="default"
                sx={{ height: 17, "& .MuiChip-label": { fontSize: 9.5, px: 0.75 } }}
              />
            )}
            {!profile.builtin && (
              <Chip
                size="small"
                label="custom"
                sx={{
                  height: 17,
                  bgcolor: ink[700],
                  "& .MuiChip-label": { fontSize: 9.5, px: 0.75 },
                }}
              />
            )}
          </Stack>
          <Typography
            sx={{
              fontSize: 11,
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
            onClick={(e) => {
              e.stopPropagation();
              state.setDefaultProfile(profile.id);
            }}
          >
            Make default
          </Button>
        )}
        <Button
          size="small"
          color="inherit"
          onClick={(e) => {
            e.stopPropagation();
            onProbe();
          }}
        >
          Test
        </Button>
      </Stack>

      {probe && (
        <Alert
          severity={probe.ok ? "success" : "warning"}
          sx={{ mb: 1, fontSize: 11.5, py: 0 }}
        >
          {probe.ok ? probe.version || "found" : probe.error || "not runnable"}
          {probe.missingKeys.length > 0 &&
            ` · missing key: ${probe.missingKeys.join(", ")}`}
        </Alert>
      )}

      {open && (
        <Stack spacing={2.5} sx={{ pb: 2.5, pl: 4 }}>
          {profile.description && (
            <Typography sx={{ fontSize: 12.5, color: fog[300], maxWidth: 720 }}>
              {profile.description}
            </Typography>
          )}

          {rows.map((row) => (
            <SettingRow key={row.id} setting={row} anchor={`${profile.id}.${row.id}`} />
          ))}

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

function BackendList({ state }: { state: GlobalSettingsState }) {
  const [open, setOpen] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, CliProbe>>({});
  const settings = state.settings;
  if (!settings) return null;

  const probe = async (id: string) => {
    // Probing reads the file on disk, so an unsaved edit would test the old
    // binary and report a confusing result.
    if (state.dirty) await state.save();
    const result = await cliDoctor(id);
    setProbes((p) => ({ ...p, [id]: result }));
  };

  return (
    <Box sx={{ borderBottom: `1px solid ${ink[600]}` }}>
      {settings.profiles.map((profile) => (
        <ProfileItem
          key={profile.id}
          profile={profile}
          state={state}
          open={open === profile.id}
          onToggle={() => setOpen((cur) => (cur === profile.id ? null : profile.id))}
          probe={probes[profile.id]}
          onProbe={() => void probe(profile.id)}
        />
      ))}
    </Box>
  );
}

function AddCli({ state }: { state: GlobalSettingsState }) {
  const [draft, setDraft] = useState("");
  const settings = state.settings;

  const add = () => {
    const id = slug(draft);
    if (!id || settings?.profiles.some((p) => p.id === id)) return;
    state.addProfile(id);
    setDraft("");
  };

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <TextControl
        value={draft}
        onChange={setDraft}
        placeholder="my-cli"
        width={260}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
      />
      <Button
        size="small"
        variant="outlined"
        color="inherit"
        startIcon={<AddRoundedIcon sx={{ fontSize: 15 }} />}
        disabled={!slug(draft)}
        onClick={add}
      >
        Add
      </Button>
    </Stack>
  );
}

// ---------------------------------------------------------------- sections

/**
 * The Global half of the settings tree, as data.
 *
 * Returning declarations rather than rendered JSX is what lets the shell put
 * the same settings in the tree, in the search results and in Commonly Used
 * without any of them drifting apart.
 */
export function useGlobalSections(state: GlobalSettingsState): SectionDef[] {
  const settings = state.settings;
  const pristine = state.pristine;

  // A custom profile can reference a vault name nobody predefined; surface it
  // here rather than making the user guess why its key is never injected.
  const extraKeys = useMemo(() => {
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

  return useMemo(() => {
    if (!isTauri()) {
      return [
        {
          id: "keys",
          title: "API keys",
          settings: [],
          extra: <DeviceNotice />,
          extraKeywords: "api key anthropic openai moonshot cli backend",
        },
      ];
    }
    if (!settings) {
      return [
        {
          id: "keys",
          title: "API keys",
          settings: [],
          extra: <Typography sx={{ fontSize: 12.5 }}>Loading…</Typography>,
        },
      ];
    }

    const keyModified = (id: string) =>
      (settings.keys[id] ?? "") !== (pristine?.keys[id] ?? "");

    const keyRow = (
      id: string,
      label: string,
      used: string,
      hint: string,
      note: string,
    ): SettingDef => ({
      id,
      group: "Key",
      name: label,
      keywords: `api token secret ${used}`,
      description: (
        <>
          {used ? `Used by ${used}. ` : ""}
          {note}
        </>
      ),
      control: (
        <KeyControl
          value={settings.keys[id] ?? ""}
          onChange={(v) => state.setKey(id, v)}
          hint={hint}
        />
      ),
      modified: keyModified(id),
      onReset: () => state.setKey(id, pristine?.keys[id] ?? ""),
    });

    return [
      {
        id: "keys",
        title: "API keys",
        blurb: (
          <>
            Stored on this machine only, in <Mono>{settings.path}</Mono>, and
            handed to a CLI as environment variables when it runs. Never written
            to PocketBase, never sent anywhere else.
          </>
        ),
        settings: [
          ...VAULT.map((v) => keyRow(v.id, v.label, v.used, v.hint, v.note)),
          ...extraKeys.map((name) =>
            keyRow(name, name, "", "", "Referenced by one of your custom backends."),
          ),
        ],
      },
      {
        id: "backends",
        title: "CLI backends",
        blurb:
          "Every agent turn is one CLI process. Pick which one runs by default; a project or a single agent can override it.",
        extraKeywords:
          "claude code codex opencode kimi moonshot custom argv binary executable environment",
        settings: [
          {
            id: "default",
            group: "Backends",
            name: "Default backend",
            keywords: "cli runner default profile",
            description:
              "Runs any turn whose agent and project both leave the backend unset.",
            control: (
              <SelectControl
                value={settings.defaultProfile}
                onChange={state.setDefaultProfile}
                options={settings.profiles.map((p) => ({
                  value: p.id,
                  label: p.label,
                  disabled: !p.enabled,
                }))}
                width={380}
              />
            ),
            modified: settings.defaultProfile !== pristine?.defaultProfile,
            onReset: () =>
              state.setDefaultProfile(pristine?.defaultProfile ?? "claude"),
          },
          {
            id: "list",
            group: "Backends",
            name: "Installed backends",
            keywords: "list enable disable test version claude codex opencode kimi",
            description:
              "Expand one to edit its binary, argv and environment. Test runs its --version and checks the keys it needs.",
            control: <BackendList state={state} />,
          },
          {
            id: "add",
            group: "Backends",
            name: "Add a CLI",
            keywords: "custom new template argv",
            description:
              "Creates an empty template profile. Give it a binary and one argument per line.",
            control: <AddCli state={state} />,
          },
        ],
      },
    ];
  }, [settings, pristine, extraKeys, state]);
}
