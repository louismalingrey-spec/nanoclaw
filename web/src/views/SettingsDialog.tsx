import { useEffect, useState } from "react";
import type { NanoClawEngine } from "../engine";
import type { Agent } from "../protocol";

type Theme = "light" | "dark" | "system";

export function SettingsDialog({
  engine,
  agents,
  userId,
  theme,
  onChangeTheme,
  onClose,
  onSignOut,
}: {
  engine: NanoClawEngine;
  agents: Agent[];
  userId: string | null;
  theme: Theme;
  onChangeTheme: (t: Theme) => void;
  onClose: () => void;
  onSignOut: () => void;
}) {
  const [statuses, setStatuses] = useState<Map<string, { running: number; total: number }>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      agents.map((a) =>
        engine
          .agentStatus(a.id)
          .then((s) => ({ id: a.id, running: s.running_count, total: s.session_count }))
          .catch(() => ({ id: a.id, running: 0, total: 0 })),
      ),
    ).then((rows) => {
      if (cancelled) return;
      const m = new Map<string, { running: number; total: number }>();
      for (const r of rows) m.set(r.id, { running: r.running, total: r.total });
      setStatuses(m);
    });
    return () => {
      cancelled = true;
    };
  }, [engine, agents]);

  const restart = async (id: string) => {
    setBusy(id);
    try {
      await engine.restartContainers(id);
      const s = await engine.agentStatus(id);
      setStatuses((prev) => new Map(prev).set(id, { running: s.running_count, total: s.session_count }));
    } catch (err) {
      alert(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 20 }} />
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 480,
          maxHeight: "85vh",
          background: "var(--ncl-surface)",
          color: "var(--ncl-fg)",
          border: "1px solid var(--ncl-border)",
          borderRadius: 12,
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          zIndex: 21,
        }}
      >
        <header
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--ncl-border)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>Settings</div>
          <button
            onClick={onClose}
            style={{
              border: "1px solid var(--ncl-border)",
              background: "transparent",
              color: "inherit",
              borderRadius: 6,
              width: 28,
              height: 28,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </header>

        <div style={{ flex: 1, overflow: "auto", padding: 18, fontSize: 13 }}>
          <Section title="Account">
            <Row label="Signed in as">
              <code style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>{userId ?? "—"}</code>
            </Row>
            <Row label="Token">
              <button onClick={onSignOut} style={btnDanger}>
                Sign out
              </button>
            </Row>
          </Section>

          <Section title="Appearance">
            <Row label="Theme">
              <div style={{ display: "flex", gap: 6 }}>
                {(["light", "dark", "system"] as Theme[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => onChangeTheme(t)}
                    style={{
                      ...btn,
                      background: theme === t ? "var(--ncl-accent-bg)" : "var(--ncl-bg)",
                      borderColor: theme === t ? "var(--ncl-accent)" : "var(--ncl-border)",
                      color: theme === t ? "var(--ncl-accent-fg)" : "inherit",
                      fontWeight: theme === t ? 600 : 400,
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </Row>
          </Section>

          <Section title="Agents">
            {agents.length === 0 ? (
              <div style={{ color: "var(--ncl-faint)" }}>No agents.</div>
            ) : (
              agents.map((a) => {
                const s = statuses.get(a.id);
                const running = s?.running ?? 0;
                const total = s?.total ?? 0;
                return (
                  <div
                    key={a.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "8px 10px",
                      margin: "4px 0",
                      borderRadius: 8,
                      border: "1px solid var(--ncl-border)",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>{a.name}</div>
                      <div style={{ fontSize: 11, color: "var(--ncl-muted)" }}>
                        {total} session{total === 1 ? "" : "s"} · {running > 0 ? `${running} running` : "idle"}
                      </div>
                    </div>
                    <button
                      onClick={() => void restart(a.id)}
                      disabled={busy === a.id || running === 0}
                      title={running === 0 ? "No running containers to restart" : "Kill running containers"}
                      style={{ ...btn, opacity: running === 0 ? 0.4 : 1 }}
                    >
                      {busy === a.id ? "…" : "Restart"}
                    </button>
                  </div>
                );
              })
            )}
          </Section>

          <Section title="About">
            <Row label="NanoClaw OS">
              <span style={{ fontSize: 12, color: "var(--ncl-muted)" }}>web workspace</span>
            </Row>
          </Section>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--ncl-faint)",
          margin: "0 0 8px",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "6px 0",
        borderBottom: "1px solid var(--ncl-border-soft)",
      }}
    >
      <div style={{ flex: 1, color: "var(--ncl-muted)" }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

const btn: React.CSSProperties = {
  border: "1px solid var(--ncl-border)",
  background: "var(--ncl-bg)",
  color: "inherit",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const btnDanger: React.CSSProperties = {
  ...btn,
  borderColor: "#fecaca",
  color: "#991b1b",
};
