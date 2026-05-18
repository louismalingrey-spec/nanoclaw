import { useEffect, useMemo, useState } from "react";

import { NanoClawEngine, type ConnectionState } from "./engine";
import { Login } from "./views/Login";
import { Sidebar } from "./views/Sidebar";
import { Thread } from "./views/Thread";
import { AppPanel } from "./views/AppPanel";
import { loadSettings, saveSettings, clearSettings, type Settings } from "./storage";
import type { Agent, AppSummary, SessionPreview } from "./protocol";

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

/** Resolve "light/dark/system" to a concrete theme, syncing `data-theme`
 *  on <html> so the CSS variables in styles.css take effect. */
function useResolvedTheme(theme: "light" | "dark" | "system" | undefined) {
  const [resolved, setResolved] = useState<"light" | "dark">(() => {
    if (theme === "dark") return "dark";
    if (theme === "light") return "light";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    if (theme === "dark") {
      setResolved("dark");
      return;
    }
    if (theme === "light") {
      setResolved("light");
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setResolved(mq.matches ? "dark" : "light");
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);
  return resolved;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [state, setState] = useState<ConnectionState>("idle");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionPreview[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [activeApp, setActiveApp] = useState<string | null>(null);
  useResolvedTheme(settings.theme);

  const engine = useMemo(() => {
    if (!settings.token) return null;
    return new NanoClawEngine(wsUrl(), settings.token);
  }, [settings.token]);

  // Connect lifecycle: open the socket once we have a token, tear it
  // down when the token clears. The `authed` event triggers the first
  // agents.list pull — we delay it until then so we have a user_id.
  useEffect(() => {
    if (!engine) return;
    const unsubs = [
      engine.on("state", setState),
      engine.on("authed", ({ user_id }) => {
        setSettings((prev) => {
          const next = { ...prev, userId: user_id };
          saveSettings(next);
          return next;
        });
        void engine.listAgents().then((a) => {
          setAgents(a);
          if (a.length > 0) setActiveAgent((prev) => prev ?? a[0].id);
        });
      }),
    ];
    engine.start();
    return () => {
      unsubs.forEach((u) => u());
      engine.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  // Per-agent state — sessions list. Reload whenever the active agent
  // changes, and default-pick the most recent session.
  useEffect(() => {
    if (!engine || !activeAgent) {
      setSessions([]);
      setApps([]);
      return;
    }
    let cancelled = false;
    const loadApps = () =>
      engine.listApps(activeAgent).then((a) => {
        if (!cancelled) setApps(a);
      });
    void engine.listSessions(activeAgent).then((s) => {
      if (cancelled) return;
      setSessions(s);
      setActiveSession((prev) => prev ?? (s.length > 0 ? s[0].id : null));
    });
    void loadApps();
    const off = engine.on("app.changed", () => void loadApps());
    return () => {
      cancelled = true;
      off();
    };
  }, [engine, activeAgent]);

  // Drop the per-agent session selection when switching agents so the
  // new agent's most-recent conversation loads instead of an unrelated
  // session id.
  useEffect(() => {
    setActiveSession(null);
    setActiveApp(null);
  }, [activeAgent]);

  if (!settings.token) {
    return (
      <Login
        onSave={(token) => {
          const next: Settings = { token, userId: null, theme: settings.theme ?? "system" };
          setSettings(next);
          saveSettings(next);
        }}
      />
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: activeApp ? "260px 1fr 1fr" : "260px 1fr",
        height: "100vh",
        background: "var(--ncl-bg)",
        color: "var(--ncl-fg)",
      }}
    >
      <Sidebar
        agents={agents}
        activeAgent={activeAgent}
        onSelect={setActiveAgent}
        sessions={sessions}
        activeSession={activeSession}
        onSelectSession={setActiveSession}
        apps={apps}
        activeApp={activeApp}
        onOpenApp={setActiveApp}
        state={state}
        userId={settings.userId}
        onLogout={() => {
          clearSettings();
          setSettings({ token: null, userId: null, theme: settings.theme });
          setAgents([]);
          setActiveAgent(null);
          setSessions([]);
          setActiveSession(null);
          setApps([]);
          setActiveApp(null);
        }}
      />
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--ncl-border)",
          overflow: "hidden",
        }}
      >
        {engine && activeAgent ? (
          <Thread
            engine={engine}
            agentId={activeAgent}
            agentName={agents.find((a) => a.id === activeAgent)?.name ?? activeAgent}
            sessionId={activeSession}
            sessionMeta={activeSession ? sessions.find((s) => s.id === activeSession) ?? null : null}
          />
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--ncl-faint)",
            }}
          >
            {agents.length === 0 ? "No agents available for this user." : "Select an agent on the left."}
          </div>
        )}
      </main>
      {engine && activeApp && (
        <AppPanel engine={engine} appId={activeApp} onClose={() => setActiveApp(null)} />
      )}
    </div>
  );
}
