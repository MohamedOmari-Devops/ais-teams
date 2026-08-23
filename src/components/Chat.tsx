import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Chip, TextField, Tooltip, Typography } from "@mui/material";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import { useApp } from "../store";
import { broadcast, cancelRun, pickTargets } from "../lib/orchestrator";
import { estimateTokens } from "../lib/bridge";
import { ink, fog } from "../theme";
import type { Agent, Message } from "../lib/types";

/** A turn in this state has no bubble yet — it shows up as an avatar + dots. */
const IN_FLIGHT: Message["status"][] = ["pending", "streaming"];

/** Chat pane: transcript, typing indicator, composer, per-turn cost preview. */
export default function Chat() {
  const { project, channel, agents, messages, hostCanRun } = useApp();
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState(0);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const agentById = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.id, a])),
    [agents],
  );

  // A turn is rendered exactly once: as dots while it runs, as a bubble after.
  const settled = messages.filter((m) => !IN_FLIGHT.includes(m.status));
  const pending = messages.filter((m) => IN_FLIGHT.includes(m.status));

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [settled.length, pending.length]);

  useEffect(() => {
    let alive = true;
    void estimateTokens(text).then((n) => alive && setTokens(n));
    return () => {
      alive = false;
    };
  }, [text]);

  if (!project || !channel) {
    return (
      <Box
        sx={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          color: fog[300],
        }}
      >
        Pick a channel, or create one.
      </Box>
    );
  }

  const targets = pickTargets(agents, channel, text);

  async function send() {
    const body = text.trim();
    if (!body || sending || !project || !channel) return;
    setSending(true);
    setText("");
    try {
      await broadcast(project, channel, agents, body);
    } finally {
      setSending(false);
    }
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, height: "100%" }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          px: 2,
          py: 1.5,
          borderBottom: `1px solid ${ink[600]}`,
        }}
      >
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>#{channel.name}</Typography>
        <Chip
          size="small"
          label={`lane:${channel.lane}`}
          sx={{ bgcolor: ink[700], fontFamily: "var(--font-mono)", fontSize: 10, height: 20 }}
        />
        {channel.topic && (
          <Tooltip title={channel.topic}>
            <Typography
              sx={{
                fontSize: 12,
                color: fog[300],
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 420,
              }}
            >
              {channel.topic}
            </Typography>
          </Tooltip>
        )}
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 11, color: fog[300] }}>
          {channel.agents?.length ?? 0} agent(s)
        </Typography>
      </Box>

      <Box sx={{ flex: 1, overflowY: "auto", px: 2, py: 2, "& > * + *": { mt: 2 } }}>
        {settled.map((m) => (
          <Bubble
            key={m.id}
            message={m}
            agentName={agentById[m.author_agent]?.name}
            color={agentById[m.author_agent]?.avatar_color}
          />
        ))}

        {pending.length > 0 && <Typing pending={pending} agentById={agentById} />}
        <div ref={endRef} />
      </Box>

      <Box sx={{ borderTop: `1px solid ${ink[600]}`, p: 1.5 }}>
        {!hostCanRun && (
          <Typography sx={{ fontSize: 11, color: "warning.main", mb: 1 }}>
            No local Claude Code on this device — turns are queued for a desktop
            host to execute.
          </Typography>
        )}
        <TextField
          fullWidth
          multiline
          rows={3}
          size="small"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Message #${channel.name}   (@agent to target one)`}
        />
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mt: 1 }}>
          <Typography sx={{ fontFamily: "var(--font-mono)", fontSize: 11, color: fog[300] }}>
            ~{tokens}t in
          </Typography>
          <Typography sx={{ fontSize: 11, color: fog[300] }}>
            → {targets.length ? targets.map((a) => a.name).join(", ") : "nobody"}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            variant="contained"
            endIcon={<SendRoundedIcon sx={{ fontSize: 15 }} />}
            onClick={() => void send()}
            disabled={sending || !text.trim() || targets.length === 0}
          >
            Send
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * One row for every agent currently working, messenger style: overlapping
 * avatars, animated dots, no text. The reply appears as a bubble only once the
 * turn finishes, so a turn is never on screen twice.
 */
function Typing({
  pending,
  agentById,
}: {
  pending: Message[];
  agentById: Record<string, Agent>;
}) {
  const names = pending.map((m) => agentById[m.author_agent]?.name ?? "agent");
  const label =
    names.length === 1
      ? `${names[0]} is thinking`
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are thinking`;

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
      <Box sx={{ display: "flex" }}>
        {pending.map((m, i) => {
          const agent = agentById[m.author_agent];
          return (
            <Tooltip key={m.id} title={agent?.name ?? "agent"}>
              <Box
                sx={{
                  width: 28,
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "50%",
                  border: `2px solid ${ink[900]}`,
                  fontSize: 10,
                  fontWeight: 600,
                  color: "#fff",
                  ml: i > 0 ? "-8px" : 0,
                  background: agent?.avatar_color || "#7c5cff",
                }}
              >
                {(agent?.name ?? "?").charAt(0).toUpperCase()}
              </Box>
            </Tooltip>
          );
        })}
      </Box>

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          px: 1.5,
          py: 1.25,
          borderRadius: "999px",
          border: `1px solid ${ink[600]}`,
          backgroundColor: ink[800],
        }}
      >
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fog-300" />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fog-300" />
        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-fog-300" />
      </Box>

      <Typography sx={{ fontSize: 11, color: fog[300] }}>{label}</Typography>

      <Button
        size="small"
        color="error"
        onClick={() => pending.forEach((m) => void cancelRun(m.run_id))}
        sx={{ fontSize: 10, minWidth: 0 }}
      >
        stop
      </Button>
    </Box>
  );
}

function Bubble({
  message,
  agentName,
  color,
}: {
  message: Message;
  agentName?: string;
  color?: string;
}) {
  const isUser = message.author_type === "user";
  return (
    <Box sx={{ maxWidth: 780 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: isUser ? "#3fbf7f" : color || "#7c5cff",
          }}
        />
        <Typography sx={{ fontSize: 12, fontWeight: 500 }}>
          {isUser ? "you" : (agentName ?? message.author_type)}
        </Typography>
        <Typography sx={{ fontFamily: "var(--font-mono)", fontSize: 10, color: fog[300] }}>
          {new Date(message.created).toLocaleTimeString()}
        </Typography>
        {message.context_tokens > 0 && (
          <Typography sx={{ fontFamily: "var(--font-mono)", fontSize: 10, color: fog[300] }}>
            ctx {message.context_tokens}t
          </Typography>
        )}
        {message.status === "error" && (
          <Typography sx={{ fontSize: 10, color: "error.main" }}>error</Typography>
        )}
      </Box>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 1.5,
          borderRadius: "10px",
          whiteSpace: "pre-wrap",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.65,
          backgroundColor: isUser ? ink[700] : ink[800],
          border: isUser ? "none" : `1px solid ${ink[600]}`,
        }}
      >
        {message.body || (message.error ? message.error : "…")}
      </Box>
    </Box>
  );
}
