import { useEffect, useRef, useState } from "react";
import {
  isTauri,
  onPtyData,
  onPtyExit,
  ptyClose,
  ptyOpen,
  ptyWrite,
} from "../lib/bridge";
import { useApp } from "../store";

/**
 * Raw Claude Code TUI in a pane.
 *
 * Chat turns go through the headless runner; this is the escape hatch for when
 * a human wants the real interactive session (permission prompts, slash
 * commands, /resume) against the same project directory.
 *
 * Rendering is deliberately minimal: ANSI escapes are stripped rather than
 * interpreted. Swap this for xterm.js when full fidelity is needed.
 */
export default function Terminal({ onClose }: { onClose: () => void }) {
  const { project } = useApp();
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionId = project ? `pty-${project.id}` : "pty-none";

  useEffect(() => {
    let offData: (() => void) | undefined;
    let offExit: (() => void) | undefined;

    void (async () => {
      offData = await onPtyData((e) => {
        if (e.sessionId !== sessionId) return;
        setOutput((prev) => (prev + stripAnsi(e.data)).slice(-60000));
      });
      offExit = await onPtyExit((e) => {
        if (e.sessionId !== sessionId) return;
        setRunning(false);
        setOutput((prev) => `${prev}\n[exited with code ${e.code}]\n`);
      });
    })();

    return () => {
      offData?.();
      offExit?.();
    };
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [output]);

  async function start() {
    if (!project || !isTauri()) return;
    setOutput("");
    await ptyOpen({
      sessionId,
      cwd: project.root_path || ".",
      cols: 120,
      rows: 30,
    });
    setRunning(true);
  }

  async function stop() {
    await ptyClose(sessionId);
    setRunning(false);
  }

  return (
    <div className="flex h-full w-[520px] shrink-0 flex-col border-l border-ink-700 bg-ink-900">
      <header className="flex items-center gap-2 border-b border-ink-700 px-3 py-2">
        <h3 className="text-xs font-semibold">Terminal</h3>
        <span className="font-mono text-[10px] text-fog-300">
          {project?.root_path || "."}
        </span>
        <div className="ml-auto flex gap-2">
          {running ? (
            <button onClick={() => void stop()} className="text-[11px] text-bad">
              kill
            </button>
          ) : (
            <button onClick={() => void start()} className="text-[11px] text-ok">
              start claude
            </button>
          )}
          <button onClick={onClose} className="text-[11px] text-fog-300">
            ✕
          </button>
        </div>
      </header>

      <pre className="flex-1 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-fog-100">
        {output || "// not running"}
        <div ref={bottomRef} />
      </pre>

      <div className="border-t border-ink-700 p-2">
        <input
          value={input}
          disabled={!running}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === "Enter") {
              await ptyWrite(sessionId, `${input}\r`);
              setInput("");
            } else if (e.key === "Escape") {
              await ptyWrite(sessionId, "\x1b");
            }
          }}
          placeholder={running ? "type, Enter sends" : "start a session first"}
          className="w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-1.5 font-mono text-[11px] outline-none focus:border-accent disabled:opacity-40"
        />
      </div>
    </div>
  );
}

/** Drop CSI/OSC sequences so the plain <pre> stays readable. */
function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\r(?!\n)/g, "\n");
}
