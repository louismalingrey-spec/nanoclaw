import type { Agent, AppSummary, ArtifactSummary, CronEntry, SessionPreview } from "../protocol";
import type { ConnectionState } from "../engine";
import { ConversationsSection } from "./ConversationsSection";
import { SchedulesSection } from "./SchedulesSection";

export function Sidebar({
  agents,
  activeAgent,
  onSelect,
  sessions,
  activeSession,
  onSelectSession,
  apps,
  activeApp,
  onOpenApp,
  artifacts,
  activeArtifact,
  onOpenArtifact,
  crons,
  unreadCount,
  onOpenNotifications,
  onOpenSettings,
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
  apps: AppSummary[];
  activeApp: string | null;
  onOpenApp: (id: string) => void;
  artifacts: ArtifactSummary[];
  activeArtifact: string | null;
  onOpenArtifact: (id: string) => void;
  crons: CronEntry[];
  unreadCount: number;
  onOpenNotifications: () => void;
  onOpenSettings: () => void;
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
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>NanoClaw OS</div>
          <button
            onClick={onOpenNotifications}
            title={
              unreadCount > 0
                ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
                : "Notifications"
            }
            style={{
              position: "relative",
              border: "1px solid var(--ncl-border)",
              background: "var(--ncl-surface)",
              color: "inherit",
              borderRadius: 6,
              width: 28,
              height: 28,
              cursor: "pointer",
              padding: 0,
              lineHeight: 1,
              fontSize: 14,
            }}
          >
            🔔
            {unreadCount > 0 && (
              <span
                style={{
                  position: "absolute",
                  top: -4,
                  right: -4,
                  minWidth: 14,
                  height: 14,
                  padding: "0 3px",
                  background: "#ef4444",
                  color: "white",
                  borderRadius: 7,
                  fontSize: 9,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
          <button
            onClick={onOpenSettings}
            title="Settings"
            style={{
              border: "1px solid var(--ncl-border)",
              background: "var(--ncl-surface)",
              color: "inherit",
              borderRadius: 6,
              width: 28,
              height: 28,
              cursor: "pointer",
              padding: 0,
              lineHeight: 1,
              fontSize: 14,
            }}
          >
            ⚙
          </button>
        </div>
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

      {activeAgent && (
        <>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "var(--ncl-faint)",
              padding: "16px 8px 4px",
            }}
          >
            Apps
          </div>
          {apps.length === 0 ? (
            <div style={{ padding: "4px 8px", fontSize: 12, color: "var(--ncl-faint)" }}>None yet.</div>
          ) : (
            apps.map((a) => {
              const active = a.id === activeApp;
              return (
                <button
                  key={a.id}
                  onClick={() => onOpenApp(a.id)}
                  style={{
                    textAlign: "left",
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid " + (active ? "var(--ncl-accent)" : "transparent"),
                    background: active ? "var(--ncl-accent-bg)" : "transparent",
                    cursor: "pointer",
                    fontSize: 12,
                    color: "inherit",
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{a.name}</span>
                  <span style={{ fontSize: 10, color: "var(--ncl-faint)" }}>{relTime(a.updated_at)}</span>
                </button>
              );
            })
          )}
        </>
      )}

      {activeAgent && (
        <>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "var(--ncl-faint)",
              padding: "16px 8px 4px",
            }}
          >
            Artifacts
          </div>
          {artifacts.length === 0 ? (
            <div style={{ padding: "4px 8px", fontSize: 12, color: "var(--ncl-faint)" }}>None yet.</div>
          ) : (
            artifacts.map((a) => {
              const active = a.id === activeArtifact;
              return (
                <button
                  key={a.id}
                  onClick={() => onOpenArtifact(a.id)}
                  style={{
                    textAlign: "left",
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid " + (active ? "var(--ncl-accent)" : "transparent"),
                    background: active ? "var(--ncl-accent-bg)" : "transparent",
                    cursor: "pointer",
                    fontSize: 12,
                    color: "inherit",
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{a.name}</span>
                  <span style={{ fontSize: 10, color: "var(--ncl-faint)" }}>{relTime(a.updated_at)}</span>
                </button>
              );
            })
          )}
          <SchedulesSection crons={crons} />
        </>
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

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
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
