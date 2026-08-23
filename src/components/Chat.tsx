import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import { broadcast, cancelRun, pickTargets } from "../lib/orchestrator";
import { estimateTokens } from "../lib/bridge";
import type { Message } from "../lib/types";

/** Chat pane: transcript, live drafts, composer, per-turn cost preview. */
export default function Chat() {
  const { project, channel, agents, messages, drafts, hostCanRun } = useApp();
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState(0);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const agentById = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.id, a])),
    [agents],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, drafts]);

  useEffect(() => {
    let alive = true;
    void estimateTokens(text).then((n) => alive && setTokens(n));
    return () => {
      alive = false;
    };
  }, [text]);

  if (!project || !channel) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-fog-300">
        Pick a channel, or create one.
      </div>
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

  const liveDrafts = Object.values(drafts).filter(
    (d) => d.channelId === channel.id,
  );

  return (
    <section className="flex h-full flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-ink-700 px-4 py-3">
        <h2 className="text-sm font-semibold">#{channel.name}</h2>
        <span className="rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-fog-300">
          lane:{channel.lane}
        </span>
        {channel.topic && (
          <span className="truncate text-xs text-fog-300">{channel.topic}</span>
        )}
        <span className="ml-auto text-[11px] text-fog-300">
          {channel.agents?.length ?? 0} agent(s)
        </span>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.map((m) => (
          <Bubble
            key={m.id}
            message={m}
            agentName={agentById[m.author_agent]?.name}
            color={agentById[m.author_agent]?.avatar_color}
          />
        ))}

        {liveDrafts.map((d) => (
          <div key={d.runId} className="max-w-3xl">
            <div className="mb-1 flex items-center gap-2">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: agentById[d.agentId]?.avatar_color || "#7c5cff" }}
              />
              <span className="text-xs font-medium">
                {agentById[d.agentId]?.name ?? "agent"}
              </span>
              <span className="font-mono text-[10px] text-fog-300">
                ctx {d.contextTokens}t
              </span>
              <button
                onClick={() => void cancelRun(d.runId)}
                className="text-[10px] text-bad hover:underline"
              >
                stop
              </button>
            </div>
            <pre className="caret whitespace-pre-wrap rounded-lg border border-ink-600 bg-ink-800 p-3 font-mono text-[12px] leading-relaxed">
              {d.text}
            </pre>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <footer className="border-t border-ink-700 p-3">
        {!hostCanRun && (
          <p className="mb-2 text-[11px] text-warn">
            No local Claude Code on this device — turns are queued for a desktop
            host to execute.
          </p>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
          placeholder={`Message #${channel.name}   (@agent to target one)`}
          className="w-full resize-none rounded-md border border-ink-600 bg-ink-700 p-3 text-sm outline-none focus:border-accent"
        />
        <div className="mt-2 flex items-center gap-3 text-[11px] text-fog-300">
          <span className="font-mono">~{tokens}t in</span>
          <span>
            → {targets.length ? targets.map((a) => a.name).join(", ") : "nobody"}
          </span>
          <button
            onClick={() => void send()}
            disabled={sending || !text.trim() || targets.length === 0}
            className="ml-auto rounded-md bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </footer>
    </section>
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
    <div className="max-w-3xl">
      <div className="mb-1 flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: isUser ? "#3fbf7f" : color || "#7c5cff" }}
        />
        <span className="text-xs font-medium">
          {isUser ? "you" : (agentName ?? message.author_type)}
        </span>
        <span className="font-mono text-[10px] text-fog-300">
          {new Date(message.created).toLocaleTimeString()}
        </span>
        {message.context_tokens > 0 && (
          <span className="font-mono text-[10px] text-fog-300">
            ctx {message.context_tokens}t
          </span>
        )}
        {message.status === "error" && (
          <span className="text-[10px] text-bad">error</span>
        )}
      </div>
      <pre
        className={`whitespace-pre-wrap rounded-lg p-3 font-mono text-[12px] leading-relaxed ${
          isUser ? "bg-ink-700" : "border border-ink-600 bg-ink-800"
        }`}
      >
        {message.body || (message.error ? message.error : "…")}
      </pre>
    </div>
  );
}
