import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Switch,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import TerminalRoundedIcon from "@mui/icons-material/TerminalRounded";
import TagRoundedIcon from "@mui/icons-material/TagRounded";
import { pb } from "../lib/pb";
import { useApp } from "../store";
import {
  applyPlan,
  askArchitect,
  ensureArchitect,
  noteApplied,
  parsePlan,
  stripPlan,
  type ArchitectPlan,
} from "../lib/architect";
import { ink, fog } from "../theme";
import type { Agent, Channel, Message, Project } from "../lib/types";

const AUTO_APPLY_KEY = "ais-teams.architect-autoapply";

/**
 * The master agent's room.
 *
 * A goal goes in, questions come back, and the answers turn into a team. The
 * conversation is stored like any other channel, so closing this dialog loses
 * nothing — reopening it resumes the same Claude session with the same lane of
 * memory behind it.
 *
 * Messages are re-fetched rather than subscribed to: App already owns the one
 * `messages` subscription, and a second subscriber on the same topic would be
 * torn down with it on the next channel switch.
 */
export default function ArchitectDialog({
  project,
  onClose,
  onApplied,
  onRunSetup,
}: {
  project: Project | null;
  onClose: () => void;
  onApplied: () => void;
  /** Hands a plan's setup commands to the terminal pane. */
  onRunSetup: (commands: string[]) => void;
}) {
  const drafts = useApp((s) => s.drafts);
  const hostCanRun = useApp((s) => s.hostCanRun);
  const agents = useApp((s) => s.agents);
  const channels = useApp((s) => s.channels);

  const [agent, setAgent] = useState<Agent | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [booting, setBooting] = useState(true);
  // Off by default: creating a team is a real change to the project, so the
  // first one is always approved by hand. Once a user trusts it, this turns
  // "propose then click" into "say it and it exists".
  const [autoApply, setAutoApply] = useState(
    () => localStorage.getItem(AUTO_APPLY_KEY) === "1",
  );
  const endRef = useRef<HTMLDivElement | null>(null);
  // Read inside the polling effect, which must not restart when these change.
  const autoRef = useRef({ autoApply, applying: false });
  autoRef.current.autoApply = autoApply;
  autoRef.current.applying = applying;

  const reload = useCallback(async (channelId: string) => {
    const rows = await pb.collection("messages").getFullList<Message>({
      filter: `channel = "${channelId}"`,
      sort: "created",
    });
    setMessages(rows);
    return rows;
  }, []);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    void (async () => {
      try {
        const { agent: a, channel: c } = await ensureArchitect(project);
        if (cancelled) return;
        setAgent(a);
        setChannel(c);
        await reload(c.id);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.id, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  // A turn is done when its message row stops being pending/streaming. Polling
  // covers both paths: a local run (fast, driven by Tauri events) and one
  // queued for another device, where nothing local fires at all.
  useEffect(() => {
    if (!runId || !channel) return;
    const timer = setInterval(() => {
      void reload(channel.id).then((rows) => {
        const row = rows.find((m) => m.run_id === runId);
        if (!row || row.status === "pending" || row.status === "streaming") return;
        setRunId(null);

        // Auto-apply only the plan this very turn produced — never one already
        // sitting in the history from an earlier session.
        const plan = row.status === "done" ? parsePlan(row.body) : null;
        if (plan && autoRef.current.autoApply && !autoRef.current.applying) {
          void apply(plan, row.id);
        }
      });
    }, 1200);
    return () => clearInterval(timer);
  }, [runId, channel?.id, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, drafts, booting]);

  const draft = runId ? drafts[runId] : undefined;
  const busy = Boolean(runId);

  async function send() {
    const body = text.trim();
    if (!body || !project || !agent || !channel || busy) return;
    setText("");
    setError("");
    try {
      const id = await askArchitect({
        project,
        channel,
        agent,
        agents,
        channels,
        text: body,
      });
      setRunId(id);
      await reload(channel.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function apply(plan: ArchitectPlan, messageId: string) {
    if (!project || !channel || applying) return;
    setApplying(true);
    setError("");
    try {
      const result = await applyPlan(project, plan);
      await noteApplied(project, channel, result);
      setApplied((prev) => [...prev, messageId]);
      await reload(channel.id);
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  // Only the newest plan is actionable — an older one describes a team that has
  // since moved on.
  const latestPlanId = [...messages]
    .reverse()
    .find((m) => m.author_type === "agent" && parsePlan(m.body))?.id;

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          fontSize: 15,
          fontWeight: 600,
        }}
      >
        <AutoAwesomeRoundedIcon sx={{ fontSize: 18, color: "primary.main" }} />
        Architect
        <Typography sx={{ fontSize: 11, color: fog[300], ml: 0.5 }}>
          master agent · builds your team
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Create the team as soon as the architect proposes it, without asking">
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={autoApply}
                onChange={(e) => {
                  setAutoApply(e.target.checked);
                  localStorage.setItem(AUTO_APPLY_KEY, e.target.checked ? "1" : "0");
                }}
              />
            }
            label="auto-apply"
            slotProps={{ typography: { sx: { fontSize: 11, color: fog[300] } } }}
            sx={{ mr: 0.5 }}
          />
        </Tooltip>
        <IconButton size="small" onClick={onClose}>
          <CloseRoundedIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ borderColor: ink[600], p: 0 }}>
        {!project ? (
          <Empty text="Create or select a project first — the architect builds inside one." />
        ) : booting ? (
          <Empty text="Waking the architect…" />
        ) : (
          <Box
            sx={{
              height: 460,
              overflowY: "auto",
              p: 2,
              display: "flex",
              flexDirection: "column",
              gap: 1.5,
            }}
          >
            {!messages.length && <Intro />}

            {messages.map((message) => (
              <Turn
                key={message.id}
                message={message}
                actionable={message.id === latestPlanId}
                applied={applied.includes(message.id)}
                applying={applying}
                onApply={(plan) => void apply(plan, message.id)}
                onRunSetup={(commands) => {
                  onRunSetup(commands);
                  onClose();
                }}
              />
            ))}

            {draft && (
              <Bubble author="Architect" mine={false}>
                <span className="caret">{stripPlan(draft.text)}</span>
              </Bubble>
            )}

            {busy && !draft && (
              <Typography sx={{ fontSize: 11, color: fog[300] }}>
                {hostCanRun
                  ? "thinking…"
                  : "queued — a desktop running the CLI will pick this up"}
              </Typography>
            )}

            <div ref={endRef} />
          </Box>
        )}

        {error && (
          <Typography sx={{ fontSize: 12, color: "error.main", px: 2, pb: 1 }}>
            {error}
          </Typography>
        )}

        <Box
          sx={{
            display: "flex",
            gap: 1,
            p: 1.5,
            borderTop: `1px solid ${ink[600]}`,
          }}
        >
          <TextField
            fullWidth
            multiline
            maxRows={5}
            size="small"
            autoFocus
            disabled={!project || booting}
            placeholder="Describe the goal — “build a marketing site for a coffee brand”"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Tooltip title={busy ? "Waiting for the current turn" : "Send"}>
            <span>
              <IconButton
                color="primary"
                disabled={busy || !text.trim() || !project}
                onClick={() => void send()}
              >
                {busy ? (
                  <CircularProgress size={16} />
                ) : (
                  <SendRoundedIcon sx={{ fontSize: 18 }} />
                )}
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </DialogContent>
    </Dialog>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <Box sx={{ height: 460, display: "grid", placeItems: "center", p: 3 }}>
      <Typography sx={{ fontSize: 12, color: fog[300], textAlign: "center" }}>
        {text}
      </Typography>
    </Box>
  );
}

function Intro() {
  return (
    <Box
      sx={{
        border: `1px solid ${ink[600]}`,
        backgroundColor: ink[700],
        borderRadius: "12px",
        p: 2,
      }}
    >
      <Typography sx={{ fontSize: 12, mb: 0.5, fontWeight: 600 }}>
        Give the architect a goal.
      </Typography>
      <Typography sx={{ fontSize: 12, color: fog[300] }}>
        It asks what it needs — stack, style, scope — then proposes a team:
        agents with real missions, channels wired to context lanes, goals. You
        approve the plan before anything is created, and you can come back later
        to change it; it keeps the whole conversation.
      </Typography>
    </Box>
  );
}

function Turn({
  message,
  actionable,
  applied,
  applying,
  onApply,
  onRunSetup,
}: {
  message: Message;
  actionable: boolean;
  applied: boolean;
  applying: boolean;
  onApply: (plan: ArchitectPlan) => void;
  onRunSetup: (commands: string[]) => void;
}) {
  const plan = message.author_type === "agent" ? parsePlan(message.body) : null;
  const body = plan ? stripPlan(message.body) : message.body;

  if (message.author_type === "system") {
    return (
      <Typography
        sx={{ fontSize: 11, color: fog[300], textAlign: "center", py: 0.5 }}
      >
        {message.body}
      </Typography>
    );
  }

  return (
    <>
      {body && (
        <Bubble author={message.author_type === "user" ? "You" : "Architect"} mine={message.author_type === "user"}>
          {body}
        </Bubble>
      )}
      {message.status === "error" && (
        <Typography sx={{ fontSize: 11, color: "error.main" }}>
          {message.error || "the run failed"}
        </Typography>
      )}
      {plan && (
        <PlanCard
          plan={plan}
          actionable={actionable}
          applied={applied}
          applying={applying}
          onApply={() => onApply(plan)}
          onRunSetup={onRunSetup}
        />
      )}
    </>
  );
}

function Bubble({
  author,
  mine,
  children,
}: {
  author: string;
  mine: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "85%" }}>
      <Typography sx={{ fontSize: 10, color: fog[300], mb: 0.25 }}>
        {author}
      </Typography>
      <Box
        sx={{
          px: 1.5,
          py: 1,
          borderRadius: "12px",
          backgroundColor: mine ? ink[700] : ink[800],
          border: mine ? "none" : `1px solid ${ink[600]}`,
          fontSize: 13,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

/** The machine-readable half of a reply, shown as something you can approve. */
function PlanCard({
  plan,
  actionable,
  applied,
  applying,
  onApply,
  onRunSetup,
}: {
  plan: ArchitectPlan;
  actionable: boolean;
  applied: boolean;
  applying: boolean;
  onApply: () => void;
  onRunSetup: (commands: string[]) => void;
}) {
  return (
    <Box
      sx={{
        border: `1px solid ${ink[600]}`,
        borderRadius: "12px",
        backgroundColor: ink[800],
        p: 1.75,
        alignSelf: "stretch",
      }}
    >
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, mb: 1 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 600 }}>
          Proposed team
        </Typography>
        {plan.summary && (
          <Typography sx={{ fontSize: 11, color: fog[300] }}>
            {plan.summary}
          </Typography>
        )}
      </Stack>

      {!!plan.agents?.length && (
        <Stack spacing={0.75} sx={{ mb: 1.25 }}>
          {plan.agents.map((a) => (
            <Box key={a.name} sx={{ display: "flex", gap: 1 }}>
              <Box
                sx={{
                  mt: "6px",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flexShrink: 0,
                  backgroundColor: a.avatar_color || "#7c5cff",
                }}
              />
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: 12 }}>
                  {a.name}
                  {a.role ? ` · ${a.role}` : ""}
                  <Typography
                    component="span"
                    sx={{ fontSize: 10, color: fog[300], ml: 0.75 }}
                  >
                    {a.model || "sonnet"}
                  </Typography>
                </Typography>
                <Typography sx={{ fontSize: 11, color: fog[300] }}>
                  {(a.mission ?? a.instructions ?? "").slice(0, 260)}
                </Typography>
              </Box>
            </Box>
          ))}
        </Stack>
      )}

      {!!plan.channels?.length && (
        <Stack direction="row" sx={{ flexWrap: "wrap", gap: 0.5, mb: 1 }}>
          {plan.channels.map((c) => (
            <Chip
              key={c.name}
              size="small"
              icon={<TagRoundedIcon sx={{ fontSize: 12 }} />}
              label={`${c.name}${c.agents?.length ? ` · ${c.agents.join(", ")}` : ""}`}
              sx={{ bgcolor: ink[700], height: 20, "& .MuiChip-label": { fontSize: 10 } }}
            />
          ))}
        </Stack>
      )}

      {!!plan.goals?.length && (
        <Typography sx={{ fontSize: 11, color: fog[300], mb: 1 }}>
          goals: {plan.goals.map((g) => g.title).join(" · ")}
        </Typography>
      )}

      {!!plan.setup?.commands?.length && (
        <Box
          sx={{
            border: `1px solid ${ink[600]}`,
            borderRadius: "8px",
            p: 1,
            mb: 1,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: fog[300],
            whiteSpace: "pre-wrap",
          }}
        >
          {plan.setup.commands.join("\n")}
        </Box>
      )}

      <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <Button
          size="small"
          variant="contained"
          disabled={!actionable || applied || applying}
          onClick={onApply}
        >
          {applied ? "Applied" : applying ? "Applying…" : "Apply plan"}
        </Button>
        {!!plan.setup?.commands?.length && (
          <Button
            size="small"
            startIcon={<TerminalRoundedIcon sx={{ fontSize: 14 }} />}
            onClick={() => onRunSetup(plan.setup?.commands ?? [])}
            sx={{ fontSize: 11 }}
          >
            Run setup
          </Button>
        )}
        <Typography sx={{ fontSize: 10, color: fog[300] }}>
          {applied
            ? "agents and channels are live in this project"
            : actionable
              ? "creates agents and channels; existing ones are updated, never deleted"
              : "superseded by a newer plan"}
        </Typography>
      </Stack>
    </Box>
  );
}
