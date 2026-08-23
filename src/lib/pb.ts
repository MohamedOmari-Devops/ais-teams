import PocketBase from "pocketbase";

/**
 * PocketBase runs in Docker under WSL. The desktop app reaches it on
 * localhost; a phone must use the LAN address of the Windows host, so the URL
 * is configurable at build time and overridable at runtime (stored in
 * localStorage by the login screen).
 */
const FALLBACK_URL = "http://127.0.0.1:8090";
const URL_KEY = "ais-teams.pb-url";

/**
 * The address this build ships with: `VITE_PB_URL` from `.env` / `.env.local`.
 *
 * This is what everyone gets unless they deliberately point the app somewhere
 * else, which is why the login screen keeps the URL field hidden by default.
 */
export function defaultPbUrl(): string {
  return import.meta.env.VITE_PB_URL || FALLBACK_URL;
}

const storedPbUrl = (): string | null =>
  typeof localStorage !== "undefined" ? localStorage.getItem(URL_KEY) : null;

export function pbUrl(): string {
  return storedPbUrl() || defaultPbUrl();
}

/** True when this device is pointed at a server other than the build default. */
export function usingCustomPbUrl(): boolean {
  const stored = storedPbUrl();
  return Boolean(stored) && stored !== defaultPbUrl();
}

export function setPbUrl(url: string) {
  const clean = url.replace(/\/+$/, "");
  // Storing the default would silently pin this device to today's value, so a
  // later change in .env would not reach it. Clear the override instead.
  if (!clean || clean === defaultPbUrl()) localStorage.removeItem(URL_KEY);
  else localStorage.setItem(URL_KEY, clean);
  pb.baseURL = pbUrl();
}

/** Forget the override and go back to the address from `.env`. */
export function resetPbUrl() {
  localStorage.removeItem(URL_KEY);
  pb.baseURL = pbUrl();
}

export const pb = new PocketBase(pbUrl());

// Long-lived realtime subscriptions plus overlapping list() calls trip
// PocketBase's default auto-cancellation; requests here are cheap and idempotent.
pb.autoCancellation(false);

export const isAuthed = () => pb.authStore.isValid;
export const currentUserId = () => pb.authStore.record?.id ?? "";

export async function login(email: string, password: string) {
  return pb.collection("users").authWithPassword(email, password);
}

export async function signup(email: string, password: string, name: string) {
  await pb.collection("users").create({
    email,
    password,
    passwordConfirm: password,
    name,
  });
  return login(email, password);
}

export function logout() {
  pb.authStore.clear();
}

/** True when PocketBase answers its health endpoint. */
export async function pbHealthy(): Promise<boolean> {
  try {
    await pb.health.check();
    return true;
  } catch {
    return false;
  }
}
