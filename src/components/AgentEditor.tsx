import { useState } from "react";
import { pb } from "../lib/pb";
import { useApp } from "../store";
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
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = <K extends keyof Agent>(key: K, value: Agent[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

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
    <div className="absolute inset-0 z-30 flex justify-end bg-black/60">
      <div className="flex h-full w-[460px] flex-col border-l border-ink-600 bg-ink-800">
        <header className="flex items-center justify-between border-b border-ink-700 px-4 py-3">
          <h3 className="text-sm font-semibold">
            {agent ? `Agent · ${agent.name}` : "New agent"}
          </h3>
          <button onClick={onClose} className="text-fog-300 hover:text-fog-100">
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <Field label="Name">
            <input
              className={inputCls}
              value={form.name ?? ""}
              onChange={(e) => set("name", e.target.value)}
              placeholder="backend"
            />
          </Field>

          <Field label="Role (shown in the roster)">
            <input
              className={inputCls}
              value={form.role ?? ""}
              onChange={(e) => set("role", e.target.value)}
              placeholder="owns the API and migrations"
            />
          </Field>

          <Field label="Instructions (becomes --append-system-prompt)">
            <textarea
              rows={7}
              className={inputCls}
              value={form.instructions ?? ""}
              onChange={(e) => set("instructions", e.target.value)}
              placeholder="You own the Rust backend. Prefer small diffs. Never touch the UI."
            />
          </Field>

          <div className="grid grid-cols-3 gap-2">
            <Field label="Model">
              <select
                className={inputCls}
                value={form.model ?? ""}
                onChange={(e) => set("model", e.target.value)}
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m || "project default"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Effort">
              <select
                className={inputCls}
                value={form.effort ?? ""}
                onChange={(e) => set("effort", e.target.value as Agent["effort"])}
              >
                {EFFORTS.map((m) => (
                  <option key={m} value={m}>
                    {m || "default"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Permissions">
              <select
                className={inputCls}
                value={form.permission_mode ?? ""}
                onChange={(e) =>
                  set("permission_mode", e.target.value as Agent["permission_mode"])
                }
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {m || "default"}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Extra context lanes (comma separated)">
            <input
              className={inputCls}
              value={(form.lanes ?? []).join(", ")}
              onChange={(e) =>
                set(
                  "lanes",
                  e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
              placeholder="infra, auth"
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Allowed tools">
              <input
                className={inputCls}
                value={(form.allowed_tools ?? []).join(", ")}
                onChange={(e) =>
                  set(
                    "allowed_tools",
                    e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                  )
                }
                placeholder="Read, Grep, Bash(git *)"
              />
            </Field>
            <Field label="Denied tools">
              <input
                className={inputCls}
                value={(form.disallowed_tools ?? []).join(", ")}
                onChange={(e) =>
                  set(
                    "disallowed_tools",
                    e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                  )
                }
                placeholder="WebFetch"
              />
            </Field>
          </div>

          <Field label="Context budget (tokens per turn)">
            <input
              type="number"
              className={inputCls}
              value={form.context_budget ?? 3000}
              onChange={(e) => set("context_budget", Number(e.target.value))}
            />
          </Field>

          <div className="flex flex-wrap gap-4 pt-1">
            <Toggle
              label="enabled"
              value={form.enabled ?? true}
              onChange={(v) => set("enabled", v)}
            />
            <Toggle
              label="bare (skip hooks/plugins)"
              value={form.bare ?? false}
              onChange={(v) => set("bare", v)}
            />
            <Toggle
              label="verbose output"
              value={form.verbose_output ?? false}
              onChange={(v) => set("verbose_output", v)}
            />
          </div>

          <Field label="Colour">
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => set("avatar_color", c)}
                  className={`h-6 w-6 rounded-full ${
                    form.avatar_color === c ? "ring-2 ring-fog-100" : ""
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </Field>

          {error && <p className="text-xs text-bad">{error}</p>}
        </div>

        <footer className="flex items-center gap-2 border-t border-ink-700 p-3">
          {agent && channel && (
            <button
              onClick={() => void toggleChannelMembership()}
              className="rounded-md border border-ink-600 px-3 py-1.5 text-xs text-fog-300"
            >
              {channel.agents?.includes(agent.id)
                ? `remove from #${channel.name}`
                : `add to #${channel.name}`}
            </button>
          )}
          {agent && (
            <button
              onClick={() => void remove()}
              className="text-xs text-bad hover:underline"
            >
              delete
            </button>
          )}
          <button
            onClick={() => void save()}
            disabled={busy}
            className="ml-auto rounded-md bg-accent px-4 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-ink-600 bg-ink-700 px-3 py-2 text-xs outline-none focus:border-accent";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-fog-300">
        {label}
      </span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-fog-300">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
