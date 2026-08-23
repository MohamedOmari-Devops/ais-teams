import { useCallback, useEffect, useState } from "react";
import Login from "./components/Login";
import Sidebar from "./components/Sidebar";
import Chat from "./components/Chat";
import AgentEditor from "./components/AgentEditor";
import TerminalPane from "./components/Terminal";
import TitleBar from "./components/TitleBar";
import ProjectDialog from "./components/ProjectDialog";
import { pb, isAuthed } from "./lib/pb";
import { claudeDoctor, hostInfo, isTauri } from "./lib/bridge";
import { initRunListeners, startQueueWorker } from "./lib/orchestrator";
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
      setHost(info.canRunAgents && !version.startsWith("unavailable"), version);
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
    setChannels(channels);
    setAgents(agents);
    if (!channel || channel.project !== project.id) {
      setChannel(channels[0] ?? null);
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
    let cancelled = false;

    void pb
      .collection("messages")
      .getFullList<Message>({
        filter: `channel = "${channel.id}"`,
        sort: "created",
      })
      .then((rows) => !cancelled && setMessages(rows));

    void pb.collection("messages").subscribe<Message>("*", (event) => {
      if (event.record.channel !== channel.id) return;
      if (event.action === "delete") removeMessage(event.record.id);
      else upsertMessage(event.record);
    });

    return () => {
      cancelled = true;
      void pb.collection("messages").unsubscribe("*");
    };
  }, [channel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Channel/agent edits made on another device should show up here too.
  useEffect(() => {
    if (!project) return;
    void pb.collection("channels").subscribe("*", () => void loadScope());
    void pb.collection("agents").subscribe("*", () => void loadScope());
    return () => {
      void pb.collection("channels").unsubscribe("*");
      void pb.collection("agents").unsubscribe("*");
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
        onOpenSettings={project ? () => setProjectPanel(project) : undefined}
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
        {showTerminal && <TerminalPane onClose={() => setShowTerminal(false)} />}
      </main>

      <button
        onClick={() => setShowTerminal((v) => !v)}
        className="absolute right-3 top-3 z-10 rounded-md border border-ink-600 bg-ink-800 px-2 py-1 text-[11px] text-fog-300 hover:text-fog-100"
      >
        {showTerminal ? "hide terminal" : "terminal"}
      </button>

      <div className="absolute bottom-2 left-72 z-10 font-mono text-[10px] text-fog-300">
        {hostCanRun ? `runner ready · ${claudeVersion}` : "runner offline"}
      </div>

      {editing && (
        <AgentEditor
          agent={editing.agent}
          onClose={() => {
            setEditing(null);
            void loadScope();
          }}
        />
      )}

      {projectPanel !== undefined && (
        <ProjectDialog
          project={projectPanel}
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
