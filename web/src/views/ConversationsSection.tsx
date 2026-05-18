import type { SessionPreview } from "../protocol";

/**
 * Sidebar list of an agent's conversations — like Claude.ai's recent
 * sidebar. Each session = one conversation, sorted by recency.
 *
 * The first row is virtual ("All conversations") and maps to a `null`
 * sessionId upstream — the Thread reads aggregated history in that
 * mode. Clicking any other row filters the thread to that session's
 * messages alone.
 */
export function ConversationsSection({
  sessions,
  activeSessionId,
  onSelect,
}: {
  sessions: SessionPreview[];
  activeSessionId: string | null;
  onSelect: (sessionId: string | null) => void;
}) {
  return (
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
        Conversations
      </div>

      <button onClick={() => onSelect(null)} style={rowStyle(activeSessionId === null)}>
        <span style={{ fontWeight: 500 }}>All conversations</span>
        <span style={{ fontSize: 10, color: "var(--ncl-faint)" }}>aggregated timeline</span>
      </button>

      {sessions.length === 0 ? (
        <div style={{ padding: "4px 8px", fontSize: 12, color: "var(--ncl-faint)" }}>No sessions yet.</div>
      ) : (
        sessions.map((s) => {
          const active = s.id === activeSessionId;
          return (
            <button key={s.id} onClick={() => onSelect(s.id)} style={rowStyle(active)} title={s.title}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span
                  style={{
                    fontWeight: 500,
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.title || "(untitled)"}
                </span>
                {s.channel_type && s.channel_type !== "web" && (
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--ncl-faint)",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    {s.channel_type}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: "var(--ncl-faint)", marginTop: 2 }}>
                {relTime(s.last_at)} · {s.message_count} msg
              </div>
              {s.last_preview && (
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--ncl-muted)",
                    marginTop: 3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    lineHeight: 1.3,
                  }}
                >
                  {s.last_preview}
                </div>
              )}
            </button>
          );
        })
      )}
    </>
  );
}

function rowStyle(active: boolean): React.CSSProperties {
  return {
    textAlign: "left",
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid " + (active ? "var(--ncl-accent)" : "transparent"),
    background: active ? "var(--ncl-accent-bg)" : "transparent",
    cursor: "pointer",
    color: "inherit",
    fontSize: 12,
    display: "flex",
    flexDirection: "column",
    gap: 1,
    width: "100%",
  };
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return new Date(t).toLocaleDateString();
}
