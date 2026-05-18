import { useEffect, useState } from "react";

import type { NanoClawEngine } from "../engine";
import type { ArtifactFull } from "../protocol";

/**
 * Right-side panel for a persisted markdown artifact. Renders the body
 * as plain pre-wrap text — react-markdown / MarkDownRenderer would be
 * nicer but adds bundle weight; we can swap in later without changing
 * the surface.
 */
export function ArtifactPanel({
  engine,
  artifactId,
  onClose,
}: {
  engine: NanoClawEngine;
  artifactId: string;
  onClose: () => void;
}) {
  const [art, setArt] = useState<ArtifactFull | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setArt(null);
    setError(null);
    void engine
      .getArtifact(artifactId)
      .then((a) => {
        if (!cancelled) setArt(a);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [engine, artifactId]);

  // Hot-refresh on artifact.changed (only for this artifact's id).
  useEffect(() => {
    const off = engine.on("artifact.changed", (evt) => {
      if (evt.artifact_id === artifactId) {
        void engine.getArtifact(artifactId).then((a) => setArt(a)).catch(() => {});
      }
    });
    return off;
  }, [engine, artifactId]);

  return (
    <aside
      style={{
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--ncl-border)",
        background: "var(--ncl-bg-soft)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          padding: "12px 16px",
          borderBottom: "1px solid var(--ncl-border)",
          background: "var(--ncl-surface)",
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{art?.name ?? "Loading…"}</div>
          {art && (
            <div
              style={{
                fontSize: 11,
                color: "var(--ncl-faint)",
                fontFamily: "ui-monospace, Menlo, monospace",
              }}
            >
              {art.id} · {new Date(art.updated_at).toLocaleString()}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          title="Close"
          style={{
            border: "1px solid var(--ncl-border)",
            background: "var(--ncl-surface)",
            color: "inherit",
            borderRadius: 6,
            width: 28,
            height: 28,
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </header>

      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {error ? (
          <div
            style={{
              padding: 16,
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 8,
              color: "#991b1b",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        ) : art ? (
          <div
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 13.5,
              lineHeight: 1.55,
              color: "var(--ncl-fg)",
              fontFamily: "system-ui, -apple-system, sans-serif",
            }}
          >
            {art.content}
          </div>
        ) : (
          <div style={{ color: "var(--ncl-faint)", fontSize: 13 }}>Loading…</div>
        )}
      </div>
    </aside>
  );
}
