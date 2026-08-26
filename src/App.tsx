import { useCallback, useEffect, useState } from "react";
import Login from "./components/Login";
import Sidebar from "./components/Sidebar";
import Chat from "./components/Chat";
import AgentEditor from "./components/AgentEditor";
import TerminalPane from "./components/Terminal";
import TitleBar from "./components/TitleBar";
import SettingsDialog, { type SectionId } from "./components/SettingsDialog";
import PluginsDialog from "./components/PluginsDialog";
import ArchitectDialog from "./components/ArchitectDialog";
import { pb, isAuthed } from "./lib/pb";
import { claudeDoctor, hostInfo, isTauri, readSettings } from "./lib/bridge";
import { initRunListeners, startQueueWorker } from "./lib/orchestrator";
import { isArchitectAgent, isArchitectChannel } from "./lib/architect";
import { useApp } from "./store";
import type { Agent, Channel, Message, Project } from "./lib/types";

export default function App() {
  const [authed, setAuthed] = useState(isAuthed());
  const [projects, setProjects] = useState<Project[]>([]);
  const [editing, setEditing] = useState<{ agent: Agent | null } | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  // `undefined` = closed. `null` = creating. A project = editing that project.
  const [projectPanel, setProjectPanel] = useState<Project | null | undefined>(
    undefined,
  );
  // Which settings section the panel opens on, so the runner status line can
  // land on the backend that is failing rather than on the project's name.
  const [settingsSection, setSettingsSection] = useState<SectionId>("general");
  const [showPlugins, setShowPlugins] = useState(false);
  const [showArchitect, setShowArchitect] = useState(false);
  // Setup commands the architect handed over, consumed once by the terminal.
  const [setupCommands, setSetupCommands] = useState<string[]>([]);

  const {
    project,
    channel,
    setProject,
    setChannel,
    setChannels,
    setAgents,
    setMessages,
    upsertMessage,
    removeMessage,
    setHost,
    hostCanRun,
    claudeVersion,
  } = useApp();

  // ---- host capabilities: can this device actually spawn Claude Code? ----
  useEffect(() => {
    if (!authed) return;
    void (async () => {
      const info = await hostInfo();
      const version = info.canRunAgents ? await claudeDoctor() : "";
      // Say which CLI the runner actually spawns: with several backends
      // configured, "runner ready" alone does not answer the question that
      // matters when a turn comes back wrong.
      const settings = info.canRunAgents ? await readSettings() : null;
      const backend =
        settings?.profiles.find((p) => p.id === settings.defaultProfile)?.label ??
        "";
      const label = [backend, version].filter(Boolean).join(" · ");
      setHost(info.canRunAgents && !version.startsWith("unavailable"), label);
      await initRunListeners();
    })();
  }, [authed, setHost]);

  // A desktop host also serves runs queued by phones.
  useEffect(() => {
    if (!authed || !hostCanRun || !isTauri()) return;
    const stop = startQueueWorker();
    return stop;
  }, [authed, hostCanRun]);

  const loadProjects = useCallback(async () => {
    const rows = await pb.collection("projects").getFullList<Project>({
      sort: "-updated",
    });
    setProjects(rows);
    if (!project && rows.length) setProject(rows[0]);
  }, [project, setProject]);

  useEffect(() => {
    if (!authed) return;
    void loadProjects();
  }, [authed, loadProjects]);

  // ---- project scope: channels + agents ----
  const loadScope = useCallback(async () => {
    if (!project) return;
    const [channels, agents] = await Promise.all([
      pb.collection("channels").getFullList<Channel>({
        filter: `project = "${project.id}"`,
        sort: "name",
      }),
      pb.collection("agents").getFullList<Agent>({
        filter: `project = "${project.id}"`,
        sort: "name",
      }),
    ]);
    // The architect and its room are workspace plumbing, not part of the
    // project's own team — keeping them out of the store keeps them out of the
    // sidebar, out of channel auto-selection and out of every broadcast.
    const visibleChannels = channels.filter((c) => !isArchitectChannel(c));
    setChannels(visibleChannels);
    setAgents(agents.filter((a) => !isArchitectAgent(a)));
    if (!channel || channel.project !== project.id) {
      setChannel(visibleChannels[0] ?? null);
    }
  }, [project, channel, setChannels, setAgents, setChannel]);

  useEffect(() => {
    void loadScope();
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- channel transcript, kept live for every device ----
  useEffect(() => {
    if (!channel) {
      setMessages([]);
      return;
    }
    const channelId = channel.id;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let signature = "";

    const load = async () => {
      try {
        const rows = await pb.collection("messages").getFullList<Message>({
          filter: `channel = "${channelId}"`,
          sort: "created",
        });
        if (cancelled) return;
        // Re-rendering the transcript on every poll would fight the scroll
        // position, so only a real change is pushed into the store.
        const next = rows.map((row) => `${row.id}:${row.updated}`).join(",");
        if (next === signature) return;
        signature = next;
        setMessages(rows);
      } catch {
        // Offline or mid-restart: the next tick tries again.
      }
    };

    void load();

    // Keep the unsubscribe this call returns. `unsubscribe("*")` drops every
    // listener on the collection, so an overlapping mount — StrictMode remounts
    // in dev, or a fast channel switch — could tear down the subscription that
    // had just replaced this one, leaving the channel silent.
    void pb
      .collection("messages")
      .subscribe<Message>("*", (event) => {
        if (event.record.channel !== channelId) return;
        if (event.action === "delete") removeMessage(event.record.id);
        else upsertMessage(event.record);
      })
      .then((off) => {
        if (cancelled) void off();
        else unsubscribe = off;
      })
      .catch(() => {
        // No realtime on this connection; the poll below carries the channel.
      });

    // Realtime can stall without erroring — a proxy idling out an SSE stream, a
    // laptop waking from sleep. A slow refetch means the transcript converges
    // anyway instead of waiting for someone to switch channels and back.
    const poll = setInterval(() => void load(), 4000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      cancelled = true;
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      unsubscribe?.();
    };
  }, [channel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Channel/agent edits made on another device should show up here too.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const offs: Array<() => void> = [];

    for (const name of ["channels", "agents"]) {
      void pb
        .collection(name)
        .subscribe("*", () => void loadScope())
        .then((off) => (cancelled ? void off() : offs.push(off)))
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      offs.forEach((off) => off());
    };
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const subtitle = project
    ? `${project.name}${channel ? ` · #${channel.name}` : ""}`
    : undefined;

  // Everything lives inside the rounded shell, including the login screen —
  // the window is frameless, so the app draws its own chrome.
  if (!authed) {
    return (
      <div className="app-shell">
        <TitleBar />
        <div className="flex-1 overflow-hidden">
          <Login onDone={() => setAuthed(true)} />
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TitleBar
        subtitle={subtitle}
        onOpenSettings={
          project
            ? () => {
                setSettingsSection("general");
                setProjectPanel(project);
              }
            : undefined
        }
        onOpenPlugins={() => setShowPlugins(true)}
        onOpenArchitect={() => setShowArchitect(true)}
      />
      <div className="relative flex flex-1 overflow-hidden">
      <Sidebar
        projects={projects}
        onReload={() => {
          void loadProjects();
          void loadScope();
        }}
        onEditAgent={(agent) => setEditing({ agent })}
      />

      <main className="flex flex-1 overflow-hidden">
        <Chat />
        {showTerminal && (
          <TerminalPane
            onClose={() => setShowTerminal(false)}
            commands={setupCommands}
            onCommandsDone={() => setSetupCommands([])}
          />
        )}
      </main>

      <button
        onClick={() => setShowTerminal((v) => !v)}
        className="absolute right-3 top-3 z-10 rounded-md border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-fog-300 hover:text-fog-100"
      >
        {showTerminal ? "hide terminal" : "terminal"}
      </button>

      <button
        onClick={() => {
          setSettingsSection("backends");
          setProjectPanel(project);
        }}
        title="CLI backends"
        className="absolute bottom-2 left-72 z-10 font-mono text-[10px] text-fog-300 hover:text-fog-100"
      >
        {hostCanRun ? `runner ready · ${claudeVersion}` : "runner offline"}
      </button>

      {editing && (
        <AgentEditor
          agent={editing.agent}
          onClose={() => {
            setEditing(null);
            void loadScope();
          }}
        />
      )}

      {showPlugins && <PluginsDialog onClose={() => setShowPlugins(false)} />}

      {showArchitect && (
        <ArchitectDialog
          project={project}
          onClose={() => setShowArchitect(false)}
          onRunSetup={(commands) => {
            setSetupCommands(commands);
            setShowTerminal(true);
          }}
          onApplied={() => {
            void loadProjects();
            void loadScope();
          }}
        />
      )}

      {projectPanel !== undefined && (
        <SettingsDialog
          project={projectPanel}
          initialSection={settingsSection}
          onClose={(saved) => {
            setProjectPanel(undefined);
            if (saved) setProject(saved);
            void loadProjects();
            void loadScope();
          }}
        />
      )}
      </div>
    </div>
  );
}
