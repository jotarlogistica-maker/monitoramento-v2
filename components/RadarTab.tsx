"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { RadarItem, RadarStatus } from "@/lib/radar";

type RadarResponse = {
  items?: Record<string, RadarItem>;
  updatedAt?: string | null;
  sourceStopsUpdatedAt?: string | null;
};

type Props = {
  stopsUpdatedAt: string | null;
  stopsCount: number;
  lastCursor: number;
  onResetCursor: () => void;
  onSummaryChange?: (summary: { total: number; active: number; pending: number }) => void;
};

type StatusFilter = "ativos" | "todos" | RadarStatus;
type SortKey = "pendingOperational" | "prepared" | "estimated" | "name";

const card: CSSProperties = {
  background: "var(--card-bg)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 16,
};
const button: CSSProperties = {
  border: "none",
  borderRadius: 8,
  padding: "9px 14px",
  cursor: "pointer",
  fontWeight: 700,
  background: "#14161a",
  color: "#fff",
};
const secondaryButton: CSSProperties = {
  ...button,
  background: "var(--card-bg)",
  color: "var(--text-primary)",
  border: "1px solid var(--border)",
};
const input: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "9px 10px",
  background: "var(--card-bg)",
  color: "var(--text-primary)",
};
const th: CSSProperties = {
  padding: "11px 10px",
  borderBottom: "1px solid var(--border)",
  color: "var(--text-secondary)",
  fontSize: 12,
  whiteSpace: "nowrap",
};
const td: CSSProperties = { padding: "11px 10px", verticalAlign: "top" };

function clusterSort(a: string, b: string): number {
  const numberA = Number(a.replace(/\D/g, ""));
  const numberB = Number(b.replace(/\D/g, ""));
  if (Number.isFinite(numberA) && Number.isFinite(numberB) && numberA !== numberB) return numberA - numberB;
  return a.localeCompare(b);
}

function metric(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString("pt-BR") : "—";
}

function statusStyle(status: RadarStatus): CSSProperties {
  const map: Record<RadarStatus, { background: string; color: string }> = {
    Reatribuir: { background: "#fee2e2", color: "#991b1b" },
    "2ª Visita": { background: "#dbeafe", color: "#1e40af" },
    Coletando: { background: "#e0e7ff", color: "#3730a3" },
    Coletado: { background: "#dcfce7", color: "#166534" },
    Revisar: { background: "#f3e8ff", color: "#6b21a8" },
    Perdido: { background: "#fecaca", color: "#7f1d1d" },
    Ignorado: { background: "#e5e7eb", color: "#374151" },
  };
  return { ...map[status], borderRadius: 999, padding: "4px 9px", fontSize: 12, fontWeight: 800, display: "inline-block" };
}

function activeStatus(status: RadarStatus): boolean {
  return ["Reatribuir", "2ª Visita", "Coletando", "Revisar"].includes(status);
}

export default function RadarTab({ stopsUpdatedAt, stopsCount, lastCursor, onResetCursor, onSummaryChange }: Props) {
  const [items, setItems] = useState<Record<string, RadarItem>>({});
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ativos");
  const [clusterFilter, setClusterFilter] = useState("todos");
  const [reasonFilter, setReasonFilter] = useState("todos");
  const [typeFilter, setTypeFilter] = useState("todos");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("pendingOperational");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ processed: number; total: number; errors: number } | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  async function loadRadar() {
    setLoading(true);
    try {
      const response = await fetch("/api/radar", { cache: "no-store" });
      const data: RadarResponse & { error?: string } = await response.json();
      if (!response.ok) throw new Error(data.error || "Não foi possível carregar o Radar.");
      setItems(data.items || {});
      setUpdatedAt(data.updatedAt || null);
    } catch (error: any) {
      setMessage(error?.message || String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRadar();
  }, [stopsUpdatedAt]);

  async function rebuild() {
    setRebuilding(true);
    setMessage("");
    try {
      const response = await fetch("/api/radar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rebuild" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Falha ao recalcular o Radar.");
      setItems(data.items || {});
      setUpdatedAt(data.updatedAt || null);
      setMessage("Radar recalculado com as rotas e paradas atuais.");
    } catch (error: any) {
      setMessage(error?.message || String(error));
    } finally {
      setRebuilding(false);
    }
  }

  async function sync(ids?: string[]) {
    setSyncing(true);
    setSyncProgress(null);
    setMessage("");
    let cursor = 0;
    let done = false;
    let totalErrors = 0;
    try {
      while (!done) {
        const response = await fetch("/api/radar-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cursor, onlyIds: ids && ids.length > 0 ? ids : undefined }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Falha ao atualizar os IDs do Radar.");
        totalErrors += data.errors || 0;
        setSyncProgress({ processed: data.processed || 0, total: data.total || 0, errors: totalErrors });
        done = !!data.done;
        cursor = data.nextCursor ?? 0;
      }
      await loadRadar();
      setMessage(totalErrors > 0 ? `Atualização concluída com ${totalErrors} erro(s).` : "IDs atualizados pela API do Logistics.");
    } catch (error: any) {
      setMessage(error?.message || String(error));
    } finally {
      setSyncing(false);
    }
  }

  async function bulkOverride(status: RadarStatus | null) {
    if (selected.size === 0) return;
    const response = await fetch("/api/radar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "bulk_override", ids: Array.from(selected), status }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Não foi possível atualizar os itens selecionados.");
      return;
    }
    setItems(data.items || {});
    setMessage(`${data.updated || 0} item(ns) atualizado(s).`);
  }

  async function updateOverride(id: string, value: string) {
    const status = value ? (value as RadarStatus) : null;
    const response = await fetch("/api/radar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_override", id, status }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || "Não foi possível salvar o status.");
      return;
    }
    setItems((current) => ({ ...current, [id]: data.item }));
  }

  const rows = useMemo(() => Object.values(items), [items]);

  useEffect(() => {
    if (!onSummaryChange) return;
    const activeRows = rows.filter((row) => activeStatus(row.status));
    onSummaryChange({
      total: rows.length,
      active: activeRows.length,
      pending: activeRows.reduce(
        (sum, row) => sum + (typeof row.pendingOperational === "number" ? row.pendingOperational : 0),
        0
      ),
    });
  }, [rows, onSummaryChange]);
  const clusters = useMemo(
    () => Array.from(new Set(rows.map((row) => row.cluster || "—"))).sort(clusterSort),
    [rows]
  );
  const reasons = useMemo(
    () => Array.from(new Set(rows.map((row) => row.trigger?.label).filter(Boolean))).sort(),
    [rows]
  );

  const contextualRows = useMemo(() => {
    const query = search.trim().toUpperCase();
    return rows.filter((row) => {
      if (clusterFilter !== "todos" && row.cluster !== clusterFilter) return false;
      if (reasonFilter !== "todos" && row.trigger?.label !== reasonFilter) return false;
      if (typeFilter !== "todos" && row.type !== typeFilter) return false;
      if (query && !row.name.toUpperCase().includes(query) && !row.id.toUpperCase().includes(query) && !row.rawId.toUpperCase().includes(query)) {
        return false;
      }
      return true;
    });
  }, [rows, clusterFilter, reasonFilter, typeFilter, search]);

  const filteredRows = useMemo(() => {
    const result = contextualRows.filter((row) => {
      if (statusFilter === "todos") return true;
      if (statusFilter === "ativos") return activeStatus(row.status);
      return row.status === statusFilter;
    });
    return [...result].sort((a, b) => {
      let comparison = 0;
      if (sortKey === "name") comparison = a.name.localeCompare(b.name);
      else comparison = (a[sortKey] ?? -1) - (b[sortKey] ?? -1);
      return sortDirection === "desc" ? -comparison : comparison;
    });
  }, [contextualRows, statusFilter, sortKey, sortDirection]);

  const kpis = useMemo(() => {
    const activeRows = contextualRows.filter((row) => activeStatus(row.status));
    const calculableActive = activeRows.filter((row) => typeof row.pendingOperational === "number");
    return {
      total: contextualRows.length,
      active: activeRows.length,
      reassign: contextualRows.filter((row) => row.status === "Reatribuir").length,
      pending: calculableActive.reduce((sum, row) => sum + (row.pendingOperational || 0), 0),
      secondVisit: contextualRows.filter((row) => row.status === "2ª Visita" || row.status === "Coletando").length,
      recovered: contextualRows.filter((row) => row.status === "Coletado").length,
      review: contextualRows.filter((row) => row.status === "Revisar").length,
    };
  }, [contextualRows]);

  const clusterCards = useMemo(
    () =>
      clusters.map((cluster) => {
        const clusterRows = rows.filter((row) => row.cluster === cluster);
        return {
          cluster,
          total: clusterRows.length,
          active: clusterRows.filter((row) => activeStatus(row.status)).length,
          reassign: clusterRows.filter((row) => row.status === "Reatribuir").length,
          pending: clusterRows
            .filter((row) => activeStatus(row.status))
            .reduce((sum, row) => sum + (row.pendingOperational || 0), 0),
        };
      }),
    [clusters, rows]
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDirection((direction) => (direction === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setSortDirection(key === "name" ? "asc" : "desc");
    }
  }

  function toggleSelection(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectFiltered() {
    setSelected(new Set(filteredRows.map((row) => row.id)));
  }

  function copyFiltered() {
    navigator.clipboard?.writeText(filteredRows.map((row) => row.rawId || row.id).join("\n"));
    setMessage(`${filteredRows.length} ID(s) copiado(s).`);
  }

  const statuses: Array<StatusFilter> = ["ativos", "Reatribuir", "2ª Visita", "Coletando", "Revisar", "Coletado", "Perdido", "Ignorado", "todos"];

  return (
    <>
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>Radar operacional em tempo real</div>
            <div style={{ color: "var(--text-secondary)", fontSize: 13, maxWidth: 850 }}>
              Sellers e places com pacotes pendentes após ocorrência, cancelamento ou coleta incompleta. A base é atualizada automaticamente ao atualizar as rotas; a consulta via API confirma preparado, coletado e novas visitas.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={rebuild} disabled={rebuilding || syncing} style={secondaryButton}>
              {rebuilding ? "Recalculando..." : "Recalcular da varredura"}
            </button>
            <button onClick={() => sync()} disabled={syncing || rows.length === 0} style={button}>
              {syncing ? "Atualizando..." : "Atualizar todos via API"}
            </button>
            <button onClick={() => sync(Array.from(selected))} disabled={syncing || selected.size === 0} style={secondaryButton}>
              Atualizar selecionados ({selected.size})
            </button>
          </div>
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}>
          Radar: {updatedAt ? new Date(updatedAt).toLocaleString("pt-BR") : "ainda não calculado"} · Varredura: {stopsUpdatedAt ? new Date(stopsUpdatedAt).toLocaleString("pt-BR") : "não executada"} · {stopsCount} paradas.
          {lastCursor > 0 && (
            <span style={{ color: "var(--orange)", marginLeft: 8 }}>
              Varredura incompleta na posição {lastCursor}. <button onClick={onResetCursor} style={{ ...secondaryButton, padding: "3px 7px", marginLeft: 4 }}>reiniciar cursor</button>
            </span>
          )}
        </div>
        {syncProgress && (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            API: {syncProgress.processed}/{syncProgress.total} processados{syncProgress.errors ? ` · ${syncProgress.errors} erro(s)` : ""}
          </div>
        )}
        {message && <div style={{ marginTop: 8, fontSize: 12, color: message.toLowerCase().includes("erro") ? "var(--red)" : "var(--text-secondary)" }}>{message}</div>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 10, marginBottom: 16 }}>
        {[
          ["Pontos monitorados", kpis.total, undefined],
          ["Ativos", kpis.active, "var(--orange)"],
          ["Sem cobertura", kpis.reassign, "var(--red)"],
          ["Pendente operacional", kpis.pending.toLocaleString("pt-BR"), "var(--red)"],
          ["Com nova visita", kpis.secondVisit, "#1d4ed8"],
          ["Recuperados", kpis.recovered, "var(--green)"],
          ["Revisar", kpis.review, "#7e22ce"],
        ].map(([label, value, color]) => (
          <div key={String(label)} style={card}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 5 }}>{label}</div>
            <div style={{ fontSize: 23, fontWeight: 850, color: color as string | undefined }}>{value}</div>
          </div>
        ))}
      </div>

      {clusterCards.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 9 }}>Impacto por cluster</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(165px, 1fr))", gap: 10 }}>
            {clusterCards.map((entry) => {
              const active = clusterFilter === entry.cluster;
              return (
                <button
                  key={entry.cluster}
                  onClick={() => setClusterFilter(active ? "todos" : entry.cluster)}
                  style={{
                    ...card,
                    textAlign: "left",
                    cursor: "pointer",
                    border: active ? "2px solid #14161a" : "1px solid var(--border)",
                    color: "var(--text-primary)",
                  }}
                >
                  <div style={{ fontWeight: 850, marginBottom: 7 }}>{entry.cluster}</div>
                  <div style={{ fontSize: 20, fontWeight: 850, color: entry.pending > 0 ? "var(--red)" : "var(--green)" }}>{entry.pending.toLocaleString("pt-BR")}</div>
                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 4 }}>{entry.total} ponto(s) · {entry.active} ativo(s) · {entry.reassign} sem cobertura</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {statuses.map((status) => {
          const label = status === "ativos" ? "Ativos" : status === "todos" ? "Todos" : status;
          const count = contextualRows.filter((row) => status === "todos" ? true : status === "ativos" ? activeStatus(row.status) : row.status === status).length;
          return (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              style={{ ...secondaryButton, padding: "8px 11px", border: statusFilter === status ? "2px solid #14161a" : "1px solid var(--border)" }}
            >
              {label} ({count})
            </button>
          );
        })}
      </div>

      <div style={{ ...card, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar nome ou ID..." style={{ ...input, flex: 1, minWidth: 210 }} />
        <select value={clusterFilter} onChange={(event) => setClusterFilter(event.target.value)} style={input}>
          <option value="todos">Todos os clusters</option>
          {clusters.map((cluster) => <option key={cluster} value={cluster}>{cluster}</option>)}
        </select>
        <select value={reasonFilter} onChange={(event) => setReasonFilter(event.target.value)} style={input}>
          <option value="todos">Todos os motivos</option>
          {reasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
        </select>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} style={input}>
          <option value="todos">Seller e place</option>
          <option value="seller">Somente sellers</option>
          <option value="place">Somente places</option>
        </select>
        <button onClick={selectFiltered} style={secondaryButton}>Selecionar filtrados</button>
        <button onClick={() => setSelected(new Set())} style={secondaryButton}>Limpar seleção</button>
        <button onClick={() => bulkOverride("Perdido")} disabled={selected.size === 0} style={{ ...secondaryButton, color: "var(--red)" }}>Marcar perdido</button>
        <button onClick={() => bulkOverride("Ignorado")} disabled={selected.size === 0} style={secondaryButton}>Ignorar selecionados</button>
        <button onClick={() => bulkOverride(null)} disabled={selected.size === 0} style={secondaryButton}>Voltar ao automático</button>
        <button onClick={copyFiltered} style={secondaryButton}>Copiar IDs ({filteredRows.length})</button>
      </div>

      <div style={{ ...card, overflowX: "auto", padding: 0 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th style={th}></th>
              <th style={{ ...th, cursor: "pointer" }} onClick={() => toggleSort("name")}>Seller / Place</th>
              <th style={th}>Cluster</th>
              <th style={th}>Origem / motivo</th>
              <th style={{ ...th, cursor: "pointer" }} onClick={() => toggleSort("estimated")}>Estimado</th>
              <th style={{ ...th, cursor: "pointer" }} onClick={() => toggleSort("prepared")}>Preparado</th>
              <th style={th}>Coletado</th>
              <th style={{ ...th, cursor: "pointer" }} onClick={() => toggleSort("pendingOperational")}>Pendente</th>
              <th style={th}>Próxima visita</th>
              <th style={th}>Status</th>
              <th style={th}>Qualidade</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td style={td} colSpan={11}>Carregando Radar...</td></tr>
            ) : filteredRows.length === 0 ? (
              <tr><td style={td} colSpan={11}>Nenhum ponto encontrado. Atualize as rotas para a base automática ser calculada.</td></tr>
            ) : filteredRows.map((row) => (
              <Fragment key={row.id}>
                <tr style={{ borderTop: "1px solid var(--border)", background: selected.has(row.id) ? "#fffbeb" : undefined }}>
                  <td style={td}><input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleSelection(row.id)} /></td>
                  <td style={td}>
                    <button onClick={() => toggleExpanded(row.id)} style={{ border: 0, background: "transparent", padding: 0, textAlign: "left", cursor: "pointer", color: "inherit" }}>
                      <div style={{ fontWeight: 800 }}>{row.name}</div>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{row.id} · {row.type === "place" ? "Place" : "Seller"} · {expanded.has(row.id) ? "ocultar" : "detalhes"}</div>
                    </button>
                  </td>
                  <td style={td}>
                    <button onClick={() => setClusterFilter(row.cluster)} style={{ ...secondaryButton, padding: "4px 8px" }}>{row.cluster}</button>
                    {row.originCluster !== row.currentCluster && <div style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 3 }}>{row.originCluster} → {row.currentCluster}</div>}
                  </td>
                  <td style={td}>
                    <div style={{ fontWeight: 700 }}>{row.trigger?.label}</div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{row.trigger?.route?.routeName}</div>
                  </td>
                  <td style={td}>{metric(row.estimated)}</td>
                  <td style={td}>{metric(row.prepared)}</td>
                  <td style={td}>
                    {metric(row.collected)}
                    {typeof row.collectedCard === "number" && row.collectedCard !== row.collected && <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>card: {metric(row.collectedCard)}</div>}
                  </td>
                  <td style={{ ...td, color: (row.pendingOperational || 0) > 0 ? "var(--red)" : "var(--green)", fontWeight: 850 }}>{metric(row.pendingOperational)}</td>
                  <td style={td}>{row.nextVisit ? <><div>{row.nextVisit.routeName}</div><div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{row.nextVisit.stopStatus || row.nextVisit.routeStatus}</div></> : <span style={{ color: "var(--red)", fontWeight: 700 }}>Nenhuma</span>}</td>
                  <td style={td}>
                    <div style={statusStyle(row.status)}>{row.status}</div>
                    <select value={row.statusOverride || ""} onChange={(event) => updateOverride(row.id, event.target.value)} style={{ ...input, display: "block", marginTop: 6, padding: "5px 7px", fontSize: 11 }}>
                      <option value="">Automático ({row.automaticStatus})</option>
                      {["Reatribuir", "2ª Visita", "Coletando", "Coletado", "Revisar", "Perdido", "Ignorado"].map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                  </td>
                  <td style={td}>
                    <div style={{ fontWeight: 800, color: row.quality === "REVISAR" ? "#7e22ce" : row.quality === "CONFIRMADO" ? "var(--green)" : "var(--orange)" }}>{row.quality}</div>
                    <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>{row.source === "api" ? "API direta" : "varredura"}</div>
                    {row.syncError && <div style={{ fontSize: 10, color: "var(--red)", maxWidth: 160 }}>{row.syncError}</div>}
                  </td>
                </tr>
                {expanded.has(row.id) && (
                  <tr>
                    <td colSpan={11} style={{ ...td, background: "#fafafa" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 12 }}>
                        <div>
                          <div style={{ fontWeight: 800, marginBottom: 5 }}>Explicação</div>
                          <div>Entrou no Radar por <b>{row.trigger?.label}</b> na rota <b>{row.trigger?.route?.routeName}</b>.</div>
                          <div style={{ marginTop: 4 }}>Status automático: <b>{row.automaticStatus}</b>{row.statusOverride ? ` · exibido manualmente como ${row.statusOverride}` : ""}.</div>
                          <div style={{ marginTop: 4 }}>Detectado em {new Date(row.firstDetectedAt).toLocaleString("pt-BR")}.</div>
                        </div>
                        <div>
                          <div style={{ fontWeight: 800, marginBottom: 5 }}>Reconciliação</div>
                          <div>Preparado do card: <b>{metric(row.prepared)}</b></div>
                          <div>Coleta nas rotas: <b>{metric(row.collectedRoutes ?? row.collected)}</b></div>
                          <div>Coleta no card: <b>{metric(row.collectedCard)}</b></div>
                          <div>Atraso do card descontado: <b>{metric(row.cardLag)}</b></div>
                          <div>Pendente operacional: <b>{metric(row.pendingOperational)}</b></div>
                        </div>
                        <div>
                          <div style={{ fontWeight: 800, marginBottom: 5 }}>Alertas</div>
                          {row.warnings?.length ? row.warnings.map((warning) => <div key={warning} style={{ color: "var(--orange)", marginBottom: 3 }}>• {warning}</div>) : <div style={{ color: "var(--text-secondary)" }}>Nenhum alerta adicional.</div>}
                        </div>
                      </div>
                      <div style={{ fontWeight: 800, marginBottom: 6 }}>Visitas encontradas</div>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse" }}>
                          <thead><tr style={{ textAlign: "left" }}><th style={th}>Rota</th><th style={th}>Cluster</th><th style={th}>Status</th><th style={th}>Preparado</th><th style={th}>Coletado</th><th style={th}>Restante</th><th style={th}>Transportadora / motorista</th></tr></thead>
                          <tbody>{row.visits.map((visit, index) => <tr key={`${visit.routeId}-${index}`} style={{ borderTop: "1px solid var(--border)" }}><td style={td}>{visit.routeName}</td><td style={td}>{visit.cluster}</td><td style={td}>{visit.stopStatus || visit.routeStatus || "—"}{visit.hasProblem && <div style={{ color: "var(--red)" }}>{visit.problemType || "Ocorrência"}</div>}</td><td style={td}>{metric(visit.prepared)}</td><td style={td}>{metric(visit.collected)}</td><td style={td}>{metric(visit.remaining)}</td><td style={td}>{visit.carrierName || "—"}{visit.driverName ? ` · ${visit.driverName}` : ""}</td></tr>)}</tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
