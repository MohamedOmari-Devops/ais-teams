import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import UpdateRoundedIcon from "@mui/icons-material/UpdateRounded";
import {
  marketplaceAdd,
  marketplaceRemove,
  pluginCatalog,
  pluginInstall,
  pluginSetEnabled,
  pluginUninstall,
  pluginUpdate,
} from "../lib/bridge";
import { useApp } from "../store";
import { ink, fog } from "../theme";
import type { AvailablePlugin, PluginCatalog } from "../lib/types";

const SCOPES = ["user", "project", "local"];

/** How many search results to render at once. The catalog is ~300 entries. */
const PAGE = 40;

/**
 * Browse, search and install Claude Code plugins.
 *
 * This drives the CLI's own plugin system rather than a parallel one, so
 * anything installed here is equally available to a plain `claude` session and
 * to every agent this app runs.
 */
export default function PluginsDialog({ onClose }: { onClose: () => void }) {
  const { project } = useApp();
  const [tab, setTab] = useState(0);
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("user");
  const [limit, setLimit] = useState(PAGE);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newMarketplace, setNewMarketplace] = useState("");

  // Project scope installs land in the project's working folder.
  const cwd = project?.root_path || undefined;

  async function refresh() {
    setError("");
    try {
      setCatalog(await pluginCatalog());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const installedIds = useMemo(
    () => new Set((catalog?.installed ?? []).map((p) => p.id)),
    [catalog],
  );

  const matches = useMemo(() => {
    const available = catalog?.available ?? [];

    // The CLI drops a plugin from `available` once it is installed. Without
    // this, searching for something you just installed returns nothing.
    const availableIds = new Set(available.map((p) => p.pluginId));
    const installedOnly: AvailablePlugin[] = (catalog?.installed ?? [])
      .filter((p) => !availableIds.has(p.id))
      .map((p) => {
        const [name, marketplaceName = ""] = p.id.split("@");
        return {
          pluginId: p.id,
          name,
          marketplaceName,
          description: `Installed · ${p.scope} scope · version ${p.version}`,
          installCount: 0,
        };
      });

    const all = [...installedOnly, ...available].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((p) =>
      `${p.name} ${p.description} ${p.marketplaceName}`
        .toLowerCase()
        .includes(needle),
    );
  }, [catalog, query]);

  /** Run one plugin operation, then reload so the lists reflect reality. */
  async function act(id: string, op: () => Promise<string>, done: string) {
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      await op();
      setNotice(done);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId("");
    }
  }

  return (
    <Dialog open fullWidth maxWidth="md" onClose={onClose}>
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 0 }}>
        Plugins
        <Typography sx={{ fontSize: 11, color: fog[300] }}>
          Claude Code plugins — skills, agents, hooks and MCP servers your agents
          can use. Installed through the CLI, so a plain `claude` session sees
          them too.
        </Typography>
        <Tabs
          value={tab}
          onChange={(_, value) => setTab(value)}
          sx={{ mt: 1, minHeight: 36, "& .MuiTab-root": { minHeight: 36, fontSize: 12 } }}
        >
          <Tab label={`Browse (${catalog?.available.length ?? 0})`} />
          <Tab label={`Installed (${catalog?.installed.length ?? 0})`} />
          <Tab label={`Marketplaces (${catalog?.marketplaces.length ?? 0})`} />
        </Tabs>
      </DialogTitle>

      <DialogContent dividers sx={{ borderColor: ink[600], minHeight: 420 }}>
        {!catalog && !error && (
          <Stack spacing={2} sx={{ py: 6, alignItems: "center" }}>
            <CircularProgress size={22} />
            <Typography sx={{ fontSize: 12, color: fog[300] }}>
              Reading the plugin catalog…
            </Typography>
          </Stack>
        )}

        {error && (
          <Alert severity="error" sx={{ fontSize: 12, mb: 2 }}>
            {error}
          </Alert>
        )}
        {notice && (
          <Alert severity="success" sx={{ fontSize: 12, mb: 2 }}>
            {notice}
          </Alert>
        )}

        {catalog && tab === 0 && (
          <>
            <Stack direction="row" spacing={1.5} sx={{ mb: 2, alignItems: "center" }}>
              <TextField
                size="small"
                fullWidth
                autoFocus
                placeholder="Search plugins by name or description"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setLimit(PAGE);
                }}
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchRoundedIcon sx={{ fontSize: 17, color: fog[300] }} />
                      </InputAdornment>
                    ),
                  },
                }}
              />
              <FormControl size="small" sx={{ minWidth: 130 }}>
                <InputLabel>Scope</InputLabel>
                <Select
                  label="Scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  {SCOPES.map((s) => (
                    <MenuItem key={s} value={s} sx={{ fontSize: 13 }}>
                      {s}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Tooltip title="Reload catalog">
                <IconButton size="small" onClick={() => void refresh()}>
                  <RefreshRoundedIcon sx={{ fontSize: 17 }} />
                </IconButton>
              </Tooltip>
            </Stack>

            {scope === "project" && !cwd && (
              <Alert severity="warning" sx={{ fontSize: 12, mb: 2 }}>
                This project has no working folder, so a project-scope install has
                nowhere to go. Set one in project settings, or use user scope.
              </Alert>
            )}

            <Typography sx={{ fontSize: 11, color: fog[300], mb: 1 }}>
              {matches.length} match{matches.length === 1 ? "" : "es"}
            </Typography>

            <Stack spacing={1}>
              {matches.slice(0, limit).map((plugin) => (
                <PluginRow
                  key={plugin.pluginId}
                  plugin={plugin}
                  installed={installedIds.has(plugin.pluginId)}
                  busy={busyId === plugin.pluginId}
                  onInstall={() =>
                    void act(
                      plugin.pluginId,
                      () => pluginInstall(plugin.pluginId, scope, cwd),
                      `Installed ${plugin.name}. Restart a session to load it.`,
                    )
                  }
                  onRemove={() =>
                    void act(
                      plugin.pluginId,
                      () => pluginUninstall(plugin.pluginId, cwd),
                      `Removed ${plugin.name}.`,
                    )
                  }
                />
              ))}
            </Stack>

            {matches.length > limit && (
              <Button
                fullWidth
                size="small"
                sx={{ mt: 1.5 }}
                onClick={() => setLimit((n) => n + PAGE)}
              >
                Show {Math.min(PAGE, matches.length - limit)} more
              </Button>
            )}
          </>
        )}

        {catalog && tab === 1 && (
          <Stack spacing={1}>
            {catalog.installed.length === 0 && (
              <Typography sx={{ fontSize: 12, color: fog[300] }}>
                Nothing installed yet.
              </Typography>
            )}
            {catalog.installed.map((plugin) => (
              <Box
                key={plugin.id}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1.5,
                  p: 1.5,
                  borderRadius: "10px",
                  border: `1px solid ${ink[600]}`,
                  backgroundColor: ink[700],
                }}
              >
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 500 }}>
                    {plugin.id}
                  </Typography>
                  <Typography sx={{ fontSize: 11, color: fog[300] }}>
                    {plugin.scope} scope · version {plugin.version}
                  </Typography>
                </Box>
                <Tooltip title={plugin.enabled ? "Enabled" : "Disabled"}>
                  <Switch
                    size="small"
                    checked={plugin.enabled}
                    disabled={busyId === plugin.id}
                    onChange={(e) =>
                      void act(
                        plugin.id,
                        () => pluginSetEnabled(plugin.id, e.target.checked, cwd),
                        `${plugin.id} ${e.target.checked ? "enabled" : "disabled"}.`,
                      )
                    }
                  />
                </Tooltip>
                <Tooltip title="Update">
                  <IconButton
                    size="small"
                    disabled={busyId === plugin.id}
                    onClick={() =>
                      void act(
                        plugin.id,
                        () => pluginUpdate(plugin.id, cwd),
                        `${plugin.id} updated.`,
                      )
                    }
                  >
                    <UpdateRoundedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Uninstall">
                  <IconButton
                    size="small"
                    color="error"
                    disabled={busyId === plugin.id}
                    onClick={() =>
                      void act(
                        plugin.id,
                        () => pluginUninstall(plugin.id, cwd),
                        `${plugin.id} removed.`,
                      )
                    }
                  >
                    <DeleteOutlineRoundedIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
          </Stack>
        )}

        {catalog && tab === 2 && (
          <>
            <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
              <TextField
                size="small"
                fullWidth
                label="Add a marketplace"
                placeholder="owner/repo, a git URL, or a local path"
                value={newMarketplace}
                onChange={(e) => setNewMarketplace(e.target.value)}
              />
              <Button
                size="small"
                variant="contained"
                disabled={!newMarketplace.trim() || busyId === "marketplace"}
                onClick={() =>
                  void act(
                    "marketplace",
                    async () => {
                      const result = await marketplaceAdd(newMarketplace.trim());
                      setNewMarketplace("");
                      return result;
                    },
                    "Marketplace added.",
                  )
                }
              >
                Add
              </Button>
            </Stack>
            <Divider sx={{ borderColor: ink[600], mb: 2 }} />
            <Stack spacing={1}>
              {catalog.marketplaces.map((market) => (
                <Box
                  key={market.name}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1.5,
                    p: 1.5,
                    borderRadius: "10px",
                    border: `1px solid ${ink[600]}`,
                    backgroundColor: ink[700],
                  }}
                >
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography sx={{ fontSize: 13, fontWeight: 500 }}>
                      {market.name}
                    </Typography>
                    <Typography
                      sx={{ fontSize: 11, color: fog[300], fontFamily: "var(--font-mono)" }}
                    >
                      {market.repo ?? market.source}
                    </Typography>
                  </Box>
                  <Tooltip title="Remove marketplace">
                    <IconButton
                      size="small"
                      color="error"
                      disabled={busyId === market.name}
                      onClick={() =>
                        void act(
                          market.name,
                          () => marketplaceRemove(market.name),
                          `${market.name} removed.`,
                        )
                      }
                    >
                      <DeleteOutlineRoundedIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                </Box>
              ))}
            </Stack>
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Typography sx={{ fontSize: 11, color: fog[300], flex: 1 }}>
          A newly installed plugin loads on the agent's next session.
        </Typography>
        <Button size="small" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PluginRow({
  plugin,
  installed,
  busy,
  onInstall,
  onRemove,
}: {
  plugin: AvailablePlugin;
  installed: boolean;
  busy: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: 1.5,
        p: 1.5,
        borderRadius: "10px",
        border: `1px solid ${ink[600]}`,
        backgroundColor: ink[700],
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.5 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{plugin.name}</Typography>
          <Chip
            size="small"
            label={plugin.marketplaceName}
            sx={{ bgcolor: ink[600], height: 18, "& .MuiChip-label": { fontSize: 10 } }}
          />
          {plugin.installCount > 0 && (
            <Typography sx={{ fontSize: 10, color: fog[300] }}>
              {plugin.installCount.toLocaleString()} installs
            </Typography>
          )}
        </Stack>
        <Typography
          sx={{
            fontSize: 11,
            color: fog[300],
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {plugin.description}
        </Typography>
      </Box>

      {installed ? (
        <Button size="small" color="inherit" disabled={busy} onClick={onRemove}>
          {busy ? "…" : "Remove"}
        </Button>
      ) : (
        <Button size="small" variant="contained" disabled={busy} onClick={onInstall}>
          {busy ? "…" : "Install"}
        </Button>
      )}
    </Box>
  );
}
