import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import FolderOpenRoundedIcon from "@mui/icons-material/FolderOpenRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import { pb, currentUserId } from "../lib/pb";
import { isTauri, pickFolder, scanAgentFiles } from "../lib/bridge";
import { ink, fog } from "../theme";
import type { Agent, AgentFile, Project } from "../lib/types";

const MODELS = ["fable", "opus", "sonnet", "haiku"];
const COLORS = ["#7c5cff", "#3fbf7f", "#e0a44a", "#e2585f", "#4aa8e0", "#c86ee0"];

const slugify = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Everything a project owns, in one panel: identity, where its code lives,
 * the standing brief its agents inherit, and the folder of agent `.md` files
 * it can import from.
 *
 * Opened for a new project from the sidebar, or for the current one from the
 * Settings gear in the title bar. Creation and editing use the same form so a
 * project is never left half-configured — the old flow asked for a name only,
 * which is why every run ended up in ".".
 */
export default function ProjectDialog({
  project,
  onClose,
}: {
  project: Project | null;
  onClose: (saved: Project | null) => void;
}) {
  const [form, setForm] = useState<Partial<Project>>(
    project ?? {
      name: "",
      description: "",
      instructions: "",
      root_path: "",
      agents_dir: "",
      color: COLORS[0],
      default_model: "sonnet",
      context_budget: 3000,
      archived: false,
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [found, setFound] = useState<AgentFile[] | null>(null);
  const [notice, setNotice] = useState("");

  const set = <K extends keyof Project>(key: K, value: Project[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

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

  return (
    <Dialog open fullWidth maxWidth="sm" onClose={() => onClose(null)}>
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>
        {project ? `Project · ${project.name}` : "New project"}
        <Typography sx={{ fontSize: 11, color: fog[300] }}>
          Identity, working folder, standing brief, agent files.
        </Typography>
      </DialogTitle>

      <DialogContent dividers sx={{ borderColor: ink[600] }}>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <Stack direction="row" spacing={2}>
            <TextField
              label="Name"
              size="small"
              fullWidth
              autoFocus
              value={form.name ?? ""}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Payments rewrite"
            />
            <Box>
              <Typography
                sx={{ fontSize: 10, textTransform: "uppercase", color: fog[300], mb: 0.5 }}
              >
                Colour
              </Typography>
              <Stack direction="row" spacing={0.75}>
                {COLORS.map((c) => (
                  <Box
                    key={c}
                    onClick={() => set("color", c)}
                    sx={{
                      width: 20,
                      height: 20,
                      borderRadius: "50%",
                      cursor: "pointer",
                      background: c,
                      outline: form.color === c ? `2px solid ${fog[100]}` : "none",
                      outlineOffset: 2,
                    }}
                  />
                ))}
              </Stack>
            </Box>
          </Stack>

          <TextField
            label="Objective"
            size="small"
            fullWidth
            value={form.description ?? ""}
            onChange={(e) => set("description", e.target.value)}
            placeholder="What this project is trying to achieve."
          />

          <TextField
            label="Project instructions"
            size="small"
            fullWidth
            multiline
            minRows={4}
            value={form.instructions ?? ""}
            onChange={(e) => set("instructions", e.target.value)}
            helperText="Inherited by every agent in this project, on every turn."
            placeholder="Conventional commits. No new dependencies without asking. Tests before merge."
          />

          <TextField
            label="Working folder (root_path)"
            size="small"
            fullWidth
            value={form.root_path ?? ""}
            onChange={(e) => set("root_path", e.target.value)}
            helperText='Working directory for every agent run. Empty means "."'
            slotProps={{
              input: {
                sx: { fontFamily: "var(--font-mono)", fontSize: 12 },
                endAdornment: isTauri() && (
                  <InputAdornment position="end">
                    <Button
                      size="small"
                      onClick={() => void browse("root_path", "Project folder")}
                      startIcon={<FolderOpenRoundedIcon sx={{ fontSize: 15 }} />}
                    >
                      Browse
                    </Button>
                  </InputAdornment>
                ),
              },
            }}
          />

          <Divider sx={{ borderColor: ink[600] }} />

          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>
              Agent files
            </Typography>
            <Typography sx={{ fontSize: 11, color: fog[300], mb: 1.5 }}>
              A folder of <code>.md</code> files, one per agent. Frontmatter
              <code> name</code>, <code>description</code>, <code>model</code>,{" "}
              <code>color</code>, <code>tools</code>; the body becomes the
              agent's instructions.
            </Typography>

            <TextField
              label="Agents folder"
              size="small"
              fullWidth
              value={form.agents_dir ?? ""}
              onChange={(e) => set("agents_dir", e.target.value)}
              slotProps={{
                input: {
                  sx: { fontFamily: "var(--font-mono)", fontSize: 12 },
                  endAdornment: isTauri() && (
                    <InputAdornment position="end">
                      <Button
                        size="small"
                        onClick={() => void browse("agents_dir", "Agents folder")}
                        startIcon={<FolderOpenRoundedIcon sx={{ fontSize: 15 }} />}
                      >
                        Browse
                      </Button>
                    </InputAdornment>
                  ),
                },
              }}
            />

            <Stack direction="row" spacing={1} sx={{ mt: 1.5, alignItems: "center" }}>
              <Button size="small" variant="outlined" color="inherit" onClick={() => void scan()}>
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

            {found && found.length > 0 && (
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mt: 1.5 }}>
                {found.map((file) => (
                  <Tooltip key={file.path} title={file.description || file.path}>
                    <Chip
                      size="small"
                      label={file.name}
                      sx={{
                        bgcolor: ink[700],
                        "& .MuiChip-label": { fontSize: 11 },
                        borderLeft: `3px solid ${file.color || "#7c5cff"}`,
                      }}
                    />
                  </Tooltip>
                ))}
              </Box>
            )}
          </Box>

          <Divider sx={{ borderColor: ink[600] }} />

          <Stack direction="row" spacing={2}>
            <FormControl size="small" fullWidth>
              <InputLabel>Default model</InputLabel>
              <Select
                label="Default model"
                value={form.default_model ?? "sonnet"}
                onChange={(e) => set("default_model", e.target.value)}
              >
                {MODELS.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="Context budget"
              size="small"
              type="number"
              fullWidth
              value={form.context_budget ?? 3000}
              onChange={(e) => set("context_budget", Number(e.target.value))}
              helperText="Tokens of memory per turn"
            />
          </Stack>

          {error && <Alert severity="error" sx={{ fontSize: 12 }}>{error}</Alert>}
          {notice && <Alert severity="success" sx={{ fontSize: 12 }}>{notice}</Alert>}
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Box sx={{ flex: 1 }} />
        <Button size="small" color="inherit" onClick={() => onClose(null)}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={busy || !form.name?.trim()}
          onClick={async () => {
            const saved = await save();
            if (saved) onClose(saved);
          }}
        >
          {project ? "Save" : "Create"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
