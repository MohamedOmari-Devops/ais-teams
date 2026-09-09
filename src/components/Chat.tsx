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

/** How many agents the mention list shows before it starts scrolling. */
const MENTION_ROWS = 8;

/**
 * The `@…` token being typed at the caret, if there is one.
 *
 * A mention only starts at the beginning of a line or after whitespace, so an
 * email address in the middle of a sentence does not open the picker, and it
 * ends at the first space — which is also why an agent whose name contains one
 * is completed from the picker rather than typed out.
 */
export function mentionAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Chat pane: transcript, typing indicator, composer, per-turn cost preview. */
export default function Chat() {
  const { project, channel, agents, messages, hostCanRun, runnerError } =
    useApp();
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState(0);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // ---- @mention picker ----
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  /** Escape closes the picker until the token being typed changes. */
  const [dismissed, setDismissed] = useState(false);

  const agentById = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.id, a])),
    [agents],
  );

  // The store is loaded per channel, but a realtime event or a late fetch can
  // land a row from the channel just left. Render only what belongs here.
  const mine = channel
    ? messages.filter((m) => m.channel === channel.id)
    : ([] as Message[]);

  // A turn is rendered exactly once: as dots while it runs, as a bubble after.
  const settled = mine.filter((m) => !IN_FLIGHT.includes(m.status));
  const pending = mine.filter((m) => IN_FLIGHT.includes(m.status));

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

  // Only agents that could actually answer here: the same rule `pickTargets`
  // applies when the message is sent, so the list never offers a name that
  // would then be ignored.
  const onChannel = channel
    ? agents.filter(
        (a) => a.enabled !== false && channel.agents?.includes(a.id),
      )
    : [];

  const mention = dismissed ? null : mentionAt(text, caret);
  const matches = mention
    ? onChannel
        .filter((a) =>
          a.name.toLowerCase().startsWith(mention.query.toLowerCase()),
        )
        .slice(0, MENTION_ROWS)
    : [];
  const picking = matches.length > 0;
  const index = Math.min(active, matches.length - 1);

  // A new token starts the list at the top rather than wherever the last one
  // was left.
  useEffect(() => setActive(0), [mention?.query]);

  /** Replace the token under the caret with a complete mention. */
  const complete = (agent: Agent) => {
    if (!mention) return;
    const next = `${text.slice(0, mention.start)}@${agent.name} ${text.slice(caret)}`;
    const pos = mention.start + agent.name.length + 2;
    setText(next);
    setCaret(pos);
    // The value lands on the textarea a render later; move the caret past the
    // inserted name only once it is there, or it snaps back to the end.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

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
        {!hostCanRun ? (
          <Typography sx={{ fontSize: 11, color: "warning.main", mb: 1 }}>
            No CLI on this device — turns are queued for a desktop host to
            execute.
          </Typography>
        ) : runnerError ? (
          // This device does run turns; the backend it was pointed at is the
          // thing that is broken, and the message says which and why.
          <Typography sx={{ fontSize: 11, color: "error.main", mb: 1 }}>
            {runnerError}
          </Typography>
        ) : null}
        <Box sx={{ position: "relative" }}>
          {picking && (
            <Box
              sx={{
                position: "absolute",
                bottom: "100%",
                left: 0,
                mb: 0.75,
                zIndex: 5,
                width: 320,
                maxHeight: 240,
                overflowY: "auto",
                borderRadius: "10px",
                border: `1px solid ${ink[600]}`,
                backgroundColor: ink[800],
                boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
              }}
            >
              {matches.map((agent, i) => (
                <Box
                  key={agent.id}
                  // Mouse down, not click: click would blur the textarea first
                  // and the caret this insertion depends on would be gone.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    complete(agent);
                  }}
                  onMouseEnter={() => setActive(i)}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    px: 1.25,
                    py: 0.75,
                    cursor: "pointer",
                    backgroundColor: i === index ? ink[700] : "transparent",
                  }}
                >
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: agent.avatar_color || "#7c5cff",
                    }}
                  />
                  <Typography sx={{ fontSize: 12.5 }}>{agent.name}</Typography>
                  <Typography
                    sx={{
                      fontSize: 11,
                      color: fog[300],
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {agent.role}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}

          <TextField
            fullWidth
            multiline
            rows={3}
            size="small"
            value={text}
            inputRef={inputRef}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setDismissed(false);
            }}
            onSelect={(e) => {
              const el = e.target as HTMLTextAreaElement;
              if (el.selectionStart != null) setCaret(el.selectionStart);
            }}
            onKeyDown={(e) => {
              if (picking) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((i) => (i + 1) % matches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((i) => (i - 1 + matches.length) % matches.length);
                  return;
                }
                // Enter completes the mention here; it only sends once the
                // picker is closed, so a name is never half-typed into a turn.
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  complete(matches[index]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setDismissed(true);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={`Message #${channel.name}   (@agent to target one)`}
          />
        </Box>
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
    <Box sx={{ width: "100%" }}>
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
