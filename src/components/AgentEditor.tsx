import { useState } from "react";
import {
  Box,
  Button,
  Drawer,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { pb } from "../lib/pb";
import { useApp } from "../store";
import { ink, fog } from "../theme";
import type { Agent } from "../lib/types";

const MODELS = ["", "fable", "opus", "sonnet", "haiku"];
const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"];
const MODES = ["", "manual", "acceptEdits", "auto", "plan", "bypassPermissions"];
const COLORS = ["#7c5cff", "#3fbf7f", "#e0a44a", "#e2585f", "#4aa8e0", "#c86ee0"];

/**
 * Per-agent profile.
 *
 * Everything here maps onto a Claude Code flag or onto the context layer:
 * instructions become `--append-system-prompt`, lanes decide which memory the
 * agent may read, and the budget caps what a single turn can cost.
 */
export default function AgentEditor({
  agent,
  onClose,
}: {
  agent: Agent | null;
  onClose: () => void;
}) {
  const { project, channel } = useApp();
  const [form, setForm] = useState<Partial<Agent>>(
    agent ?? {
      name: "",
      role: "",
      instructions: "",
      model: "sonnet",
      effort: "medium",
      permission_mode: "acceptEdits",
      avatar_color: COLORS[0],
      lanes: [],
      allowed_tools: [],
      disallowed_tools: [],
      add_dirs: [],
      context_budget: 3000,
      enabled: true,
      bare: false,
      verbose_output: false,
      chrome: false,
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = <K extends keyof Agent>(key: K, value: Agent[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const list = (value: string) =>
    value.split(",").map((s) => s.trim()).filter(Boolean);

  async function save() {
    if (!project || !form.name?.trim()) return;
    setBusy(true);
    setError("");
    try {
      const payload = { ...form, project: project.id };
      const saved = agent
        ? await pb.collection("agents").update<Agent>(agent.id, payload)
        : await pb.collection("agents").create<Agent>(payload);

      // A brand new agent joins the channel it was created from, otherwise it
      // exists but never speaks.
      if (!agent && channel && !channel.agents?.includes(saved.id)) {
        await pb.collection("channels").update(channel.id, {
          agents: [...(channel.agents ?? []), saved.id],
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleChannelMembership() {
    if (!agent || !channel) return;
    const on = channel.agents?.includes(agent.id);
    await pb.collection("channels").update(channel.id, {
      agents: on
        ? (channel.agents ?? []).filter((id) => id !== agent.id)
        : [...(channel.agents ?? []), agent.id],
    });
    onClose();
  }

  async function remove() {
    if (!agent) return;
    await pb.collection("agents").delete(agent.id);
    onClose();
  }

  return (
    <Drawer
      anchor="right"
      open
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: 470,
            backgroundColor: ink[800],
            borderLeft: `1px solid ${ink[600]}`,
            backgroundImage: "none",
          },
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          px: 2,
          py: 1.5,
          borderBottom: `1px solid ${ink[600]}`,
        }}
      >
        <Typography sx={{ fontSize: 14, fontWeight: 600, flex: 1 }}>
          {agent ? `Agent · ${agent.name}` : "New agent"}
        </Typography>
        <IconButton size="small" onClick={onClose}>
          <CloseRoundedIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      <Stack spacing={2.5} sx={{ flex: 1, overflowY: "auto", p: 2 }}>
        <TextField
          label="Name"
          size="small"
          fullWidth
          value={form.name ?? ""}
          onChange={(e) => set("name", e.target.value)}
          placeholder="backend"
        />

        <TextField
          label="Role"
          size="small"
          fullWidth
          value={form.role ?? ""}
          onChange={(e) => set("role", e.target.value)}
          placeholder="owns the API and migrations"
        />

        <TextField
          label="Instructions"
          size="small"
          fullWidth
          multiline
          minRows={7}
          value={form.instructions ?? ""}
          onChange={(e) => set("instructions", e.target.value)}
          helperText="Sent as --append-system-prompt on every turn"
          placeholder="You own the Rust backend. Prefer small diffs. Never touch the UI."
        />

        <Stack direction="row" spacing={1.5}>
          <FormControl size="small" fullWidth>
            <InputLabel>Model</InputLabel>
            <Select
              label="Model"
              value={form.model ?? ""}
              onChange={(e) => set("model", e.target.value)}
            >
              {MODELS.map((m) => (
                <MenuItem key={m} value={m}>
                  {m || "project default"}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl size="small" fullWidth>
            <InputLabel>Effort</InputLabel>
            <Select
              label="Effort"
              value={form.effort ?? ""}
              onChange={(e) => set("effort", e.target.value as Agent["effort"])}
            >
              {EFFORTS.map((m) => (
                <MenuItem key={m} value={m}>
                  {m || "default"}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Stack>

        <FormControl size="small" fullWidth>
          <InputLabel>Permission mode</InputLabel>
          <Select
            label="Permission mode"
            value={form.permission_mode ?? ""}
            onChange={(e) =>
              set("permission_mode", e.target.value as Agent["permission_mode"])
            }
          >
            {MODES.map((m) => (
              <MenuItem key={m} value={m}>
                {m || "default"}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <TextField
          label="Extra context lanes"
          size="small"
          fullWidth
          value={(form.lanes ?? []).join(", ")}
          onChange={(e) => set("lanes", list(e.target.value))}
          helperText="Comma separated. The channel's own lane is always readable."
          placeholder="infra, auth"
        />

        <Stack direction="row" spacing={1.5}>
          <TextField
            label="Allowed tools"
            size="small"
            fullWidth
            value={(form.allowed_tools ?? []).join(", ")}
            onChange={(e) => set("allowed_tools", list(e.target.value))}
            placeholder="Read, Grep, Bash(git *)"
          />
          <TextField
            label="Denied tools"
            size="small"
            fullWidth
            value={(form.disallowed_tools ?? []).join(", ")}
            onChange={(e) => set("disallowed_tools", list(e.target.value))}
            placeholder="WebFetch"
          />
        </Stack>

        <TextField
          label="Context budget (tokens per turn)"
          size="small"
          type="number"
          fullWidth
          value={form.context_budget ?? 3000}
          onChange={(e) => set("context_budget", Number(e.target.value))}
        />

        <Stack direction="row" sx={{ flexWrap: "wrap" }}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={form.enabled ?? true}
                onChange={(e) => set("enabled", e.target.checked)}
              />
            }
            label={<Typography sx={{ fontSize: 12 }}>enabled</Typography>}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={form.bare ?? false}
                onChange={(e) => set("bare", e.target.checked)}
              />
            }
            label={<Typography sx={{ fontSize: 12 }}>bare</Typography>}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={form.verbose_output ?? false}
                onChange={(e) => set("verbose_output", e.target.checked)}
              />
            }
            label={<Typography sx={{ fontSize: 12 }}>verbose output</Typography>}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={form.chrome ?? false}
                onChange={(e) => set("chrome", e.target.checked)}
              />
            }
            label={
              <Tooltip title="Lets this agent drive your browser (--chrome). Requires the Claude in Chrome extension.">
                <Typography sx={{ fontSize: 12 }}>Claude in Chrome</Typography>
              </Tooltip>
            }
          />
        </Stack>

        <Box>
          <Typography sx={{ fontSize: 10, textTransform: "uppercase", color: fog[300], mb: 1 }}>
            Colour
          </Typography>
          <Stack direction="row" spacing={1}>
            {COLORS.map((c) => (
              <Box
                key={c}
                onClick={() => set("avatar_color", c)}
                sx={{
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  cursor: "pointer",
                  background: c,
                  outline: form.avatar_color === c ? `2px solid ${fog[100]}` : "none",
                  outlineOffset: 2,
                }}
              />
            ))}
          </Stack>
        </Box>

        {error && <Typography sx={{ fontSize: 12, color: "error.main" }}>{error}</Typography>}
      </Stack>

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          p: 1.5,
          borderTop: `1px solid ${ink[600]}`,
        }}
      >
        {agent && channel && (
          <Button size="small" variant="outlined" color="inherit" onClick={() => void toggleChannelMembership()}>
            {channel.agents?.includes(agent.id)
              ? `remove from #${channel.name}`
              : `add to #${channel.name}`}
          </Button>
        )}
        {agent && (
          <Button size="small" color="error" onClick={() => void remove()}>
            delete
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button size="small" variant="contained" onClick={() => void save()} disabled={busy}>
          Save
        </Button>
      </Box>
    </Drawer>
  );
}
