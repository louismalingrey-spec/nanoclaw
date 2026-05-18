import { useEffect, useRef, useState } from "react";

import type { NanoClawEngine } from "../engine";
import type { ChatFinalEvent, HistoryMessage, SessionPreview } from "../protocol";

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  channel?: string | null;
  sender?: string | null;
}

function hydrate(messages: HistoryMessage[]): UiMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    timestamp: m.timestamp,
    channel: m.channel_type,
    sender: m.sender,
  }));
}

/** Typing indicator stays visible for this long after the last typing
 *  tick. The host re-fires every ~4s while the agent is busy, so 6.5s
 *  is the floor below which we'd flicker. */
const TYPING_TIMEOUT_MS = 6_500;

export function Thread({
  engine,
  agentId,
  agentName,
  sessionId,
  sessionMeta,
}: {
  engine: NanoClawEngine;
  agentId: string;
  agentName: string;
  /** `null` = aggregated history across every session of this agent. */
  sessionId: string | null;
  /** Preview row for the currently-selected session. `null` for "All". */
  sessionMeta: SessionPreview | null;
}) {
  // Replying to a non-web session would need real cross-channel routing
  // (push a slack reply via slack adapter etc.) — out of scope here, so
  // we make the composer read-only with an explanation.
  const composerEnabled =
    !sessionMeta || sessionMeta.channel_type === "web" || sessionMeta.channel_type === null;

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load history + subscribe to outbound stream whenever (agent, session)
  // changes. session_id set → that single thread; null → aggregated.
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setTyping(false);
    void (async () => {
      try {
        const history = await engine.history(agentId, {
          limit: 200,
          ...(sessionId ? { sessionId } : {}),
        });
        if (cancelled) return;
        setMessages(hydrate(history));
        await engine.subscribe(agentId).catch(() => {});
      } catch (err) {
        console.warn("Thread: history failed", err);
      }
    })();

    const off = engine.on("chat.final", (evt: ChatFinalEvent) => {
      if (evt.agent_group_id !== agentId) return;
      // Don't append web replies to a Slack thread view — the user is
      // browsing history, not engaging in that thread from here.
      if (sessionMeta && sessionMeta.channel_type && sessionMeta.channel_type !== "web") return;
      const c = evt.content as Record<string, unknown> | string | undefined;
      const text = typeof c === "string" ? c : typeof c?.text === "string" ? (c.text as string) : "";
      const id = `out-${evt.ts}-${Math.random().toString(36).slice(2, 6)}`;
      setMessages((prev) => [
        ...prev,
        { id, role: "assistant", text, timestamp: evt.ts },
      ]);
      setTyping(false);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    });

    const offTyping = engine.on("chat.typing", (evt) => {
      if (evt.agent_group_id !== agentId) return;
      setTyping(true);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => setTyping(false), TYPING_TIMEOUT_MS);
    });

    return () => {
      cancelled = true;
      off();
      offTyping();
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [engine, agentId, sessionId, sessionMeta]);

  // Autoscroll on new message.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setSending(true);
    const optimistic: UiMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      await engine.send(agentId, text);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          text: `(send failed: ${err instanceof Error ? err.message : String(err)})`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header style={{ padding: "12px 20px", borderBottom: "1px solid var(--ncl-border)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontWeight: 600 }}>{agentName}</div>
          {sessionMeta?.channel_type && sessionMeta.channel_type !== "web" && (
            <span
              style={{
                fontSize: 10,
                color: "var(--ncl-muted)",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                padding: "1px 6px",
                border: "1px solid var(--ncl-border)",
                borderRadius: 4,
              }}
            >
              from {sessionMeta.channel_type}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--ncl-faint)",
            fontFamily: "ui-monospace, Menlo, monospace",
          }}
        >
          {sessionMeta ? sessionMeta.title : `${agentId} · aggregated history`}
        </div>
      </header>

      <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: "20px 20px 8px" }}>
        {messages.length === 0 ? (
          <EmptyThread agentName={agentName} />
        ) : (
          messages.map((m) => <MessageRow key={m.id} m={m} />)
        )}
        {(sending || typing) && <Typing label={typing ? "thinking…" : ""} />}
      </div>

      <div style={{ padding: 16, borderTop: "1px solid var(--ncl-border)", background: "var(--ncl-bg-soft)" }}>
        {!composerEnabled ? (
          <div
            style={{
              fontSize: 12,
              color: "var(--ncl-muted)",
              textAlign: "center",
              padding: "10px 12px",
              border: "1px dashed var(--ncl-border)",
              borderRadius: 8,
            }}
          >
            Read-only — this conversation originated from{" "}
            <strong>{sessionMeta?.channel_type}</strong>. Open the workspace's own thread (or "All
            conversations") to type a new message.
          </div>
        ) : (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Message ${agentName}…`}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "10px 12px",
              border: "1px solid var(--ncl-border)",
              borderRadius: 8,
              resize: "none",
              fontSize: 13,
              fontFamily: "inherit",
              outline: "none",
              background: "var(--ncl-surface)",
              color: "var(--ncl-fg)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function EmptyThread({ agentName }: { agentName: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "var(--ncl-muted)",
        textAlign: "center",
        padding: 20,
      }}
    >
      <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.6 }}>👋</div>
      <div style={{ fontSize: 14, fontWeight: 500, color: "var(--ncl-fg)", marginBottom: 6 }}>
        Start a conversation with {agentName}
      </div>
      <div style={{ fontSize: 12, maxWidth: 320, lineHeight: 1.5 }}>
        Replies appear here in real time. Pick a past conversation from the sidebar to read its history.
      </div>
    </div>
  );
}

function MessageRow({ m }: { m: UiMessage }) {
  const isUser = m.role === "user";
  return (
    <div
      style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 12 }}
    >
      <div style={{ maxWidth: "75%", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 11, color: "var(--ncl-faint)", textAlign: isUser ? "right" : "left" }}>
          {isUser ? m.sender ?? "You" : "Agent"}
          {m.channel && m.channel !== "web" && (
            <span style={{ marginLeft: 6, opacity: 0.7 }}>· {m.channel}</span>
          )}
        </div>
        <div
          style={{
            background: isUser ? "var(--ncl-user-bg)" : "var(--ncl-assistant-bg)",
            color: isUser ? "var(--ncl-user-fg)" : "var(--ncl-fg)",
            padding: "10px 14px",
            borderRadius: 14,
            whiteSpace: "pre-wrap",
            fontSize: 13.5,
            lineHeight: 1.5,
          }}
        >
          {m.text || "(empty)"}
        </div>
      </div>
    </div>
  );
}

function Typing({ label }: { label: string }) {
  return (
    <div
      style={{ display: "flex", justifyContent: "flex-start", marginBottom: 12, alignItems: "center", gap: 8 }}
    >
      <div style={{ background: "var(--ncl-assistant-bg)", padding: "10px 14px", borderRadius: 14 }}>
        <Dot delay={0} /> <Dot delay={150} /> <Dot delay={300} />
      </div>
      {label && <span style={{ fontSize: 11, color: "var(--ncl-faint)" }}>{label}</span>}
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: 3,
        background: "var(--ncl-faint)",
        margin: "0 1px",
        verticalAlign: "middle",
        animation: `nclw-dot 1s ease-in-out ${delay}ms infinite`,
      }}
    />
  );
}
