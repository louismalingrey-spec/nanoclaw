import { useEffect } from "react";
import type { NanoClawEngine } from "../engine";
import type { NotificationEntry } from "../protocol";

const KIND_COLOR: Record<string, { bg: string; border: string; fg: string }> = {
  info: { bg: "#eff6ff", border: "#bfdbfe", fg: "#1e40af" },
  success: { bg: "#ecfdf5", border: "#a7f3d0", fg: "#065f46" },
  warning: { bg: "#fef9c3", border: "#fde68a", fg: "#92400e" },
  error: { bg: "#fef2f2", border: "#fecaca", fg: "#991b1b" },
};

/**
 * Slide-in drawer listing the agent's recent notifications. Auto marks
 * all as read after 1.5s of dwell — same UX pattern as Gmail / Linear.
 */
export function NotificationsDrawer({
  engine,
  agentGroupId,
  notifications,
  onClose,
  onChange,
}: {
  engine: NanoClawEngine;
  agentGroupId: string;
  notifications: NotificationEntry[];
  onClose: () => void;
  onChange: () => void;
}) {
  useEffect(() => {
    if (notifications.every((n) => n.read_at !== null)) return;
    const t = setTimeout(() => {
      void engine
        .markAllNotificationsRead(agentGroupId)
        .then(() => onChange())
        .catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [engine, agentGroupId, notifications, onChange]);

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.2)", zIndex: 10 }}
      />
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          background: "var(--ncl-surface)",
          color: "var(--ncl-fg)",
          borderLeft: "1px solid var(--ncl-border)",
          boxShadow: "-8px 0 24px rgba(0,0,0,0.06)",
          display: "flex",
          flexDirection: "column",
          zIndex: 11,
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            padding: "14px 18px",
            borderBottom: "1px solid var(--ncl-border)",
          }}
        >
          <div style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>Notifications</div>
          <button
            onClick={onClose}
            style={{
              border: "1px solid var(--ncl-border)",
              background: "var(--ncl-surface)",
              color: "inherit",
              borderRadius: 6,
              width: 28,
              height: 28,
              cursor: "pointer",
              fontSize: 16,
            }}
          >
            ×
          </button>
        </header>
        <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
          {notifications.length === 0 ? (
            <div style={{ color: "var(--ncl-faint)", fontSize: 13, textAlign: "center", marginTop: 40 }}>
              Nothing here yet. Agents push notifications when long tasks finish or something needs your
              attention.
            </div>
          ) : (
            notifications.map((n) => {
              const c = KIND_COLOR[n.kind] ?? KIND_COLOR.info;
              const unread = !n.read_at;
              return (
                <div
                  key={n.id}
                  style={{
                    padding: "10px 12px",
                    margin: "8px 0",
                    borderRadius: 8,
                    border: `1px solid ${c.border}`,
                    background: c.bg,
                    position: "relative",
                  }}
                >
                  {unread && (
                    <span
                      style={{
                        position: "absolute",
                        top: 12,
                        right: 12,
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        background: c.fg,
                      }}
                    />
                  )}
                  <div style={{ fontWeight: 600, fontSize: 13, color: c.fg }}>{n.title}</div>
                  {n.body && (
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 12,
                        color: c.fg,
                        whiteSpace: "pre-wrap",
                        opacity: 0.85,
                      }}
                    >
                      {n.body}
                    </div>
                  )}
                  <div style={{ marginTop: 6, fontSize: 10, color: c.fg, opacity: 0.6 }}>
                    {new Date(n.created_at).toLocaleString()}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
