/**
 * NanoClawEngine — WebSocket client for the host's web channel.
 *
 * Auth-then-RPC protocol: `start()` opens the socket, sends the token,
 * waits for `auth-ok`. After that, callers use `request(method, params)`
 * for RPC and `on(event, handler)` for push events.
 *
 * Reconnects on close with exponential backoff (1s, 2s, 4s, capped at
 * 30s). After a successful auth the backoff resets. We DO NOT retry on
 * `auth-failed` — a bad token won't fix itself by waiting.
 */
import type {
  Agent,
  AppChangedEvent,
  AppFull,
  AppSummary,
  ArtifactChangedEvent,
  ArtifactFull,
  ArtifactSummary,
  ChatFinalEvent,
  ClientFrame,
  CronEntry,
  EventFrame,
  HistoryMessage,
  NotificationEntry,
  NotificationNewEvent,
  ServerFrame,
  SessionPreview,
} from "./protocol";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export type ConnectionState = "idle" | "connecting" | "authed" | "auth-failed" | "disconnected";

export interface EngineEvents {
  state: ConnectionState;
  authed: { user_id: string };
  "chat.final": ChatFinalEvent;
  "chat.typing": { agent_group_id: string; ts: string };
  "app.changed": AppChangedEvent;
  "artifact.changed": ArtifactChangedEvent;
  "notification.new": NotificationNewEvent;
  /** Sandbox DB rows changed for this agent group — refresh open Query()s. */
  "db.changed": { changes: number };
  /** Sandbox DB write failed on the host. Surfaced as a small warning. */
  "db.error": { sql: string; message: string };
  error: { code: string; message: string };
}

type Handler<K extends keyof EngineEvents> = (payload: EngineEvents[K]) => void;

export class NanoClawEngine {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private rpcCounter = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<keyof EngineEvents, Set<Handler<keyof EngineEvents>>>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private url: string,
    private token: string,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // swallow
      }
      this.ws = null;
    }
    this.setState("disconnected");
  }

  on<K extends keyof EngineEvents>(name: K, handler: Handler<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(handler as Handler<keyof EngineEvents>);
    return () => set!.delete(handler as Handler<keyof EngineEvents>);
  }

  getState(): ConnectionState {
    return this.state;
  }

  // ── Typed RPC convenience methods ─────────────────────────────────────

  async listAgents(): Promise<Agent[]> {
    const r = (await this.request("agents.list")) as { agents: Agent[] };
    return r.agents;
  }

  async listSessions(agentGroupId: string): Promise<SessionPreview[]> {
    const r = (await this.request("sessions.list", { agent_group_id: agentGroupId })) as {
      sessions: SessionPreview[];
    };
    return r.sessions;
  }

  async history(
    agentGroupId: string,
    opts: { limit?: number; sessionId?: string } = {},
  ): Promise<HistoryMessage[]> {
    const params: Record<string, unknown> = {
      agent_group_id: agentGroupId,
      limit: opts.limit ?? 200,
    };
    if (opts.sessionId) params.session_id = opts.sessionId;
    const r = (await this.request("chat.history", params)) as { messages: HistoryMessage[] };
    return r.messages;
  }

  async send(agentGroupId: string, text: string): Promise<void> {
    await this.request("chat.send", { agent_group_id: agentGroupId, text });
  }

  async subscribe(agentGroupId: string): Promise<void> {
    await this.request("chat.subscribe", { agent_group_id: agentGroupId });
  }

  async listApps(agentGroupId: string): Promise<AppSummary[]> {
    const r = (await this.request("apps.list", { agent_group_id: agentGroupId })) as { apps: AppSummary[] };
    return r.apps;
  }

  async getApp(id: string): Promise<AppFull> {
    return (await this.request("apps.get", { id })) as AppFull;
  }

  async listArtifacts(agentGroupId: string): Promise<ArtifactSummary[]> {
    const r = (await this.request("artifacts.list", { agent_group_id: agentGroupId })) as { artifacts: ArtifactSummary[] };
    return r.artifacts;
  }

  async getArtifact(id: string): Promise<ArtifactFull> {
    return (await this.request("artifacts.get", { id })) as ArtifactFull;
  }

  async listNotifications(agentGroupId: string): Promise<{ notifications: NotificationEntry[]; unread: number }> {
    return (await this.request("notifications.list", { agent_group_id: agentGroupId })) as {
      notifications: NotificationEntry[];
      unread: number;
    };
  }

  async markAllNotificationsRead(agentGroupId: string): Promise<void> {
    await this.request("notifications.mark_read", { agent_group_id: agentGroupId, all: true });
  }

  async listCrons(agentGroupId: string): Promise<CronEntry[]> {
    const r = (await this.request("crons.list", { agent_group_id: agentGroupId })) as { crons: CronEntry[] };
    return r.crons;
  }

  async agentStatus(agentGroupId: string): Promise<{ agent_group_id: string; session_count: number; running_count: number }> {
    return (await this.request("agent.status", { agent_group_id: agentGroupId })) as {
      agent_group_id: string;
      session_count: number;
      running_count: number;
    };
  }

  async restartContainers(agentGroupId: string): Promise<number> {
    const r = (await this.request("agent.restart_containers", { agent_group_id: agentGroupId })) as {
      restarted: number;
    };
    return r.restarted;
  }

  async dbQuery(
    agentGroupId: string,
    q: string,
    params?: unknown[] | Record<string, unknown>,
  ): Promise<unknown[]> {
    const r = (await this.request("db.query", { agent_group_id: agentGroupId, q, params })) as { rows: unknown[] };
    return r.rows;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private setState(s: ConnectionState): void {
    this.state = s;
    this.emit("state", s);
  }

  private emit<K extends keyof EngineEvents>(name: K, payload: EngineEvents[K]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const h of set) {
      try {
        (h as Handler<K>)(payload);
      } catch (err) {
        console.error("[engine] listener threw", err);
      }
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    // Close any prior socket cleanly before opening a new one. React
    // StrictMode double-mounts effects in dev, so without this guard
    // we'd end up with two concurrent WebSockets racing each other —
    // their onclose handlers would re-trigger reconnect and the engine
    // would flap.
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // swallow
      }
      this.ws = null;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      console.error("[engine] WebSocket constructor threw", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // Bind handlers that capture THIS ws and ignore events from stale
    // instances. Required because the browser fires onclose on any
    // dangling socket whose handlers we already moved on from.
    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({ type: "auth", token: this.token } satisfies ClientFrame));
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.handleMessage(typeof e.data === "string" ? e.data : "");
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return; // ignore stale close
      this.handleClose(e.code);
    };
    ws.onerror = (e) => {
      if (this.ws !== ws) return;
      console.warn("[engine] ws error", e);
    };
  }

  private handleMessage(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      console.warn("[engine] non-JSON frame");
      return;
    }

    if (frame.type === "auth-ok") {
      this.reconnectAttempt = 0;
      this.setState("authed");
      this.emit("authed", { user_id: frame.user_id });
      return;
    }

    if (frame.type === "res") {
      const slot = this.pending.get(frame.id);
      if (!slot) return;
      this.pending.delete(frame.id);
      if (frame.ok) slot.resolve(frame.payload);
      else slot.reject(new Error(frame.error?.message ?? "rpc-failed"));
      return;
    }

    if (frame.type === "event") {
      const evt = frame as EventFrame;
      if (evt.event === "chat.final") {
        this.emit("chat.final", evt.payload as ChatFinalEvent);
      } else if (evt.event === "chat.typing") {
        this.emit("chat.typing", evt.payload as { agent_group_id: string; ts: string });
      } else if (evt.event === "app.changed") {
        this.emit("app.changed", evt.payload as AppChangedEvent);
      } else if (evt.event === "artifact.changed") {
        this.emit("artifact.changed", evt.payload as ArtifactChangedEvent);
      } else if (evt.event === "notification.new") {
        this.emit("notification.new", evt.payload as NotificationNewEvent);
      } else if (evt.event === "db.changed") {
        this.emit("db.changed", evt.payload as { changes: number });
      } else if (evt.event === "db.error") {
        this.emit("db.error", evt.payload as { sql: string; message: string });
      } else if (evt.event === "error") {
        this.emit("error", evt.payload as { code: string; message: string });
      } else {
        // Unknown event — surface in console for the dev tools log.
        console.info("[engine] unhandled event", evt.event, evt.payload);
      }
      return;
    }
  }

  private handleClose(code: number): void {
    this.ws = null;
    // Reject any in-flight RPCs so callers don't hang forever.
    for (const slot of this.pending.values()) slot.reject(new Error("disconnected"));
    this.pending.clear();
    if (this.stopped) return;
    // 4001 (auth-required/auth-timeout) and 4003 (auth-failed) are
    // unrecoverable without intervention. Don't loop on them.
    if (code === 4001 || code === 4003) {
      this.setState("auth-failed");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.setState("disconnected");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Untyped lower-level RPC — exposed so feature views (apps panel, etc.)
   *  can call methods we haven't added typed convenience for yet. */
  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not-connected"));
        return;
      }
      const id = `rpc-${++this.rpcCounter}`;
      this.pending.set(id, { resolve, reject });
      const frame: ClientFrame = { type: "req", id, method, params };
      this.ws.send(JSON.stringify(frame));
    });
  }
}
