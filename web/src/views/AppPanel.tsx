import { useEffect, useMemo, useState } from "react";
import { Renderer } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui";

import type { NanoClawEngine } from "../engine";
import type { AppFull } from "../protocol";

/**
 * Right-side panel that loads a persisted OpenUI Lang app and renders
 * it with the full `openuiLibrary` (Query / Mutation / $state — the
 * runtime bits the chat-surface library excludes).
 *
 * The `sql` toolProvider proxies to db.query against the agent group's
 * sandbox DB. Apps Query for data with:
 *   metrics = Query("sql", { q: "SELECT ..." }, [defaults], refreshSeconds)
 *
 * The Renderer caches per (tool, args) and re-polls on its own timer.
 * When the host broadcasts `db.changed`, we bump `refreshKey` so the
 * Renderer remounts and re-runs everything immediately — cheap and
 * bulletproof.
 */
export function AppPanel({
  engine,
  appId,
  onClose,
}: {
  engine: NanoClawEngine;
  appId: string;
  onClose: () => void;
}) {
  const [app, setApp] = useState<AppFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [dbError, setDbError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setApp(null);
    setError(null);
    setDbError(null);
    void engine
      .getApp(appId)
      .then((a) => {
        if (!cancelled) setApp(a);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [engine, appId]);

  useEffect(() => {
    const offChanged = engine.on("db.changed", () => setRefreshKey((k) => k + 1));
    const offError = engine.on("db.error", (e) =>
      setDbError(`${e.message}\n${e.sql.slice(0, 200)}`),
    );
    return () => {
      offChanged();
      offError();
    };
  }, [engine]);

  // Tool provider: `sql` proxies to the host's db.query RPC.
  const toolProvider = useMemo(() => {
    if (!app) return null;
    return {
      sql: async (args: Record<string, unknown>) => {
        const q = typeof args.q === "string" ? args.q : "";
        if (!q) throw new Error("sql tool: missing `q` arg");
        const params = args.params as unknown[] | Record<string, unknown> | undefined;
        return await engine.dbQuery(app.agent_group_id, q, params);
      },
    };
  }, [engine, app]);

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
          <div style={{ fontWeight: 600, fontSize: 14 }}>{app?.name ?? "Loading…"}</div>
          {app && (
            <div
              style={{
                fontSize: 11,
                color: "var(--ncl-faint)",
                fontFamily: "ui-monospace, Menlo, monospace",
              }}
            >
              {app.id}
            </div>
          )}
        </div>
        <button
          onClick={() => setRefreshKey((k) => k + 1)}
          title="Re-run all queries"
          style={{
            border: "1px solid var(--ncl-border)",
            background: "var(--ncl-surface)",
            color: "inherit",
            borderRadius: 6,
            height: 28,
            padding: "0 10px",
            marginRight: 6,
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          ↻
        </button>
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
        ) : app ? (
          <Renderer
            key={refreshKey}
            response={app.code}
            library={openuiLibrary}
            toolProvider={toolProvider}
            onError={(errs) => console.warn("[app-panel] render errors", errs)}
          />
        ) : (
          <div style={{ color: "var(--ncl-faint)", fontSize: 13 }}>Loading…</div>
        )}
        {dbError && (
          <div
            style={{
              marginTop: 16,
              padding: 10,
              background: "#fef9c3",
              border: "1px solid #fef08a",
              borderRadius: 6,
              fontSize: 11,
              color: "#854d0e",
              whiteSpace: "pre-wrap",
            }}
          >
            <strong>DB write error:</strong>
            {"\n"}
            {dbError}
          </div>
        )}
      </div>
    </aside>
  );
}
