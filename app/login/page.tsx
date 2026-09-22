"use client";
import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (res.ok) {
      window.location.href = "/";
    } else {
      const data = await res.json();
      setError(data.error || "Erro ao entrar.");
    }
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center" }}>
      <form
        onSubmit={handleSubmit}
        style={{ background: "white", padding: 32, borderRadius: 12, width: 320, boxShadow: "0 2px 12px rgba(0,0,0,0.08)" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: "#ffe600", display: "grid", placeItems: "center" }}>
            <svg width="30" height="30" viewBox="0 0 64 64" aria-label="PULSE" role="img">
              <path d="M8 34h12l6-17 10 31 7-20 5 6h8" fill="none" stroke="#14161a" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 21, fontWeight: 850, letterSpacing: "0.08em" }}>PULSE</div>
            <div style={{ fontSize: 11, color: "#6b7280" }}>First Mile Operations · BRRJ02</div>
          </div>
        </div>
        <input
          type="password"
          placeholder="Senha do time"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 12, borderRadius: 8, border: "1px solid #ccc", boxSizing: "border-box" }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{ width: "100%", padding: 10, borderRadius: 8, border: "none", background: "#ffe600", fontWeight: 600, cursor: "pointer" }}
        >
          {loading ? "Entrando..." : "Entrar"}
        </button>
        {error && <p style={{ color: "crimson", marginBottom: 0 }}>{error}</p>}
        <div style={{ borderTop: "1px solid #e5e7eb", marginTop: 22, paddingTop: 12, textAlign: "center", fontSize: 10, color: "#9ca3af" }}>
          Pickup Unified Logistics Surveillance &amp; Execution<br />dev by Jr Araujo
        </div>
      </form>
    </div>
  );
}
