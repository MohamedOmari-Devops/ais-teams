import { useState } from "react";
import {
  Box,
  Button,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import DnsRoundedIcon from "@mui/icons-material/DnsRounded";
import {
  login,
  pbUrl,
  resetPbUrl,
  setPbUrl,
  signup,
  usingCustomPbUrl,
} from "../lib/pb";
import { fog, ink } from "../theme";

/**
 * Auth, with the server address tucked away.
 *
 * Almost everyone uses the address the build ships with (`VITE_PB_URL` in
 * `.env`), so the URL field stays hidden behind a question. It opens on its
 * own when this device is already pointed somewhere else, so a custom address
 * is never invisible.
 *
 * The shipped address is never printed anywhere on this screen: it is
 * infrastructure, not something a user is asked to read or copy. The field
 * starts empty unless this device already has an override of its own, and
 * leaving it empty simply means "use whatever the build ships with".
 */
export default function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [custom, setCustom] = useState(usingCustomPbUrl());
  const [url, setUrl] = useState(usingCustomPbUrl() ? pbUrl() : "");
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
      // Collapsed — or opened and left blank — means "whatever .env says",
      // even if the field holds an old value from before it was closed.
      if (custom && url.trim()) setPbUrl(url.trim());
      else resetPbUrl();

      if (mode === "login") await login(email, password);
      else await signup(email, password, name || email.split("@")[0]);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function useDefault() {
    resetPbUrl();
    setUrl("");
    setCustom(false);
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
        sx={{
          width: 400,
          p: 4,
          borderRadius: "16px",
          border: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography sx={{ fontSize: 18, fontWeight: 600 }}>AIS Teams</Typography>
        <Typography sx={{ fontSize: 12, color: fog[300], mb: 3 }}>
          Sign in to your agent workspace.
        </Typography>

        <Stack spacing={2}>
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

        <Box sx={{ mt: 2, pt: 2, borderTop: `1px solid ${ink[600]}` }}>
          {!custom ? (
            <Stack
              direction="row"
              spacing={0.75}
              sx={{ alignItems: "center", justifyContent: "center" }}
            >
              <DnsRoundedIcon sx={{ fontSize: 14, color: fog[300] }} />
              <Typography sx={{ fontSize: 11, color: fog[300] }}>
                Use your own PocketBase?
              </Typography>
              <Link
                component="button"
                type="button"
                underline="hover"
                onClick={() => setCustom(true)}
                sx={{ fontSize: 11 }}
              >
                Change server
              </Link>
            </Stack>
          ) : (
            <Stack spacing={1}>
              <TextField
                label="PocketBase URL"
                size="small"
                fullWidth
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://pocketbase.example.com"
                // helperText="Leave empty to use the built-in server."
                slotProps={{
                  input: { sx: { fontFamily: "var(--font-mono)", fontSize: 12 } },
                }}
              />
              <Link
                component="button"
                type="button"
                underline="hover"
                onClick={useDefault}
                sx={{ fontSize: 11, alignSelf: "flex-start" }}
              >
                Use the default server
              </Link>
            </Stack>
          )}
        </Box>
      </Paper>
    </Box>
  );
}
