import { useState } from "react";

export function Login({ onSave }: { onSave: (token: string) => void }) {
  const [token, setToken] = useState("");

  return (
    <div style={{
      height: "100vh", display: "grid", placeItems: "center",
      background: "var(--ncl-bg-soft)", fontFamily: "system-ui, sans-serif",
    }}>
      <div style={{
        width: 360, padding: 24, background: "var(--ncl-surface)",
        border: "1px solid var(--ncl-border)", borderRadius: 12, boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>NanoClaw OS</h1>
        <p style={{ marginTop: 8, marginBottom: 16, color: "var(--ncl-muted)", fontSize: 13 }}>
          Paste a bearer token to sign in. Generate one on the host with{" "}
          <code style={{ background: "var(--ncl-bg-soft)", padding: "1px 4px", borderRadius: 3 }}>
            POST /auth/issue
          </code>
          .
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="web_..."
          style={{
            width: "100%", padding: "10px 12px", border: "1px solid var(--ncl-border)",
            borderRadius: 6, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 13,
            boxSizing: "border-box", background: "var(--ncl-bg)", color: "var(--ncl-fg)",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && token.trim()) onSave(token.trim());
          }}
        />
        <button
          disabled={!token.trim()}
          onClick={() => onSave(token.trim())}
          style={{
            marginTop: 12, width: "100%", padding: "10px 12px", borderRadius: 6,
            border: "none", background: token.trim() ? "var(--ncl-fg)" : "var(--ncl-border)",
            color: "var(--ncl-bg)", fontSize: 14, fontWeight: 500,
            cursor: token.trim() ? "pointer" : "not-allowed",
          }}
        >
          Sign in
        </button>
      </div>
    </div>
  );
}
