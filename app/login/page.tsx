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
        <h2 style={{ marginTop: 0 }}>Painel de Monitoramento</h2>
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
      </form>
    </div>
  );
}
