import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  ListItemText,
  MenuItem,
  OutlinedInput,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { pb } from "../lib/pb";
import { ink, fog } from "../theme";
import type { Agent, Channel, Project } from "../lib/types";

/**
 * Channel settings, opened by double-clicking a channel in the sidebar.
 *
 * Covers the three things that make a channel useful: who answers in it (its
 * agents), what it is for (description + lane), and which project it belongs
 * to. Moving a channel to another project clears its agent list, because
 * agents are owned by a project and cannot answer outside it.
 */
export default function ChannelDialog({
  channel,
  projects,
  onClose,
}: {
  channel: Channel;
  projects: Project[];
  onClose: (changed: boolean) => void;
}) {
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [lane, setLane] = useState(channel.lane);
  const [kind, setKind] = useState<Channel["kind"]>(channel.kind || "chat");
  const [projectId, setProjectId] = useState(channel.project);
  const [selected, setSelected] = useState<string[]>(channel.agents ?? []);
  const [roster, setRoster] = useState<Agent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The roster follows the selected project, not the channel's original one.
  useEffect(() => {
    let alive = true;
    void pb
      .collection("agents")
      .getFullList<Agent>({ filter: `project = "${projectId}"`, sort: "name" })
      .then((rows) => {
        if (!alive) return;
        setRoster(rows);
        if (projectId !== channel.project) setSelected([]);
      });
    return () => {
      alive = false;
    };
  }, [projectId, channel.project]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await pb.collection("channels").update(channel.id, {
        name: name.trim(),
        topic: topic.trim(),
        lane: (lane.trim() || name.trim()).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        kind,
        project: projectId,
        agents: selected,
      });
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await pb.collection("channels").delete(channel.id);
      onClose(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open fullWidth maxWidth="sm" onClose={() => onClose(false)}>
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>
        #{channel.name}
        <Typography sx={{ fontSize: 11, color: fog[300] }}>
          Who answers here, what it is for, and where it lives.
        </Typography>
      </DialogTitle>

      <DialogContent dividers sx={{ borderColor: ink[600] }}>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <Stack direction="row" spacing={2}>
            <TextField
              label="Name"
              size="small"
              fullWidth
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <TextField
              label="Context lane"
              size="small"
              fullWidth
              value={lane}
              onChange={(e) => setLane(e.target.value)}
              helperText="Memory bucket this channel reads and writes"
            />
          </Stack>

          <TextField
            label="Description"
            size="small"
            fullWidth
            multiline
            minRows={3}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What this channel is for. Shown in the header and used to brief the agents."
          />

          <Stack direction="row" spacing={2}>
            <FormControl size="small" fullWidth>
              <InputLabel>Project</InputLabel>
              <Select
                label="Project"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {projects.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" fullWidth>
              <InputLabel>Kind</InputLabel>
              <Select
                label="Kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as Channel["kind"])}
              >
                {["chat", "standup", "review", "terminal"].map((k) => (
                  <MenuItem key={k} value={k}>
                    {k}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>

          <FormControl size="small" fullWidth>
            <InputLabel>Agents in this channel</InputLabel>
            <Select
              multiple
              label="Agents in this channel"
              value={selected}
              onChange={(e) =>
                setSelected(
                  typeof e.target.value === "string"
                    ? e.target.value.split(",")
                    : e.target.value,
                )
              }
              input={<OutlinedInput label="Agents in this channel" />}
              renderValue={(ids) => (
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                  {ids.map((id) => {
                    const agent = roster.find((a) => a.id === id);
                    return (
                      <Chip
                        key={id}
                        size="small"
                        label={agent?.name ?? id}
                        sx={{
                          bgcolor: ink[600],
                          "& .MuiChip-label": { fontSize: 11 },
                          borderLeft: `3px solid ${agent?.avatar_color ?? "#7c5cff"}`,
                        }}
                      />
                    );
                  })}
                </Box>
              )}
            >
              {roster.map((agent) => (
                <MenuItem key={agent.id} value={agent.id}>
                  <Checkbox
                    size="small"
                    checked={selected.includes(agent.id)}
                    sx={{ p: 0.5, mr: 1 }}
                  />
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      mr: 1,
                      background: agent.avatar_color || "#7c5cff",
                    }}
                  />
                  <ListItemText
                    primary={agent.name}
                    secondary={agent.role}
                    slotProps={{
                      primary: { sx: { fontSize: 13 } },
                      secondary: { sx: { fontSize: 11, color: fog[300] } },
                    }}
                  />
                </MenuItem>
              ))}
              {roster.length === 0 && (
                <MenuItem disabled>
                  <ListItemText primary="No agents in this project yet" />
                </MenuItem>
              )}
            </Select>
          </FormControl>

          {error && (
            <Typography sx={{ fontSize: 12, color: "#e2585f" }}>{error}</Typography>
          )}
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button color="error" size="small" onClick={() => void remove()} disabled={busy}>
          Delete
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button size="small" color="inherit" onClick={() => onClose(false)}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          onClick={() => void save()}
          disabled={busy || !name.trim()}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
