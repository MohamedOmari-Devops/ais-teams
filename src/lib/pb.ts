import PocketBase from "pocketbase";

/**
 * PocketBase runs in Docker under WSL. The desktop app reaches it on
 * localhost; a phone must use the LAN address of the Windows host, so the URL
 * is configurable at build time and overridable at runtime (stored in
 * localStorage by the login screen).
 */
const FALLBACK_URL = "http://127.0.0.1:8090";
const URL_KEY = "ais-teams.pb-url";

export function pbUrl(): string {
  const stored =
    typeof localStorage !== "undefined" ? localStorage.getItem(URL_KEY) : null;
  return stored || import.meta.env.VITE_PB_URL || FALLBACK_URL;
}

export function setPbUrl(url: string) {
  localStorage.setItem(URL_KEY, url.replace(/\/+$/, ""));
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
