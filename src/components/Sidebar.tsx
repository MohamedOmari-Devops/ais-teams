import { useState } from "react";
import { pb, currentUserId, logout } from "../lib/pb";
import { useApp } from "../store";
import type { Agent, Channel, Project } from "../lib/types";

interface Props {
  projects: Project[];
  onReload: () => void;
  onEditAgent: (agent: Agent | null) => void;
}

/**
 * Project switcher, channel list, agent roster.
 *
 * Channels are the unit of context: each one owns a lane, and creating a
 * channel is how a project gets split into cheap, separately-remembered
 * conversations.
 */
export default function Sidebar({ projects, onReload, onEditAgent }: Props) {
  const { project, channel, channels, agents, setProject, setChannel } = useApp();
  const [creating, setCreating] = useState<"channel" | "project" | null>(null);
  const [draft, setDraft] = useState("");

  async function createProject(name: string) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const created = await pb.collection("projects").create<Project>({
      name,
      slug: `${slug}-${Math.random().toString(36).slice(2, 6)}`,
      owner: currentUserId(),
      members: [currentUserId()],
      context_budget: 3000,
      default_model: "sonnet",
    });
    setProject(created);
    onReload();
  }

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
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-ink-700 bg-ink-800">
      <div className="border-b border-ink-700 p-3">
        <select
          className="w-full rounded-md border border-ink-600 bg-ink-700 px-2 py-1.5 text-sm outline-none"
          value={project?.id ?? ""}
          onChange={(e) => {
            const next = projects.find((p) => p.id === e.target.value) ?? null;
            setProject(next);
            setChannel(null);
          }}
        >
          {projects.length === 0 && <option value="">no projects</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            setCreating("project");
            setDraft("");
          }}
          className="mt-2 w-full rounded-md border border-ink-600 py-1 text-xs text-fog-300 hover:text-fog-100"
        >
          + new project
        </button>
        {project?.root_path ? (
          <p className="mt-2 truncate font-mono text-[10px] text-fog-300" title={project.root_path}>
            {project.root_path}
          </p>
        ) : (
          <p className="mt-2 text-[10px] text-warn">no root_path set — agents run in "."</p>
        )}
      </div>

      <Section title="Channels" onAdd={() => { setCreating("channel"); setDraft(""); }}>
        {channels.map((c) => (
          <button
            key={c.id}
            onClick={() => setChannel(c)}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
              channel?.id === c.id
                ? "bg-accent-soft text-fog-100"
                : "text-fog-300 hover:bg-ink-700"
            }`}
          >
            <span className="text-fog-300">#</span>
            <span className="truncate">{c.name}</span>
            <span className="ml-auto font-mono text-[10px] text-fog-300">{c.lane}</span>
          </button>
        ))}
      </Section>

      <Section title="Agents" onAdd={() => onEditAgent(null)}>
        {agents.map((a) => (
          <button
            key={a.id}
            onClick={() => onEditAgent(a)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-fog-300 hover:bg-ink-700"
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

      <div className="mt-auto border-t border-ink-700 p-3">
        <button
          onClick={() => {
            logout();
            location.reload();
          }}
          className="text-xs text-fog-300 hover:text-fog-100"
        >
          sign out
        </button>
      </div>

      {creating && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60">
          <div className="w-80 rounded-lg border border-ink-600 bg-ink-800 p-4">
            <p className="mb-2 text-sm">
              New {creating === "project" ? "project" : "channel"} name
            </p>
            <input
              autoFocus
              className="w-full rounded-md border border-ink-600 bg-ink-700 px-3 py-2 text-sm outline-none focus:border-accent"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key !== "Enter" || !draft.trim()) return;
                if (creating === "project") await createProject(draft.trim());
                else await createChannel(draft.trim());
                setCreating(null);
              }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                className="text-xs text-fog-300"
                onClick={() => setCreating(null)}
              >
                cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function Section({
  title,
  onAdd,
  children,
}: {
  title: string;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-ink-700 p-2">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[10px] uppercase tracking-wider text-fog-300">
          {title}
        </span>
        <button onClick={onAdd} className="text-fog-300 hover:text-fog-100">
          +
        </button>
      </div>
      <div className="max-h-56 space-y-0.5 overflow-y-auto">{children}</div>
    </div>
  );
}
