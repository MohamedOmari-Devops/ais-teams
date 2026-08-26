import { useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import KeyboardArrowRightRoundedIcon from "@mui/icons-material/KeyboardArrowRightRounded";
import { pb, currentUserId } from "../lib/pb";
import { isTauri, pickFolder, scanAgentFiles } from "../lib/bridge";
import { useGlobalSections, useGlobalSettings } from "./GlobalSettings";
import {
  Mono,
  SelectControl,
  SettingRow,
  TextControl,
  filterSettings,
  sectionMatches,
  type SectionDef,
  type SettingDef,
} from "./SettingsRow";
import { ink, fog } from "../theme";
import type { Agent, AgentFile, Project } from "../lib/types";

const MODELS = ["fable", "opus", "sonnet", "haiku"];
const COLORS = ["#106bfb", "#3fbf7f", "#e0a44a", "#e2585f", "#4aa8e0", "#c86ee0"];

const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Section ids, in the order they appear under their scope. */
export type SectionId =
  | "identity"
  | "brief"
  | "agents"
  | "models"
  | "keys"
  | "backends";

type Scope = "project" | "global";

const GLOBAL_SECTIONS: SectionId[] = ["keys", "backends"];
const scopeOf = (section: SectionId): Scope =>
  GLOBAL_SECTIONS.includes(section) ? "global" : "project";

/** What a project looks like before anyone has touched it. */
const PROJECT_DEFAULTS: Partial<Project> = {
  name: "",
  description: "",
  instructions: "",
  root_path: "",
  agents_dir: "",
  color: COLORS[0],
  default_model: "sonnet",
  cli_profile: "",
  context_budget: 3000,
  archived: false,
};

/** The few settings worth putting in front of someone who just opened this. */
const COMMON: Record<Scope, string[]> = {
  project: [
    "identity.name",
    "identity.root_path",
    "models.cli_profile",
    "models.default_model",
    "brief.instructions",
  ],
  global: ["keys.anthropic", "keys.openai", "keys.moonshot", "backends.default"],
};

/**
 * Settings, laid out the way a code editor lays them out: a search box over
 * everything, a scope switch, a tree on the left, and one flat scrolling list
 * of rows on the right.
 *
 * The two scopes are not cosmetic. Everything under Project is stored in
 * PocketBase and shared with everyone in the project; everything under Global
 * lives in a file on this machine and never leaves it. Mixing them into one
 * list is how someone ends up pushing an API key to their team.
 */
export default function SettingsDialog({
  project,
  onClose,
  initialSection = "identity",
}: {
  project: Project | null;
  onClose: (saved: Project | null) => void;
  initialSection?: SectionId;
}) {
  const [scope, setScope] = useState<Scope>(scopeOf(initialSection));
  const [expanded, setExpanded] = useState<string[]>([initialSection]);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<Partial<Project>>(project ?? PROJECT_DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [found, setFound] = useState<AgentFile[] | null>(null);
  const [notice, setNotice] = useState("");
  const global = useGlobalSettings();
  const content = useRef<HTMLDivElement>(null);

  const set = <K extends keyof Project>(key: K, value: Project[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  /** The value a project setting reverts to: what is stored, or the default. */
  const stored = <K extends keyof Project>(key: K) =>
    (project?.[key] ?? PROJECT_DEFAULTS[key]) as Project[K];

  const changed = (key: keyof Project) =>
    JSON.stringify(form[key] ?? "") !== JSON.stringify(stored(key) ?? "");

  async function browse(field: "root_path" | "agents_dir", title: string) {
    const picked = await pickFolder(title);
    if (picked) set(field, picked);
  }

  async function save(): Promise<Project | null> {
    if (!form.name?.trim()) return null;
    setBusy(true);
    setError("");
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        owner: project?.owner ?? currentUserId(),
        members: project?.members ?? [currentUserId()],
        slug:
          project?.slug ??
          `${slugify(form.name)}-${Math.random().toString(36).slice(2, 6)}`,
      };
      const saved = project
        ? await pb.collection("projects").update<Project>(project.id, payload)
        : await pb.collection("projects").create<Project>(payload);
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** Preview the `.md` agent files in `agents_dir` without writing anything. */
  async function scan() {
    setError("");
    setNotice("");
    if (!form.agents_dir) {
      setError("Pick an agents folder first.");
      return;
    }
    try {
      const files = await scanAgentFiles(form.agents_dir);
      setFound(files);
      if (files.length === 0) setNotice("No .md agent files in that folder.");
    } catch (err) {
      setFound(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Create or update one agent per markdown file.
   *
   * Matching is by name, so re-importing after editing a file updates the
   * existing agent instead of creating a duplicate.
   */
  async function importAgents() {
    if (!found?.length) return;
    setBusy(true);
    setError("");
    try {
      const saved = project ?? (await save());
      if (!saved) return;

      const existing = await pb
        .collection("agents")
        .getFullList<Agent>({ filter: `project = "${saved.id}"` });
      const byName = new Map(existing.map((a) => [a.name.toLowerCase(), a]));

      let created = 0;
      let updated = 0;
      for (const file of found) {
        const payload = {
          project: saved.id,
          name: file.name,
          role: file.description,
          instructions: file.instructions,
          model: MODELS.includes(file.model) ? file.model : "",
          avatar_color: file.color || COLORS[created % COLORS.length],
          allowed_tools: file.tools,
          enabled: true,
        };
        const match = byName.get(file.name.toLowerCase());
        if (match) {
          await pb.collection("agents").update(match.id, payload);
          updated += 1;
        } else {
          await pb.collection("agents").create(payload);
          created += 1;
        }
      }
      // Remember the folder that was just imported from, so the next import
      // does not start with an empty path. Only this field — other edits in
      // the form stay unsaved until Save is pressed.
      if (project && form.agents_dir && form.agents_dir !== project.agents_dir) {
        await pb
          .collection("projects")
          .update(project.id, { agents_dir: form.agents_dir });
      }

      setNotice(`Imported ${created} new, updated ${updated}.`);
      if (!project) onClose(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const globalSections = useGlobalSections(global);
  const profiles = global.settings?.profiles ?? [];
  const defaultBackendLabel =
    profiles.find((p) => p.id === global.settings?.defaultProfile)?.label ??
    "the machine default";

  // ------------------------------------------------------------- sections

  const projectSections: SectionDef[] = useMemo(() => {
    const row = (
      def: Omit<SettingDef, "modified" | "onReset"> & { field?: keyof Project },
    ): SettingDef => {
      const field = def.field;
      if (!field) return def;
      return {
        ...def,
        modified: changed(field),
        onReset: () => set(field, stored(field)),
      };
    };

    return [
      {
        id: "identity",
        title: "General",
        blurb: "What this project is, and where its code lives.",
        settings: [
          row({
            id: "name",
            field: "name",
            group: "Project",
            name: "Name",
            keywords: "title label",
            description: "Shown in the sidebar and above every channel in this project.",
            control: (
              <TextControl
                value={form.name ?? ""}
                onChange={(v) => set("name", v)}
                placeholder="Payments rewrite"
                width={380}
              />
            ),
          }),
          row({
            id: "description",
            field: "description",
            group: "Project",
            name: "Objective",
            keywords: "goal purpose summary",
            description:
              "One line on what this project is trying to achieve. Every agent turn sees it.",
            control: (
              <TextControl
                value={form.description ?? ""}
                onChange={(v) => set("description", v)}
                placeholder="Replace the legacy webhook path."
                width={560}
              />
            ),
          }),
          row({
            id: "root_path",
            field: "root_path",
            group: "Project",
            name: "Working folder",
            keywords: "root path cwd directory repository checkout",
            description: (
              <>
                Working directory for every agent run. Empty means <Mono>.</Mono>
              </>
            ),
            control: (
              <TextControl
                value={form.root_path ?? ""}
                onChange={(v) => set("root_path", v)}
                mono
                width={560}
                endAdornment={
                  isTauri() ? (
                    <InputAdornment position="end">
                      <Button
                        size="small"
                        onClick={() => void browse("root_path", "Project folder")}
                        startIcon={<FolderOpenRoundedIcon sx={{ fontSize: 15 }} />}
                      >
                        Browse
                      </Button>
                    </InputAdornment>
                  ) : undefined
                }
              />
            ),
          }),
          row({
            id: "color",
            field: "color",
            group: "Project",
            name: "Accent colour",
            keywords: "chip swatch theme",
            description: "Marks this project's chip and its channels in the sidebar.",
            control: (
              <Stack direction="row" spacing={0.75} sx={{ pt: 0.5 }}>
                {COLORS.map((c) => (
                  <Box
                    key={c}
                    onClick={() => set("color", c)}
                    sx={{
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      cursor: "pointer",
                      background: c,
                      outline: form.color === c ? `2px solid ${fog[100]}` : "none",
                      outlineOffset: 2,
                    }}
                  />
                ))}
              </Stack>
            ),
          }),
        ],
      },
      {
        id: "brief",
        title: "Instructions",
        blurb: "The standing brief every agent in this project inherits.",
        settings: [
          row({
            id: "instructions",
            field: "instructions",
            group: "Project",
            name: "Instructions",
            keywords: "brief system prompt conventions rules",
            description:
              "Prepended to every agent turn, on top of that agent's own persona. Keep it to standing rules — anything that changes turn to turn belongs in the message.",
            control: (
              <TextControl
                value={form.instructions ?? ""}
                onChange={(v) => set("instructions", v)}
                minRows={10}
                width={720}
                placeholder="Conventional commits. No new dependencies without asking. Tests before merge."
              />
            ),
          }),
        ],
      },
      {
        id: "agents",
        title: "Agent files",
        blurb: (
          <>
            A folder of <Mono>.md</Mono> files, one per agent. Frontmatter{" "}
            <Mono>name</Mono> <Mono>description</Mono> <Mono>model</Mono>{" "}
            <Mono>color</Mono> <Mono>tools</Mono>; the body becomes the agent's
            instructions.
          </>
        ),
        settings: [
          row({
            id: "agents_dir",
            field: "agents_dir",
            group: "Agents",
            name: "Folder",
            keywords: "directory markdown import definitions",
            description: "Scanned for agent definitions. Nothing is ever written to it.",
            control: (
              <TextControl
                value={form.agents_dir ?? ""}
                onChange={(v) => set("agents_dir", v)}
                mono
                width={560}
                endAdornment={
                  isTauri() ? (
                    <InputAdornment position="end">
                      <Button
                        size="small"
                        onClick={() => void browse("agents_dir", "Agents folder")}
                        startIcon={<FolderOpenRoundedIcon sx={{ fontSize: 15 }} />}
                      >
                        Browse
                      </Button>
                    </InputAdornment>
                  ) : undefined
                }
              />
            ),
          }),
          row({
            id: "import",
            group: "Agents",
            name: "Import",
            keywords: "scan folder create update team",
            description:
              "Creates one agent per file. Files are matched to agents by name, so re-importing updates them instead of duplicating them.",
            control: (
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Button
                  size="small"
                  variant="outlined"
                  color="inherit"
                  onClick={() => void scan()}
                >
                  Scan folder
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<DownloadRoundedIcon sx={{ fontSize: 15 }} />}
                  disabled={!found?.length || busy}
                  onClick={() => void importAgents()}
                >
                  Import {found?.length ? `(${found.length})` : ""}
                </Button>
              </Stack>
            ),
            footer:
              found && found.length > 0 ? (
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
                  {found.map((file) => (
                    <Tooltip key={file.path} title={file.description || file.path}>
                      <Chip
                        size="small"
                        label={file.name}
                        sx={{
                          bgcolor: ink[700],
                          "& .MuiChip-label": { fontSize: 11 },
                          borderLeft: `3px solid ${file.color || COLORS[0]}`,
                        }}
                      />
                    </Tooltip>
                  ))}
                </Box>
              ) : undefined,
          }),
        ],
      },
      {
        id: "models",
        title: "Model & CLI",
        blurb:
          "Which backend runs this project's turns, and how much memory one turn may spend.",
        settings: [
          row({
            id: "cli_profile",
            field: "cli_profile",
            group: "Project",
            name: "CLI backend",
            keywords: "claude codex opencode kimi runner provider",
            description: (
              <>
                A single agent can still override it. Backends and their API keys
                are configured under <strong>Global</strong>, on the machine that
                runs them.
              </>
            ),
            control:
              profiles.length > 0 ? (
                <SelectControl
                  value={form.cli_profile ?? ""}
                  onChange={(v) => set("cli_profile", v)}
                  options={[
                    { value: "", label: `Machine default — ${defaultBackendLabel}` },
                    ...profiles.map((p) => ({
                      value: p.id,
                      label: p.label,
                      disabled: !p.enabled,
                    })),
                  ]}
                  width={460}
                />
              ) : (
                <TextControl
                  value={form.cli_profile ?? ""}
                  onChange={(v) => set("cli_profile", v)}
                  mono
                  width={380}
                  placeholder="machine default"
                />
              ),
          }),
          row({
            id: "default_model",
            field: "default_model",
            group: "Project",
            name: "Default model",
            keywords: "opus sonnet haiku fable",
            description:
              "Used by any agent that does not name its own. An agent on a different CLI starts from that backend's default model instead — a Claude model name means nothing to Codex.",
            control: (
              <SelectControl
                value={form.default_model ?? "sonnet"}
                onChange={(v) => set("default_model", v)}
                options={MODELS.map((m) => ({ value: m, label: m }))}
                width={260}
              />
            ),
          }),
          row({
            id: "context_budget",
            field: "context_budget",
            group: "Project",
            name: "Context budget",
            keywords: "tokens memory pack cost",
            description:
              "Tokens of compressed memory a single turn may carry. Chunks past the budget are dropped, ranked by weight and recency.",
            control: (
              <TextControl
                value={String(form.context_budget ?? 3000)}
                onChange={(v) => set("context_budget", Number(v) || 0)}
                type="number"
                width={200}
              />
            ),
          }),
        ],
      },
    ];
    // The row builders close over this render's `form` and handlers on purpose;
    // the deps below are everything that actually changes what a row shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, project, found, busy, profiles, defaultBackendLabel]);

  const sections = scope === "project" ? projectSections : globalSections;
  const searching = query.trim().length > 0;
  const visible = sections.filter((s) => sectionMatches(s, query));
  const hits = visible.reduce((n, s) => n + filterSettings(s, query).length, 0);

  const commonIds = COMMON[scope];
  const commonSettings = sections
    .flatMap((section) => section.settings.map((setting) => ({ section, setting })))
    .filter(({ section, setting }) =>
      commonIds.includes(`${section.id}.${setting.id}`),
    )
    .sort(
      (a, b) =>
        commonIds.indexOf(`${a.section.id}.${a.setting.id}`) -
        commonIds.indexOf(`${b.section.id}.${b.setting.id}`),
    );

  const jump = (anchor: string) =>
    document.getElementById(anchor)?.scrollIntoView({ block: "start" });

  const toggle = (id: string) =>
    setExpanded((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const switchScope = (next: Scope) => {
    setScope(next);
    setQuery("");
    content.current?.scrollTo({ top: 0 });
  };

  const dirty =
    scope === "project"
      ? Object.keys(PROJECT_DEFAULTS).some((k) => changed(k as keyof Project))
      : global.dirty;

  // ---------------------------------------------------------------- render

  const tabSx = (on: boolean) => ({
    px: 1.25,
    py: 0.25,
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: 12.5,
    fontWeight: on ? 600 : 400,
    color: on ? fog[100] : fog[300],
    bgcolor: on ? ink[600] : "transparent",
    "&:hover": { color: fog[100] },
  });

  return (
    <Dialog open fullWidth maxWidth="lg" onClose={() => onClose(null)}>
      <DialogContent
        sx={{ p: 0, display: "flex", flexDirection: "column", height: "80vh" }}
      >
        {/* ------------------------------------------------------- search */}
        <Box sx={{ px: 2, pt: 2, pb: 1.25 }}>
          <TextField
            fullWidth
            size="small"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings"
            slotProps={{
              input: {
                sx: { fontSize: 13, bgcolor: ink[900] },
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRoundedIcon sx={{ fontSize: 16, color: fog[300] }} />
                  </InputAdornment>
                ),
                endAdornment: searching ? (
                  <InputAdornment position="end">
                    <CloseRoundedIcon
                      onClick={() => setQuery("")}
                      sx={{ fontSize: 16, color: fog[300], cursor: "pointer" }}
                    />
                  </InputAdornment>
                ) : undefined,
              },
            }}
          />
        </Box>

        {/* --------------------------------------------------- scope tabs */}
        <Stack direction="row" spacing={0.5} sx={{ px: 2, pb: 1, alignItems: "center" }}>
          <Box onClick={() => switchScope("project")} sx={tabSx(scope === "project")}>
            Project
          </Box>
          <Box onClick={() => switchScope("global")} sx={tabSx(scope === "global")}>
            Global
          </Box>
          <Box sx={{ flex: 1 }} />
          <Typography
            sx={{
              fontSize: 11,
              color: fog[300],
              fontFamily: scope === "global" ? "var(--font-mono)" : undefined,
              maxWidth: 460,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {scope === "project"
              ? project
                ? "Shared with everyone in this project"
                : "New project — not saved yet"
              : global.settings?.path || "this machine only"}
          </Typography>
        </Stack>

        <Box
          sx={{
            display: "flex",
            flex: 1,
            minHeight: 0,
            borderTop: `1px solid ${ink[600]}`,
          }}
        >
          {/* ------------------------------------------------------ tree */}
          <Box
            sx={{
              width: 214,
              flexShrink: 0,
              borderRight: `1px solid ${ink[600]}`,
              overflowY: "auto",
              py: 1.5,
            }}
          >
            {!searching && commonSettings.length > 0 && (
              <Box
                onClick={() => jump("sec-common")}
                sx={{
                  px: 2,
                  py: 0.4,
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: "pointer",
                  "&:hover": { bgcolor: ink[700] },
                }}
              >
                Commonly Used
              </Box>
            )}

            {visible.map((section) => {
              const open = expanded.includes(section.id);
              const rows = filterSettings(section, query);
              return (
                <Box key={section.id}>
                  <Stack
                    direction="row"
                    spacing={0.25}
                    onClick={() => {
                      toggle(section.id);
                      jump(`sec-${section.id}`);
                    }}
                    sx={{
                      alignItems: "center",
                      px: 1,
                      py: 0.4,
                      cursor: "pointer",
                      fontSize: 12.5,
                      color: fog[100],
                      "&:hover": { bgcolor: ink[700] },
                    }}
                  >
                    <KeyboardArrowRightRoundedIcon
                      sx={{
                        fontSize: 16,
                        color: fog[300],
                        transform: open ? "rotate(90deg)" : "none",
                        transition: "transform .15s",
                      }}
                    />
                    <Box sx={{ flex: 1 }}>{section.title}</Box>
                    {searching && (
                      <Typography sx={{ fontSize: 10.5, color: fog[300], pr: 0.5 }}>
                        {rows.length}
                      </Typography>
                    )}
                  </Stack>

                  {open &&
                    rows.map((setting) => (
                      <Box
                        key={setting.id}
                        onClick={() => jump(`set-${section.id}-${setting.id}`)}
                        sx={{
                          pl: 4,
                          pr: 1,
                          py: 0.3,
                          fontSize: 12,
                          color: fog[300],
                          cursor: "pointer",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          "&:hover": { bgcolor: ink[700], color: fog[100] },
                        }}
                      >
                        {setting.name}
                      </Box>
                    ))}
                </Box>
              );
            })}

            {visible.length === 0 && (
              <Typography sx={{ px: 2, fontSize: 12, color: fog[300] }}>
                No matches
              </Typography>
            )}
          </Box>

          {/* --------------------------------------------------- content */}
          <Box ref={content} sx={{ flex: 1, overflowY: "auto", px: 4, py: 3 }}>
            {searching ? (
              <Typography sx={{ fontSize: 13, color: fog[300], mb: 3 }}>
                {hits} {hits === 1 ? "setting" : "settings"} found
              </Typography>
            ) : (
              commonSettings.length > 0 && (
                <Box sx={{ mb: 5 }}>
                  <Typography
                    id="sec-common"
                    sx={{ fontSize: 21, fontWeight: 600, mb: 3, pl: 2, scrollMarginTop: 12 }}
                  >
                    Commonly Used
                  </Typography>
                  <Stack spacing={3}>
                    {commonSettings.map(({ section, setting }) => (
                      <SettingRow
                        key={`${section.id}.${setting.id}`}
                        setting={setting}
                        anchor={`common-${section.id}-${setting.id}`}
                      />
                    ))}
                  </Stack>
                </Box>
              )
            )}

            {visible.map((section) => {
              const rows = filterSettings(section, query);
              if (searching && rows.length === 0 && !section.extra) return null;
              return (
                <Box key={section.id} sx={{ mb: 5 }}>
                  <Typography
                    id={`sec-${section.id}`}
                    sx={{ fontSize: 21, fontWeight: 600, pl: 2, scrollMarginTop: 12 }}
                  >
                    {section.title}
                  </Typography>
                  {section.blurb && (
                    <Typography
                      sx={{ fontSize: 12.5, color: fog[300], mt: 0.5, pl: 2, maxWidth: 720 }}
                    >
                      {section.blurb}
                    </Typography>
                  )}

                  <Stack spacing={3} sx={{ mt: 3 }}>
                    {rows.map((setting) => (
                      <SettingRow
                        key={setting.id}
                        setting={setting}
                        anchor={`set-${section.id}-${setting.id}`}
                      />
                    ))}
                    {section.extra}
                  </Stack>
                </Box>
              );
            })}

            {scope === "project" && error && (
              <Alert severity="error" sx={{ fontSize: 12.5, mb: 2 }}>
                {error}
              </Alert>
            )}
            {scope === "project" && notice && (
              <Alert severity="success" sx={{ fontSize: 12.5, mb: 2 }}>
                {notice}
              </Alert>
            )}
            {scope === "global" && global.error && (
              <Alert severity="error" sx={{ fontSize: 12.5, mb: 2 }}>
                {global.error}
              </Alert>
            )}
          </Box>
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 2, py: 1.5, borderTop: `1px solid ${ink[600]}` }}>
        <Typography sx={{ fontSize: 11.5, color: fog[300], flex: 1 }}>
          {dirty
            ? "Unsaved changes"
            : scope === "global" && global.notice
              ? global.notice
              : ""}
        </Typography>
        <Button size="small" color="inherit" onClick={() => onClose(null)}>
          Close
        </Button>
        {scope === "project" ? (
          <Button
            size="small"
            variant="contained"
            disabled={busy || !form.name?.trim()}
            onClick={async () => {
              const saved = await save();
              if (saved) onClose(saved);
            }}
          >
            {project ? "Save project" : "Create project"}
          </Button>
        ) : (
          <Button
            size="small"
            variant="contained"
            disabled={!global.dirty || global.saving}
            onClick={() => void global.save()}
          >
            {global.saving ? "Saving…" : "Save"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
