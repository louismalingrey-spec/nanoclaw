/**
 * Persisted client settings — token + user_id + visual prefs.
 *
 * Token storage uses localStorage. We don't ship any iframe surface
 * so the same-origin scope is enough; the token itself is opaque to
 * the host (it's matched against `web_sessions`).
 */
const KEY = "nanoclaw-os:settings";

export interface Settings {
  token: string | null;
  userId: string | null;
  /** "system" follows the OS prefers-color-scheme media query. */
  theme?: "light" | "dark" | "system";
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { token: null, userId: null, theme: "system" };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      token: typeof parsed.token === "string" ? parsed.token : null,
      userId: typeof parsed.userId === "string" ? parsed.userId : null,
      theme:
        parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system"
          ? parsed.theme
          : "system",
    };
  } catch {
    return { token: null, userId: null, theme: "system" };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Quota exceeded or disabled storage — non-fatal for this app.
  }
}

export function clearSettings(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // swallow
  }
}
