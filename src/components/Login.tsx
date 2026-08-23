import { useState } from "react";
import {
  Box,
  Button,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { login, pbUrl, setPbUrl, signup } from "../lib/pb";
import { fog } from "../theme";

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
    <Box
      sx={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Paper
        component="form"
        onSubmit={submit}
        elevation={0}
        sx={{ width: 400, p: 4, borderRadius: "16px", border: "1px solid", borderColor: "divider" }}
      >
        <Typography sx={{ fontSize: 18, fontWeight: 600 }}>AIS Teams</Typography>
        <Typography sx={{ fontSize: 12, color: fog[300], mb: 3 }}>
          Agent workspace backed by your own PocketBase.
        </Typography>

        <Stack spacing={2}>
          <TextField
            label="PocketBase URL"
            size="small"
            fullWidth
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://127.0.0.1:8090"
            slotProps={{ input: { sx: { fontFamily: "var(--font-mono)", fontSize: 12 } } }}
          />

          {mode === "signup" && (
            <TextField
              label="Name"
              size="small"
              fullWidth
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}

          <TextField
            label="Email"
            type="email"
            size="small"
            fullWidth
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <TextField
            label="Password"
            type="password"
            size="small"
            fullWidth
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && (
            <Typography sx={{ fontSize: 12, color: "error.main" }}>{error}</Typography>
          )}

          <Button type="submit" variant="contained" disabled={busy} fullWidth>
            {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
          </Button>

          <Button
            size="small"
            color="inherit"
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
            sx={{ color: fog[300], fontSize: 12 }}
          >
            {mode === "login" ? "Create an account" : "I already have an account"}
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
