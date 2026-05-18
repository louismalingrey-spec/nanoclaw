/**
 * Mirror of `src/channels/web/protocol.ts` on the host. Keep them in
 * lockstep — breaking wire compat must be deliberate, never accidental.
 */

export interface AuthFrame {
  type: "auth";
  token: string;
}

export interface AuthOkFrame {
  type: "auth-ok";
  user_id: string;
}

export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

export interface EventFrame {
  type: "event";
  event: string;
  payload: unknown;
}

export type ServerFrame = AuthOkFrame | ResponseFrame | EventFrame;
export type ClientFrame = AuthFrame | RequestFrame;

// ── Payload shapes ────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  folder: string;
  name: string;
  agent_provider: string | null;
  sessions: number;
}

export interface SessionPreview {
  id: string;
  agent_group_id: string;
  thread_id: string | null;
  status: string;
  container_status: string;
  last_active: string | null;
  created_at: string;
  channel_type: string | null;
  title: string;
  last_preview: string;
  last_at: string;
  message_count: number;
}

export interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  timestamp: string;
  kind: string;
  text: string;
  content: unknown;
  session_id: string;
  channel_type: string | null;
  sender: string | null;
}

export interface ChatFinalEvent {
  agent_group_id: string;
  kind: string;
  content: unknown;
  ts: string;
}

export interface AppSummary {
  id: string;
  agent_group_id: string;
  name: string;
  updated_at: string;
}

export interface AppFull extends AppSummary {
  code: string;
  created_at: string;
}

export interface AppChangedEvent {
  app_id: string;
  name: string;
  updated_at: string;
}

export interface ArtifactSummary {
  id: string;
  agent_group_id: string;
  name: string;
  kind: string;
  updated_at: string;
}

export interface ArtifactFull extends ArtifactSummary {
  content: string;
  created_at: string;
}

export interface ArtifactChangedEvent {
  artifact_id: string;
  name: string;
  updated_at: string;
}

export interface NotificationEntry {
  id: string;
  agent_group_id: string;
  kind: string;
  title: string;
  body: string | null;
  created_at: string;
  read_at: string | null;
}

export interface NotificationNewEvent {
  id: string;
  kind: string;
  title: string;
  body?: string;
  created_at: string;
}

export interface CronEntry {
  id: string;
  session_id: string;
  status: string;
  recurrence: string | null;
  process_after: string | null;
  series_id: string | null;
  prompt: string;
  script: string | null;
  created_at: string;
}
