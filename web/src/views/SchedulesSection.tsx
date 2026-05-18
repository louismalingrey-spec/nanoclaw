import { useState } from "react";
import type { CronEntry } from "../protocol";

/**
 * Inline sidebar list of scheduled tasks for the active agent.
 * Click to expand a row and see the full prompt + recurrence.
 */
export function SchedulesSection({ crons }: { crons: CronEntry[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

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
        Schedules
      </div>
      {crons.length === 0 ? (
        <div style={{ padding: "4px 8px", fontSize: 12, color: "var(--ncl-faint)" }}>None active.</div>
      ) : (
        crons.map((c) => {
          const isExp = expanded === c.id;
          const prompt = c.prompt || c.script || "(no prompt)";
          const preview = prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt;
          return (
            <div
              key={c.id}
              style={{
                margin: "2px 0",
                borderRadius: 6,
                border: "1px solid " + (isExp ? "var(--ncl-border)" : "transparent"),
                background: isExp ? "var(--ncl-border-soft)" : "transparent",
                overflow: "hidden",
              }}
            >
              <button
                onClick={() => setExpanded(isExp ? null : c.id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 10px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  fontSize: 12,
                  color: "inherit",
                }}
              >
                <div style={{ fontWeight: 500 }}>{labelFor(c)}</div>
                <div style={{ fontSize: 10, color: "var(--ncl-muted)" }}>{nextRunLabel(c)}</div>
                {!isExp && (
                  <div style={{ fontSize: 11, color: "var(--ncl-muted)", marginTop: 2 }}>{preview}</div>
                )}
              </button>
              {isExp && (
                <div style={{ padding: "0 10px 10px", fontSize: 11, color: "var(--ncl-fg)" }}>
                  <div
                    style={{
                      whiteSpace: "pre-wrap",
                      fontFamily: c.script ? "ui-monospace, Menlo, monospace" : "inherit",
                    }}
                  >
                    {prompt}
                  </div>
                  {c.recurrence && (
                    <div style={{ marginTop: 8, fontSize: 10, opacity: 0.7 }}>
                      Recurrence: <code>{c.recurrence}</code>
                    </div>
                  )}
                  {c.status === "paused" && (
                    <div style={{ marginTop: 6, fontSize: 10, color: "#92400e", fontWeight: 500 }}>
                      ⏸ paused
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </>
  );
}

function labelFor(c: CronEntry): string {
  if (c.recurrence) return c.recurrence;
  if (c.process_after) return new Date(c.process_after).toLocaleString();
  return "(no schedule)";
}

function nextRunLabel(c: CronEntry): string {
  if (!c.process_after) return c.recurrence ? "next: pending" : "due now";
  const ts = Date.parse(c.process_after);
  if (!Number.isFinite(ts)) return c.process_after;
  const diff = (ts - Date.now()) / 1000;
  if (diff < 0) return "due now";
  if (diff < 60) return `in ${Math.round(diff)}s`;
  if (diff < 3600) return `in ${Math.round(diff / 60)}m`;
  if (diff < 86400) return `in ${Math.round(diff / 3600)}h`;
  return new Date(ts).toLocaleString();
}
