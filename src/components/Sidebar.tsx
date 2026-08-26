import { useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Select,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import TagRoundedIcon from "@mui/icons-material/TagRounded";
import LogoutRoundedIcon from "@mui/icons-material/LogoutRounded";
import { pb, logout } from "../lib/pb";
import { useApp } from "../store";
import ChannelDialog from "./ChannelDialog";
import SettingsDialog from "./SettingsDialog";
import { ink, fog, accent } from "../theme";
import type { Agent, Channel, Project } from "../lib/types";

interface Props {
  projects: Project[];
  onReload: () => void;
  onEditAgent: (agent: Agent | null) => void;
}

/**
 * Project switcher, channel list, agent roster.
 *
 * Channels are the unit of context: each one owns a lane. Double-click a
 * channel to open its settings — agents, description, project.
 */
export default function Sidebar({ projects, onReload, onEditAgent }: Props) {
  const { project, channel, channels, agents, setProject, setChannel } = useApp();
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [draft, setDraft] = useState("");
  const [settingsFor, setSettingsFor] = useState<Channel | null>(null);
  // `undefined` = closed, `null` = creating, a project = editing it.
  const [projectPanel, setProjectPanel] = useState<Project | null | undefined>(
    undefined,
  );

  async function createChannel(name: string) {
    if (!project) return;
    const lane = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const created = await pb.collection("channels").create<Channel>({
      project: project.id,
      name,
      lane,
      kind: "chat",
      agents: [],
    });
    setChannel(created);
    onReload();
    // Straight into settings: a channel with no agents cannot answer.
    setSettingsFor(created);
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-ink-700 bg-ink-800">
      <Box sx={{ p: 1.5, borderBottom: `1px solid ${ink[600]}` }}>
        {/* Google-style switcher: filled tonal surface, no hard outline. */}
        <Select
          fullWidth
          size="small"
          displayEmpty
          value={projects.some((p) => p.id === project?.id) ? project!.id : ""}
          onChange={(e) => {
            const next = projects.find((p) => p.id === e.target.value) ?? null;
            setProject(next);
            setChannel(null);
          }}
          IconComponent={ExpandMoreRoundedIcon}
          renderValue={(value) => (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
              <FolderRoundedIcon
                sx={{
                  fontSize: 16,
                  color:
                    projects.find((p) => p.id === value)?.color || accent,
                }}
              />
              <Box
                sx={{
                  fontSize: 13,
                  fontWeight: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {projects.find((p) => p.id === value)?.name ?? "No project"}
              </Box>
            </Box>
          )}
          sx={{
            borderRadius: "14px",
            backgroundColor: ink[700],
            transition: "background-color .15s ease",
            "&:hover": { backgroundColor: ink[600] },
            "& .MuiOutlinedInput-notchedOutline": { border: "none" },
            "&.Mui-focused": { backgroundColor: ink[600] },
            "& .MuiSelect-select": { py: 1.1 },
          }}
          MenuProps={{
            slotProps: {
              paper: { sx: { mt: 0.5, borderRadius: "14px", minWidth: 232 } },
            },
          }}
        >
          {projects.map((p) => (
            <MenuItem key={p.id} value={p.id} sx={{ fontSize: 13, borderRadius: "8px", mx: 0.5 }}>
              <FolderRoundedIcon
                sx={{ fontSize: 16, mr: 1, color: p.color || fog[300] }}
              />
              {p.name}
            </MenuItem>
          ))}
          {projects.length === 0 && (
            <MenuItem value="" disabled sx={{ fontSize: 13 }}>
              No projects yet
            </MenuItem>
          )}
        </Select>

        <Button
          fullWidth
          size="small"
          startIcon={<AddRoundedIcon sx={{ fontSize: 16 }} />}
          onClick={() => setProjectPanel(null)}
          sx={{
            mt: 1,
            color: fog[300],
            fontSize: 12,
            borderRadius: "12px",
            "&:hover": { backgroundColor: ink[700], color: fog[100] },
          }}
        >
          New project
        </Button>

        {/* Both states open project settings — the warning has to be fixable. */}
        {project?.root_path ? (
          <Tooltip title={`${project.root_path} — click for project settings`}>
            <Typography
              onClick={() => setProjectPanel(project)}
              sx={{
                mt: 1,
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: fog[300],
                cursor: "pointer",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                "&:hover": { color: fog[100] },
              }}
            >
              {project.root_path}
            </Typography>
          </Tooltip>
        ) : (
          project && (
            <Typography
              onClick={() => setProjectPanel(project)}
              sx={{
                mt: 1,
                fontSize: 10,
                color: "#e0a44a",
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              no working folder set — click to configure
            </Typography>
          )
        )}
      </Box>

      <Section
        title="Channels"
        hint="double-click to configure"
        onAdd={() => {
          setCreatingChannel(true);
          setDraft("");
        }}
      >
        {channels.map((c) => (
          <button
            key={c.id}
            onClick={() => setChannel(c)}
            onDoubleClick={() => setSettingsFor(c)}
            title={c.topic || "double-click for settings"}
            className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-sm ${
              channel?.id === c.id
                ? "bg-accent-soft text-fog-100"
                : "text-fog-300 hover:bg-ink-700"
            }`}
          >
            <TagRoundedIcon sx={{ fontSize: 13, opacity: 0.6 }} />
            <span className="truncate">{c.name}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-fog-300">
              {c.agents?.length ?? 0}
            </span>
          </button>
        ))}
      </Section>

      <Section title="Agents" onAdd={() => onEditAgent(null)}>
        {agents.map((a) => (
          <button
            key={a.id}
            onClick={() => onEditAgent(a)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-fog-300 hover:bg-ink-700"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: a.avatar_color || "#7c5cff" }}
            />
            <span className="truncate">{a.name}</span>
            {channel?.agents?.includes(a.id) && (
              <span className="ml-auto text-[10px] text-ok">on</span>
            )}
          </button>
        ))}
      </Section>

      <Box sx={{ mt: "auto", p: 1.5, borderTop: `1px solid ${ink[600]}` }}>
        <Button
          size="small"
          startIcon={<LogoutRoundedIcon sx={{ fontSize: 15 }} />}
          onClick={() => {
            logout();
            location.reload();
          }}
          sx={{ color: fog[300], fontSize: 11, borderRadius: "10px" }}
        >
          Sign out
        </Button>
      </Box>

      <Dialog
        open={creatingChannel}
        onClose={() => setCreatingChannel(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>New channel</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Name"
            sx={{ mt: 1 }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key !== "Enter" || !draft.trim()) return;
              const value = draft.trim();
              setCreatingChannel(false);
              await createChannel(value);
            }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button size="small" color="inherit" onClick={() => setCreatingChannel(false)}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={!draft.trim()}
            onClick={async () => {
              const value = draft.trim();
              setCreatingChannel(false);
              await createChannel(value);
            }}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {projectPanel !== undefined && (
        <SettingsDialog
          project={projectPanel}
          onClose={(saved) => {
            const wasCreating = projectPanel === null;
            setProjectPanel(undefined);
            if (saved) {
              setProject(saved);
              if (wasCreating) setChannel(null);
            }
            onReload();
          }}
        />
      )}

      {settingsFor && (
        <ChannelDialog
          channel={settingsFor}
          projects={projects}
          onClose={(changed) => {
            setSettingsFor(null);
            if (changed) onReload();
          }}
        />
      )}
    </aside>
  );
}

function Section({
  title,
  hint,
  onAdd,
  children,
}: {
  title: string;
  hint?: string;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ p: 1, borderBottom: `1px solid ${ink[600]}` }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: 0.5,
          mb: 0.5,
        }}
      >
        <Tooltip title={hint ?? ""} placement="right">
          <Typography
            sx={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: fog[300],
            }}
          >
            {title}
          </Typography>
        </Tooltip>
        <Button
          onClick={onAdd}
          sx={{
            minWidth: 24,
            width: 24,
            height: 24,
            p: 0,
            borderRadius: "8px",
            color: fog[300],
            "&:hover": { backgroundColor: ink[700], color: fog[100] },
          }}
        >
          <AddRoundedIcon sx={{ fontSize: 15 }} />
        </Button>
      </Box>
      <Box sx={{ maxHeight: 224, overflowY: "auto", "& > * + *": { mt: "2px" } }}>
        {children}
      </Box>
    </Box>
  );
}
