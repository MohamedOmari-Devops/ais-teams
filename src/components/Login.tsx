import { useState } from "react";
import { login, pbUrl, setPbUrl, signup } from "../lib/pb";

/**
 * Auth plus server address in one screen.
 *
 * The address matters: the desktop app talks to PocketBase on localhost, a
 * phone has to use the LAN IP of the machine running Docker.
 */
export default function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [url, setUrl] = useState(pbUrl());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setPbUrl(url);
      if (mode === "login") await login(email, password);
      else await signup(email, password, name || email.split("@")[0]);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ink-900">
      <form
        onSubmit={submit}
        className="w-[380px] rounded-xl border border-ink-600 bg-ink-800 p-6 shadow-2xl"
      >
        <h1 className="mb-1 text-lg font-semibold">AIS Teams</h1>
        <p className="mb-5 text-xs text-fog-300">
          Agent workspace backed by your own PocketBase.
        </p>

        <label className="mb-1 block text-xs text-fog-300">PocketBase URL</label>
        <input
          className="mb-3 w-full rounded-md border border-ink-600 bg-ink-700 px-3 py-2 font-mono text-xs outline-none focus:border-accent"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://127.0.0.1:8090"
        />

        {mode === "signup" && (
          <>
            <label className="mb-1 block text-xs text-fog-300">Name</label>
            <input
              className="mb-3 w-full rounded-md border border-ink-600 bg-ink-700 px-3 py-2 text-sm outline-none focus:border-accent"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </>
        )}

        <label className="mb-1 block text-xs text-fog-300">Email</label>
        <input
          className="mb-3 w-full rounded-md border border-ink-600 bg-ink-700 px-3 py-2 text-sm outline-none focus:border-accent"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          autoComplete="username"
        />

        <label className="mb-1 block text-xs text-fog-300">Password</label>
        <input
          className="mb-4 w-full rounded-md border border-ink-600 bg-ink-700 px-3 py-2 text-sm outline-none focus:border-accent"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoComplete="current-password"
        />

        {error && <p className="mb-3 text-xs text-bad">{error}</p>}

        <button
          disabled={busy}
          className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
          className="mt-3 w-full text-center text-xs text-fog-300 hover:text-fog-100"
        >
          {mode === "login" ? "Create an account" : "I already have an account"}
        </button>
      </form>
    </div>
  );
}
