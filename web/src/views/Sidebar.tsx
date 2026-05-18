import type { Agent, SessionPreview } from "../protocol";
import type { ConnectionState } from "../engine";
import { ConversationsSection } from "./ConversationsSection";

export function Sidebar({
  agents,
  activeAgent,
  onSelect,
  sessions,
  activeSession,
  onSelectSession,
  state,
  userId,
  onLogout,
}: {
  agents: Agent[];
  activeAgent: string | null;
  onSelect: (id: string) => void;
  sessions: SessionPreview[];
  activeSession: string | null;
  onSelectSession: (sessionId: string | null) => void;
  state: ConnectionState;
  userId: string | null;
  onLogout: () => void;
}) {
  return (
    <aside
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--ncl-bg-soft)",
        padding: 12,
        gap: 4,
        overflow: "auto",
        color: "var(--ncl-fg)",
      }}
    >
      <header style={{ padding: "4px 8px 12px" }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>NanoClaw OS</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 6,
            fontSize: 11,
            color: "var(--ncl-muted)",
          }}
        >
          <StateDot state={state} />
          <span>{stateLabel(state)}</span>
          {userId && (
            <span style={{ marginLeft: "auto", fontFamily: "ui-monospace, Menlo, monospace" }}>{userId}</span>
          )}
        </div>
      </header>

      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--ncl-faint)",
          padding: "4px 8px",
        }}
      >
        Agents
      </div>
      {agents.length === 0 ? (
        <div style={{ padding: "4px 8px", fontSize: 12, color: "var(--ncl-faint)" }}>No agents.</div>
      ) : (
        agents.map((a) => {
          const active = a.id === activeAgent;
          return (
            <button
              key={a.id}
              onClick={() => onSelect(a.id)}
              style={{
                textAlign: "left",
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid " + (active ? "var(--ncl-accent)" : "transparent"),
                background: active ? "var(--ncl-accent-bg)" : "transparent",
                cursor: "pointer",
                fontSize: 13,
                color: "inherit",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span style={{ fontWeight: 500 }}>{a.name}</span>
              <span style={{ fontSize: 11, color: "var(--ncl-muted)" }}>
                {a.sessions} session{a.sessions === 1 ? "" : "s"}
                {a.agent_provider && a.agent_provider !== "claude" && <> · {a.agent_provider}</>}
              </span>
            </button>
          );
        })
      )}

      {activeAgent && (
        <ConversationsSection
          sessions={sessions}
          activeSessionId={activeSession}
          onSelect={onSelectSession}
        />
      )}

      <div style={{ marginTop: "auto", padding: "8px 4px 0" }}>
        <button
          onClick={onLogout}
          style={{
            width: "100%",
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid var(--ncl-border)",
            background: "var(--ncl-surface)",
            color: "var(--ncl-muted)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

function StateDot({ state }: { state: ConnectionState }) {
  const color =
    state === "authed"
      ? "#10b981"
      : state === "connecting"
        ? "#f59e0b"
        : state === "auth-failed"
          ? "#ef4444"
          : "#9ca3af";
  return (
    <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: "inline-block" }} />
  );
}

function stateLabel(s: ConnectionState): string {
  switch (s) {
    case "authed":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "auth-failed":
      return "Auth failed";
    case "disconnected":
      return "Disconnected";
    default:
      return "Idle";
  }
}
