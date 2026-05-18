/**
 * Web channel WS protocol — simple JSON-line RPC.
 *
 * Auth happens once at connect time: the first client frame MUST be
 * `{ type: "auth", token: "..." }`. Server replies with `auth-ok` (carrying
 * the resolved `user_id`) or closes the socket with code 4001/4003.
 *
 * After auth, the wire is three frame kinds:
 *   • req   — client → server RPC
 *   • res   — server → client RPC reply (matched by id)
 *   • event — server → client push (chat.final, app.changed, …)
 *
 * Discriminators are flat strings rather than a single union enum so the
 * wire is forward-compatible: a new event name doesn't break old parsers.
 *
 * NB: this file is mirrored in `web/src/protocol.ts` on the client side.
 *     Keep them in lockstep — break wire compatibility deliberately, never
 *     by accident.
 */

export interface AuthFrame {
  type: 'auth';
  token: string;
}

export interface AuthOkFrame {
  type: 'auth-ok';
  user_id: string;
}

export interface RequestFrame {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
}

export interface ResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

export interface EventFrame {
  type: 'event';
  event: string;
  payload: unknown;
}

export type ServerFrame = AuthOkFrame | ResponseFrame | EventFrame;
export type ClientFrame = AuthFrame | RequestFrame;
