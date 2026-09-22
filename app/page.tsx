"use client";
import { useEffect, useRef, useState, Fragment } from "react";
import RadarTab from "@/components/RadarTab";
import { reconcileVisitPackages } from "@/lib/pointMetrics";
import { chooseOperationalRoute, resolveClusterFromHistory } from "@/lib/sellerRouteHistory";
import {
  buildHighestProportionalImpactGroup,
  buildLargestImpactGroup,
  isScheduledCancelledRoute,
} from "@/lib/operationalClosing";

type Route = {
  id: number;
  routeName: string;
  facilityId: string;
  status: string;
  totalStops: number;
  pendingStops: number;
  successfulStops: number;
  failedStops: number;
  withProblemStops: number;
  estimatedPackages: number;
  collectedPackages: number;
  carrierName?: string;
};

function getCluster(routeName: string | undefined | null): string {
  const match = String(routeName || "").match(/_C(\d+)(?:_|$)/i);
  return match ? `C${match[1].padStart(2, "0")}` : "—";
}

// Ordena clusters por número (C1, C2...C10, C11), não por texto (que daria
// C1, C10, C11...C19, C2, C20 — ordem alfabética errada pra esse caso).
function sortClusters(a: string, b: string): number {
  const numA = parseInt(a.replace(/\D/g, ""), 10);
  const numB = parseInt(b.replace(/\D/g, ""), 10);
  if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
  return a.localeCompare(b);
}

// Formata "parte em cima de total" como "(NN%)". Retorna "" se total for 0
// (evita divisão por zero / porcentagem sem sentido).
function pct(parte: number, total: number): string {
  if (!total) return "";
  return `(${Math.round((parte / total) * 100)}%)`;
}

// Rotas de suporte/não planejadas às vezes não vêm com um routeName normal —
// cai pro ID da rota nesse caso, em vez de mostrar em branco.
function routeLabel(r: { routeName?: string; id: number }): string {
  return r.routeName && r.routeName.trim() ? r.routeName : `Rota não planejada (${r.id})`;
}

type Stop = {
  routeId: number;
  routeName: string;
  address?: string;
  neighborhood?: string;
  city?: string;
  sellerName?: string;
  rawId?: string;
  normalizedId?: string;
  idType?: string;
  isAgent?: boolean;
  estimatedPackages?: number;
  preparedPackages?: number;
  collectedPackages?: number;
  status?: string;
  hasProblem?: boolean;
  problemType?: string;
  timeFrom?: number;
  timeTo?: number;
  lat?: number;
  lng?: number;
  carrierName?: string;
  driverName?: string;
};

type Tab = "visao_geral" | "radar" | "sellers" | "sellers_am" | "rotas_am" | "rotas" | "clusters" | "transportadoras" | "diagnostico";

type SharedUpdate = {
  status: "idle" | "running" | "completed" | "failed";
  operationId: string | null;
  clientId: string | null;
  deviceLabel: string | null;
  stage: "routes" | "stops" | "radar" | null;
  processed: number;
  total: number;
  startedAt: number | null;
  completedAt: number | null;
  revision: number;
  message: string | null;
};

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<Tab>("visao_geral");
  const [overviewBreakdown, setOverviewBreakdown] = useState<"clusters" | "transportadoras">("clusters");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [routes, setRoutes] = useState<Route[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [cookie, setCookie] = useState("");
  const [msg, setMsg] = useState("");
  const [savingSession, setSavingSession] = useState(false);
  const [refreshingRoutes, setRefreshingRoutes] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [clientId, setClientId] = useState("");
  const [sharedUpdate, setSharedUpdate] = useState<SharedUpdate | null>(null);
  const lastSharedRevision = useRef<number | null>(null);
  const remoteUpdating = sharedUpdate?.status === "running" && sharedUpdate.clientId !== clientId;
  const actionInProgress = savingSession || refreshingRoutes || resetting || remoteUpdating;
  const [filter, setFilter] = useState<"todas" | "sem_inicio" | "com_problema">("todas");
  const [clusterFilter, setClusterFilter] = useState<string>("todos");
  const [carrierFilter, setCarrierFilter] = useState<string>("todas");
  // Sistema de ordenação combinável: clicar numa coluna adiciona ela como critério
  // (sem tirar a outra); clicar de novo na mesma inverte a direção dela.
  const [sortKeys, setSortKeys] = useState<Array<{ key: "pacotes" | "progresso"; dir: "desc" | "asc" }>>([]);

  function toggleRouteSort(key: "pacotes" | "progresso") {
    setSortKeys((prev) => {
      const existing = prev.find((s) => s.key === key);
      if (existing) {
        return prev.map((s) => (s.key === key ? { ...s, dir: s.dir === "desc" ? "asc" : "desc" } : s));
      }
      return [{ key, dir: "desc" }, ...prev];
    });
  }
  function clearRouteSort() {
    setSortKeys([]);
  }
  function sortArrow(active: boolean, dir: "desc" | "asc") {
    if (!active) return "";
    return dir === "desc" ? " ↓" : " ↑";
  }
  function routeSortBadge(key: "pacotes" | "progresso") {
    const idx = sortKeys.findIndex((s) => s.key === key);
    if (idx === -1) return "";
    const dir = sortKeys[idx].dir;
    const priority = sortKeys.length > 1 ? `${idx + 1}ª ` : "";
    return ` ${priority}${dir === "desc" ? "↓" : "↑"}`;
  }

  const [stops, setStops] = useState<Stop[]>([]);
  const [stopsUpdatedAt, setStopsUpdatedAt] = useState<string | null>(null);
  const [radarSummary, setRadarSummary] = useState({ total: 0, active: 0, pending: 0 });
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ processed: number; total: number; puladas?: number } | null>(null);

  const [search, setSearch] = useState("");
  const [lastCursor, setLastCursor] = useState(0);

  const [sellersMeta, setSellersMeta] = useState<{
    estimado: Record<string, number>;
    overrides: Record<string, string>;
    occStatus: Record<string, string>;
  }>({ estimado: {}, overrides: {}, occStatus: {} });

  async function loadStops() {
    const res = await fetch("/api/stops-data");
    const data = await res.json();
    setStops(data.stops || []);
    setStopsUpdatedAt(data.updatedAt);
  }

  async function loadRadarSummary() {
    const res = await fetch("/api/radar", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const radarItems = Object.values(data.items || {}) as any[];
    setRadarSummary({
      total: radarItems.length,
      active: radarItems.filter((item) => ["Reatribuir", "2ª Visita", "Coletando", "Revisar"].includes(item.status)).length,
      pending: radarItems.reduce((sum, item) => sum + (typeof item.pendingOperational === "number" ? item.pendingOperational : 0), 0),
    });
  }

  async function scanAllStops(operationId: string) {
    setScanning(true);
    let cursor = lastCursor;
    let done = false;
    let retriesLeft = 4;
    const leaseWaitDeadline = Date.now() + 120_000;

    try {
      while (!done) {
        let res: Response;
        let data: any;
        try {
          res = await fetch("/api/refresh-stops", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cursor, operationId }),
          });
          data = await res.json().catch(() => ({}));
        } catch (error: any) {
          setMsg(`Falha de conexão na posição ${cursor}. Clique em Continuar varredura para retomar: ${error?.message || error}`);
          setLastCursor(cursor);
          break;
        }

        if (!res.ok) {
          const sessaoExpirada = /401|expirad/i.test(data.error || "");
          if (res.status === 409 && data.retryAfterMs && Date.now() < leaseWaitDeadline) {
            const waitMs = Math.min(15_000, Math.max(2_000, Number(data.retryAfterMs) || 8_000));
            setMsg(`Outro lote ainda está terminando. Retomando automaticamente na posição ${cursor}...`);
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            continue;
          }
          if (sessaoExpirada || retriesLeft <= 0) {
            setMsg(
              sessaoExpirada
                ? `Sessão expirada (parou na rota ${cursor}). Cole o cookie novo e clique em Continuar varredura.`
                : `Varredura pausada na posição ${cursor}: ${data.error || "erro do servidor"}. Clique em Continuar varredura para retomar.`
            );
            setLastCursor(cursor);
            break;
          }
          retriesLeft--;
          setMsg(`Falha temporária, tentando novamente... (posição ${cursor})`);
          await new Promise((resolve) => setTimeout(resolve, 8_000));
          continue;
        }

        retriesLeft = 4;
        setScanProgress({ processed: data.processed, total: data.total, puladas: data.skipped ?? data.puladas });
        done = !!data.done;
        cursor = data.nextCursor ?? 0;
        setLastCursor(done ? 0 : cursor);
      }

      if (done) {
        setMsg("Varredura de rotas concluída. Consolidando o Radar...");
        const radarRes = await fetch("/api/radar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "rebuild" }),
        });
        const radarData = await radarRes.json().catch(() => ({}));
        await fetch("/api/update-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "finish",
            operationId,
            message: radarRes.ok ? "Rotas, paradas e Radar atualizados." : "Rotas e paradas atualizadas; o Radar precisa ser recalculado.",
          }),
        });
        setMsg(
          radarRes.ok
            ? "Varredura completa! Radar atualizado automaticamente."
            : `Varredura completa, mas o Radar não foi consolidado: ${radarData.error || "use Recalcular da varredura"}.`
        );
      } else {
        await fetch("/api/update-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "fail", operationId, message: "A atualização foi pausada e pode ser retomada pelo painel." }),
        }).catch(() => undefined);
      }
    } catch (error: any) {
      await fetch("/api/update-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fail", operationId, message: error?.message || "A atualização foi interrompida." }),
      }).catch(() => undefined);
      throw error;
    } finally {
      setScanning(false);
      await Promise.all([loadStops(), loadRadarSummary()]);
    }
  }

  // Força re-escanear UMA rota específica (ignora a lógica de "pular se não
  // mudou") — usa quando suspeitar de alguma rota, sem precisar reiniciar a
  // varredura inteira do zero.
  const [reescaneandoRotaId, setReescaneandoRotaId] = useState<number | null>(null);
  async function reescanearRota(routeId: number) {
    setReescaneandoRotaId(routeId);
    const res = await fetch("/api/refresh-stops", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forceRouteIds: [routeId] }),
    });
    const data = await res.json();
    setReescaneandoRotaId(null);
    if (res.ok) {
      const radarRes = await fetch("/api/radar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rebuild" }),
      });
      setMsg(radarRes.ok ? "Rota re-escaneada! Radar recalculado." : "Rota re-escaneada. Use Recalcular da varredura no Radar.");
      loadStops();
      loadRadarSummary();
    } else {
      setMsg(`Erro ao re-escanear: ${data.error}`);
    }
  }

  const searchResults = search.trim()
    ? stops.filter(
        (s) =>
          s.normalizedId?.includes(search.trim()) ||
          s.rawId?.includes(search.trim()) ||
          s.sellerName?.toUpperCase().includes(search.trim().toUpperCase())
      )
    : [];

  useEffect(() => {
    loadStops();
    loadRadarSummary();
  }, []);

  useEffect(() => {
    const storageKey = "pulse-client-id";
    let id = window.localStorage.getItem(storageKey);
    if (!id) {
      id = window.crypto.randomUUID();
      window.localStorage.setItem(storageKey, id);
    }
    setClientId(id);
  }, []);

  // ============ SELLERS / PLACES 3.0 ============
  const [sellerSearch, setSellerSearch] = useState("");
  const [sellerCard, setSellerCard] = useState<string | null>(null);
  const [sellerClusterFilter, setSellerClusterFilter] = useState<string>("todos");
  const [spSortKey, setSpSortKey] = useState<"estimado" | "preparado" | "coletado" | "pendente" | "impacto">("pendente");
  const [spSortDir, setSpSortDir] = useState<"desc" | "asc">("desc");
  function toggleSpSort(key: "estimado" | "preparado" | "coletado" | "pendente" | "impacto") {
    if (spSortKey === key) setSpSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSpSortKey(key);
      setSpSortDir("desc");
    }
  }
  const [expandedSeller, setExpandedSeller] = useState<string | null>(null);
  const [csvMsg, setCsvMsg] = useState("");

  // Pesquisa em lote, em tempo real, direto na API do Logistics — sem precisar
  // que o ID já esteja salvo em base nenhuma. Reaproveita o mesmo endpoint de
  // debug da Sellers AM (que já detecta seller/place sozinho e tem o fallback
  // pra ID cru quando o normalizado colide com outro cliente).
  const [pesquisaIdsInput, setPesquisaIdsInput] = useState("");
  const [pesquisaLoading, setPesquisaLoading] = useState(false);
  const [pesquisaResultados, setPesquisaResultados] = useState<any[]>([]);

  async function pesquisarIdsEmLote() {
    const ids = pesquisaIdsInput
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return;
    setPesquisaLoading(true);
    const res = await fetch("/api/sellers-am-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testIds: ids }),
    });
    const data = await res.json();
    setPesquisaLoading(false);
    if (res.ok) {
      setPesquisaResultados(data.results || []);
    }
  }


  async function loadSellersMeta() {
    const res = await fetch("/api/sellers-meta");
    const data = await res.json();
    setSellersMeta({ estimado: data.estimado || {}, overrides: data.overrides || {}, occStatus: data.occStatus || {} });
  }

  useEffect(() => {
    loadSellersMeta();
  }, []);

  async function setSellerStatus(id: string, status: string) {
    setSellersMeta((prev) => ({ ...prev, overrides: { ...prev.overrides, [id]: status } }));
    await fetch("/api/sellers-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overrides: { [id]: status } }),
    });
  }

  function fmtTime(ts?: number) {
    if (!ts) return "";
    return new Date(ts * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  function displayRotaStatus(stopStatus?: string) {
    if (stopStatus === "pending") return "Sem Início";
    if (stopStatus === "finished") return "Coletado";
    return stopStatus || "";
  }
  function isMorning(ts?: number) {
    if (!ts) return false;
    return new Date(ts * 1000).getHours() < 12;
  }

  // Agrupa as paradas (já salvas pela varredura) por ponto (seller/place),
  // e calcula tudo seguindo as fórmulas do Monitoramento 3.0.
  const sellerRows = (() => {
    const byPoint = new Map<string, Stop[]>();
    for (const stop of stops) {
      if (!stop.normalizedId) continue;
      const current = byPoint.get(stop.normalizedId) || [];
      current.push(stop);
      byPoint.set(stop.normalizedId, current);
    }

    return Array.from(byPoint.entries()).map(([id, pointStops]) => {
      const routeMetadataById = new Map(routes.map((route) => [Number(route.id), route]));
      const dedupedByRoute = new Map<number, Stop>();
      for (const stop of [...pointStops].sort((a, b) => (a.timeFrom ?? 0) - (b.timeFrom ?? 0))) {
        dedupedByRoute.set(stop.routeId, stop);
      }
      const sorted = Array.from(dedupedByRoute.values()).sort((a, b) => (a.timeFrom ?? 0) - (b.timeFrom ?? 0));

      const rotas = sorted.map((stop) => {
        const routeMetadata = routeMetadataById.get(Number(stop.routeId));
        const preparadosRota = stop.preparedPackages || 0;
        const coletadosRota = stop.collectedPackages || 0;
        return {
          routeId: stop.routeId,
          rota: stop.routeName,
          cluster: getCluster(stop.routeName),
          intervalo: stop.timeFrom && stop.timeTo ? `${fmtTime(stop.timeFrom)} a ${fmtTime(stop.timeTo)}` : "",
          status: displayRotaStatus(stop.status),
          preparadosRota,
          coletadosRota,
          restantesRota: Math.max(preparadosRota - coletadosRota, 0),
          timeFromRaw: stop.timeFrom || 0,
          hasProblem: !!stop.hasProblem,
          problemType: stop.problemType,
          carrierName: stop.carrierName || routeMetadata?.carrierName || "-",
          driverName: stop.driverName || "",
        };
      });

      const ultimaRota = rotas[rotas.length - 1];
      const rotaAgendada = [...rotas].reverse().find((route) => route.status === "Sem Início");
      const rotaQueColetou = [...rotas].reverse().find((route) => route.coletadosRota > 0);
      const rotaOperacional = rotaAgendada || rotaQueColetou || ultimaRota;
      const clusterResolution = resolveClusterFromHistory(rotas, rotaOperacional);
      const cluster = clusterResolution.cluster;
      const clusters = Array.from(new Set(rotas.map((route) => route.cluster).filter((value) => value && value !== "—")));
      const reconciliado = reconcileVisitPackages(
        rotas.map((route) => ({
          prepared: route.preparadosRota,
          collected: route.coletadosRota,
          remaining: route.restantesRota,
          preserveRemaining:
            route.status === "Sem Início" || /progress|collecting|coletando|open|started/i.test(route.status),
        }))
      );
      const coletado = reconciliado.collected ?? 0;
      const preparado = reconciliado.prepared ?? 0;
      const pendente = reconciliado.pending ?? 0;
      const estimado = sorted[0]?.estimatedPackages || 0;
      const impacto = estimado - coletado;
      const temVisitaAgendada = rotas.some((route) => route.status === "Sem Início");
      const temRiscoPerda = pendente > 0 && !temVisitaAgendada;

      let status: string;
      const manualStatus = sellersMeta.overrides[id];
      if (manualStatus === "Perdido") status = "Perdido";
      else if (temVisitaAgendada) status = rotas.filter((route) => route.status !== "").length > 1 ? "2ª Visita" : "Sem Início";
      else if (temRiscoPerda) status = "Reatribuir";
      else if (coletado >= preparado && coletado > 0) status = "Coletado";
      else status = "Pendente";
      if (manualStatus && manualStatus !== "Perdido") status = manualStatus;

      const dadoSuspeito =
        (estimado > 0 && coletado > estimado * 3) ||
        preparado < 0 ||
        coletado < 0 ||
        (coletado > 0 && preparado === 0 && rotas.length === 0);

      return {
        id,
        type: sorted[0]?.idType || "seller",
        name: sorted[0]?.sellerName || id,
        cluster,
        clusterFromHistory: clusterResolution.fromHistory,
        clusterSourceRoute: clusterResolution.sourceRoute?.rota || null,
        clusters,
        estimado,
        preparado,
        coletado,
        pendente,
        impacto,
        status,
        temRiscoPerda,
        dadoSuspeito,
        sobreposicaoRemovida: reconciliado.overlapRemoved,
        rotas,
        ultimaRota,
        rotaOperacional,
      };
    });
  })();

  const sellerCards: { key: string; label: string; test: (r: any) => boolean }[] = [
    { key: "unica_visita_manha", label: "1 visita até 12h", test: (r) => r.rotas.length === 1 && isMorning(r.rotas[0].timeFromRaw) },
    { key: "unica_visita", label: "1 visita (qualquer horário)", test: (r) => r.rotas.length === 1 },
    { key: "bateu_estimado", label: "Bateram o Estimado", test: (r) => r.coletado >= r.estimado && r.estimado > 0 },
    { key: "pendente", label: "Pacotes presos (pendente)", test: (r) => r.pendente > 0 },
    { key: "perdido", label: "Marcados como Perdido", test: (r) => r.status === "Perdido" },
    { key: "risco_reversao", label: "Risco de reversão", test: (r) => r.pendente > 0 },
    { key: "reatribuir", label: "Precisam de Reatribuir", test: (r) => r.temRiscoPerda },
    {
      key: "estimado_alto_preparado_baixo",
      label: "Estimado alto x Preparado baixo",
      test: (r) => r.estimado > 0 && r.preparado / r.estimado < 0.5,
    },
  ];

  const sellerClusters = Array.from(new Set(sellerRows.map((row) => row.cluster))).sort(sortClusters);
  const sellerRowsClusterScope = sellerRows.filter(
    (row) => sellerClusterFilter === "todos" || row.cluster === sellerClusterFilter
  );

  const sellersFiltered = sellerRowsClusterScope
    .filter((row) => {
      if (sellerCard) {
        const selectedCard = sellerCards.find((card) => card.key === sellerCard);
        if (selectedCard && !selectedCard.test(row)) return false;
      }
      if (sellerSearch.trim()) {
        const query = sellerSearch.trim().toUpperCase();
        if (!row.name.toUpperCase().includes(query) && !row.id.includes(sellerSearch.trim())) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const valueA = (a as any)[spSortKey] || 0;
      const valueB = (b as any)[spSortKey] || 0;
      return spSortDir === "desc" ? valueB - valueA : valueA - valueB;
    });

  // Os KPIs acompanham exatamente o recorte visível (cluster, alerta e busca),
  // para que o filtro de cluster represente o impacto real daquele território.
  const sellerKpis = {
    total: sellersFiltered.length,
    estimado: sellersFiltered.reduce((acc, row) => acc + row.estimado, 0),
    preparado: sellersFiltered.reduce((acc, row) => acc + row.preparado, 0),
    coletado: sellersFiltered.reduce((acc, row) => acc + row.coletado, 0),
    pendente: sellersFiltered.reduce((acc, row) => acc + row.pendente, 0),
  };

  const sellerClusterSummaries = sellerClusters.map((cluster) => {
    const clusterRows = sellerRows.filter((row) => row.cluster === cluster);
    const preparado = clusterRows.reduce((acc, row) => acc + row.preparado, 0);
    const coletado = clusterRows.reduce((acc, row) => acc + row.coletado, 0);
    return {
      cluster,
      total: clusterRows.length,
      estimado: clusterRows.reduce((acc, row) => acc + row.estimado, 0),
      preparado,
      coletado,
      pendente: clusterRows.reduce((acc, row) => acc + row.pendente, 0),
      reatribuir: clusterRows.filter((row) => row.temRiscoPerda).length,
      pctColetado: preparado > 0 ? Math.round((coletado / preparado) * 100) : 0,
    };
  });
  const operationalClusterRows = sellerClusterSummaries.map((summary) => ({
    ...summary,
    rotas: routes.filter((route) => getCluster(route.routeName) === summary.cluster).length,
  }));
  const operationalCarrierRows = (() => {
    const grouped = new Map<string, { carrier: string; total: number; preparado: number; coletado: number; pendente: number; reatribuir: number }>();
    sellerRows.forEach((row) => {
      const carrier = row.rotaOperacional?.carrierName || row.ultimaRota?.carrierName || "Sem transportadora";
      const current = grouped.get(carrier) || { carrier, total: 0, preparado: 0, coletado: 0, pendente: 0, reatribuir: 0 };
      current.total += 1;
      current.preparado += row.preparado || 0;
      current.coletado += row.coletado || 0;
      current.pendente += row.pendente || 0;
      if (row.temRiscoPerda) current.reatribuir += 1;
      grouped.set(carrier, current);
    });
    return [...grouped.values()]
      .map((row) => ({ ...row, pctColetado: row.preparado > 0 ? Math.round((row.coletado / row.preparado) * 100) : 0 }))
      .sort((a, b) => b.pendente - a.pendente);
  })();

  const top5Pendente = [...sellersFiltered].sort((a, b) => b.pendente - a.pendente).slice(0, 5);

  function copySellerIds() {
    const ids = sellersFiltered.map((r) => r.id).join("\n");
    navigator.clipboard?.writeText(ids);
    setCsvMsg(`${sellersFiltered.length} IDs copiados.`);
  }

  // ============ SELLERS AM (base via CSV + atualização via JSON do script) ============
  const [sellersAm, setSellersAm] = useState<Record<string, any>>({});
  const [sellersAmUpdatedAt, setSellersAmUpdatedAt] = useState<string | null>(null);
  const [sellersAmMsg, setSellersAmMsg] = useState("");
  const [sellersAmSearch, setSellersAmSearch] = useState("");
  const [sellersAmCard, setSellersAmCard] = useState<string | null>(null);
  const [sellersAmClusterFilter, setSellersAmClusterFilter] = useState<Set<string>>(new Set());
  const [clusterPanelOpen, setClusterPanelOpen] = useState(false);
  function toggleSellersAmCluster(cluster: string) {
    setSellersAmClusterFilter((current) => {
      const next = new Set(current);
      if (next.has(cluster)) next.delete(cluster);
      else next.add(cluster);
      return next;
    });
  }
  const [syncingApi, setSyncingApi] = useState(false);
  const [syncApiProgress, setSyncApiProgress] = useState<{ processed: number; total: number; matched: number; notFound: number; errors: number } | null>(null);
  const [syncApiResultados, setSyncApiResultados] = useState<Array<{ id: string; status: string; erro?: string }>>([]);
  const [syncOnlyIdsInput, setSyncOnlyIdsInput] = useState("");
  const [selectedSellerAmIds, setSelectedSellerAmIds] = useState<Set<string>>(new Set());
  const [excluirEstimadoAte, setExcluirEstimadoAte] = useState("1");
  const [testIdsInput, setTestIdsInput] = useState("");
  const [testIdsResults, setTestIdsResults] = useState<any[] | null>(null);
  const [testingIds, setTestingIds] = useState(false);

  async function testarIdsApi() {
    const ids = testIdsInput.split("\n").map((l) => l.trim()).filter(Boolean);
    if (ids.length === 0) return;
    setTestingIds(true);
    setTestIdsResults(null);
    const res = await fetch("/api/sellers-am-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testIds: ids }),
    });
    const data = await res.json();
    setTestingIds(false);
    if (res.ok) setTestIdsResults(data.results);
    else setTestIdsResults([{ id: "-", ok: false, erro: data.error }]);
  }
  const [amSortKey, setAmSortKey] = useState<"estimado" | "preparado" | "coletado" | "impacto">("impacto");
  const [amSortDir, setAmSortDir] = useState<"desc" | "asc">("desc");
  function toggleAmSort(key: "estimado" | "preparado" | "coletado" | "impacto") {
    if (amSortKey === key) setAmSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setAmSortKey(key);
      setAmSortDir("desc");
    }
  }
  const [expandedSellerAm, setExpandedSellerAm] = useState<string | null>(null);

  async function loadSellersAm() {
    const res = await fetch("/api/sellers-am");
    const data = await res.json();
    setSellersAm(data.sellers || {});
    setSellersAmUpdatedAt(data.updatedAt || null);
  }
  useEffect(() => {
    loadSellersAm();
  }, []);

  function parseCsvRow(line: string): string[] {
    const result: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else inQuotes = false;
        } else cur += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ",") {
          result.push(cur);
          cur = "";
        } else cur += c;
      }
    }
    result.push(cur);
    return result;
  }

  // CSV vem em blocos lado a lado (Base Geral, "Places AM com 1 visita", "Sellers AM com 1 visita").
  // A gente só pega os blocos cujo título tem "visita" — já vêm filtrados pra manhã + 1 visita.
  function parseSellersAmCsv(text: string) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 3) return [];
    const rows = lines.map(parseCsvRow);
    const titleRow = rows[0];
    const headerRow = rows[1];
    const blockStarts: number[] = [];
    headerRow.forEach((cell, idx) => {
      if (cell.trim().toUpperCase() === "ID_SELLER") blockStarts.push(idx);
    });
    const results: Array<{ id: string; name: string; horario?: string; estimado: number; tipo?: string }> = [];
    blockStarts.forEach((startIdx, bi) => {
      const endIdx = bi + 1 < blockStarts.length ? blockStarts[bi + 1] : headerRow.length;
      const blockHeaders = headerRow.slice(startIdx, endIdx).map((h) => h.trim().toUpperCase());
      const nameOffset = blockHeaders.findIndex((h) => h.includes("NAME"));
      const estOffset = blockHeaders.findIndex((h) => h.includes("PACOTES"));
      const horOffset = blockHeaders.findIndex((h) => h.includes("TIME") || h.includes("HORARIO"));
      const title = (titleRow[startIdx] || "").trim();
      if (!/visita/i.test(title)) return; // pula o bloco "Base Geral" (sem filtro de manhã/1 visita)
      const tipo = /place/i.test(title) ? "place" : /seller/i.test(title) ? "seller" : "";
      for (let r = 2; r < rows.length; r++) {
        const row = rows[r];
        const id = (row[startIdx] || "").trim();
        if (!id) continue;
        const name = (row[startIdx + nameOffset] || "").trim();
        const estimadoRaw = (row[startIdx + estOffset] || "0").trim();
        const estimado = parseInt(estimadoRaw.replace(/\D/g, ""), 10) || 0;
        const horario = horOffset >= 0 ? (row[startIdx + horOffset] || "").trim() : "";
        results.push({ id, name, estimado, horario, tipo });
      }
    });
    return results;
  }

  async function importSellersAmBase(file: File) {
    const text = await file.text();
    const rows = parseSellersAmCsv(text);
    if (rows.length === 0) {
      setSellersAmMsg("Não achei os blocos 'AM com 1 visita' nesse CSV. Confirma se é o formato certo.");
      return;
    }
    const res = await fetch("/api/sellers-am", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "import-base", payload: rows }),
    });
    const data = await res.json();
    if (res.ok) {
      setSellersAmMsg(`Base importada! ${data.count} sellers/places (AM, 1 visita).`);
      loadSellersAm();
    } else {
      setSellersAmMsg("Erro ao importar CSV.");
    }
  }

  // Gera a base da Sellers AM direto da varredura, sem precisar de CSV: pega
  // só os pontos que têm 1 rota só atribuída e ela é de manhã (antes das 12h) —
  // mesma lógica que já usávamos na aba Sellers/Places antiga.
  async function gerarBaseDaVarredura() {
    const byPoint = new Map<string, Stop[]>();
    for (const s of stops) {
      if (!s.normalizedId) continue;
      const arr = byPoint.get(s.normalizedId) || [];
      arr.push(s);
      byPoint.set(s.normalizedId, arr);
    }
    const rows: Array<{ id: string; name: string; horario?: string; estimado: number; tipo?: string }> = [];
    Array.from(byPoint.entries()).forEach(([id, pointStops]) => {
      const dedup = new Map<number, Stop>();
      pointStops.forEach((s) => dedup.set(s.routeId, s));
      const uniqueRoutes = Array.from(dedup.values());
      if (uniqueRoutes.length !== 1) return; // só 1 visita
      const s = uniqueRoutes[0];
      if (!s.timeFrom || !isMorning(s.timeFrom)) return; // só de manhã
      rows.push({
        id,
        name: s.sellerName || id,
        horario: fmtTime(s.timeFrom),
        estimado: s.estimatedPackages || 0,
        tipo: s.isAgent ? "place" : "seller",
      });
    });
    if (rows.length === 0) {
      setSellersAmMsg("Nenhum ponto com 1 visita só de manhã encontrado ainda — atualize as rotas para executar a varredura completa.");
      return;
    }
    const res = await fetch("/api/sellers-am", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "import-base", payload: rows }),
    });
    const data = await res.json();
    if (res.ok) {
      setSellersAmMsg(`Base gerada da varredura! ${data.count} sellers/places (1 visita, manhã) — sem precisar de CSV.`);
      loadSellersAm();
    } else {
      setSellersAmMsg("Erro ao gerar base da varredura.");
    }
  }

  // Sincroniza Preparado/Coletado/rotas da Sellers AM direto pela API do
  // Logistics (sem passar pelo script/JSON) — busca customer_id de cada
  // seller/place, depois o detalhe por rota, em lotes, com retry em 429.
  // Se `onlyIds` vier preenchido, roda só esses (em vez da base inteira).
  async function sincronizarViaApi(onlyIds?: string[]) {
    setSyncingApi(true);
    setSyncApiProgress(null);
    setSyncApiResultados([]);
    let cursor = 0;
    let done = false;
    let totalMatched = 0;
    let totalNotFound = 0;
    let totalErrors = 0;
    let lastError = "";
    const todosResultados: Array<{ id: string; status: string; erro?: string }> = [];

    while (!done) {
      const res = await fetch("/api/sellers-am-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cursor, onlyIds: onlyIds && onlyIds.length > 0 ? onlyIds : undefined }),
      });
      const data = await res.json();

      if (!res.ok) {
        setSellersAmMsg(`Erro ao sincronizar: ${data.error}`);
        break;
      }

      totalMatched += data.matched || 0;
      totalNotFound += data.notFound || 0;
      totalErrors += data.errors || 0;
      if (data.lastError) lastError = data.lastError;
      if (Array.isArray(data.resultados)) todosResultados.push(...data.resultados);
      setSyncApiProgress({ processed: data.processed, total: data.total, matched: totalMatched, notFound: totalNotFound, errors: totalErrors });

      done = data.done;
      cursor = data.nextCursor ?? 0;
    }

    setSyncApiResultados(todosResultados);
    setSyncingApi(false);
    loadSellersAm();
    if (done) {
      setSellersAmMsg(
        `Sincronizado via API! ${totalMatched} atualizados, ${totalNotFound} não encontrados no Logistics${
          totalErrors > 0 ? `, ${totalErrors} com erro (${lastError})` : ""
        }.`
      );
    }
  }

  async function importSellersAmJson(file: File) {
    const text = await file.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      setSellersAmMsg("JSON inválido — confirma se é o arquivo certo exportado pelo script.");
      return;
    }
    const res = await fetch("/api/sellers-am", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "import-json", payload: json }),
    });
    const data = await res.json();
    if (res.ok) {
      const v = data.validacao;
      const validacaoTxt = v
        ? v.bate
          ? ` ✅ Validação OK (${v.somaCalculada}/${v.idsRecebidos} IDs fecham).`
          : ` ⚠️ Validação NÃO bateu (${v.somaCalculada}/${v.idsRecebidos} IDs) — confere o lote.`
        : "";
      setSellersAmMsg(
        `Atualizado! ${data.matched} sellers atualizados, ${data.skipped} IDs não estavam na base.${validacaoTxt}`
      );
      loadSellersAm();
    } else {
      setSellersAmMsg("Erro ao importar JSON.");
    }
  }

  async function updateSellerAmField(id: string, field: string, value: any) {
    setSellersAm((prev) => {
      const current = prev[id] || {};
      const updated = field === "status" ? { ...current, statusOverride: value } : { ...current, [field]: value };
      return { ...prev, [id]: updated };
    });
    await fetch("/api/sellers-am", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", payload: { id, field, value } }),
    });
    loadSellersAm();
  }

  async function deleteSellerAm(id: string) {
    await fetch("/api/sellers-am", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", payload: { id } }),
    });
    loadSellersAm();
  }

  async function deleteSellerAmBulk(ids: string[]) {
    if (ids.length === 0) return;
    const ok = window.confirm(`Isso vai excluir ${ids.length} seller(s)/place(s) da base. Tem certeza?`);
    if (!ok) return;
    await fetch("/api/sellers-am", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", payload: { ids } }),
    });
    setSelectedSellerAmIds(new Set());
    loadSellersAm();
  }

  async function resetSellersAm() {
    const ok = window.confirm("Isso vai apagar toda a base de Sellers AM (novo dia). Tem certeza?");
    if (!ok) return;
    await fetch("/api/sellers-am", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    });
    loadSellersAm();
  }

  function timeAgo(ts?: number) {
    if (!ts) return "";
    const diffMin = Math.floor((Date.now() - ts) / 60000);
    if (diffMin < 1) return "agora";
    if (diffMin < 60) return `${diffMin}min atrás`;
    return `${Math.floor(diffMin / 60)}h atrás`;
  }
  function timeAgoColor(ts?: number) {
    if (!ts) return "var(--text-secondary)";
    const diffMin = (Date.now() - ts) / 60000;
    if (diffMin > 120) return "var(--red)";
    if (diffMin > 30) return "var(--orange)";
    return "var(--text-secondary)";
  }
  function statusColors(status: string): { bg: string; fg: string } {
    switch (status) {
      case "Coletado":
        return { bg: "#dcfce7", fg: "#166534" };
      case "Reatribuir":
      case "Perdido":
        return { bg: "#fee2e2", fg: "#991b1b" };
      case "Cancelado":
        return { bg: "#e5e7eb", fg: "#1f2937" };
      case "Revisar":
        return { bg: "#f3e8ff", fg: "#6b21a8" };
      case "2ª Visita":
        return { bg: "#dbeafe", fg: "#1e40af" };
      default:
        return { bg: "#fef9c3", fg: "#854d0e" }; // Pendente
    }
  }

  function isAwaitingStatus(status?: string): boolean {
    const s = (status || "").toLowerCase();
    return s.includes("sem in") || s.includes("não inic") || s.includes("nao inic") || s.includes("aguardando");
  }
  function isCanceledStatus(status?: string): boolean {
    return (status || "").toLowerCase().includes("cancel");
  }

  // Uma "rota" consolidada pode trazer ocorrenciasDetalhadas (cada passagem real
  // dela) — quando não trouxer (formato antigo do script), trata a própria rota
  // como uma ocorrência única, pra manter compatibilidade.
  function getOcorrencias(rota: any): any[] {
    if (Array.isArray(rota.ocorrenciasDetalhadas) && rota.ocorrenciasDetalhadas.length > 0) {
      return rota.ocorrenciasDetalhadas;
    }
    return [rota];
  }

  const sellersAmRows = Object.values(sellersAm).map((s: any) => {
    const rotas = s.rotas || [];
    const ultimaRotaOperacional = chooseOperationalRoute(rotas);
    const preparado: number | null = s.preparado ?? null;
    const coletado: number | null = s.coletado ?? null;
    // impactoBruto = valor cru que o extrator calculou (preparado - coletado, sem
    // interpretação) — guardado só pra fidelidade/auditoria do dado.
    const impactoNaoCalculado = !!s.impactoNaoCalculado || preparado === null || coletado === null;
    const impactoBruto: number | null = impactoNaoCalculado ? null : s.impacto ?? (preparado as number) - (coletado as number);

    // Precisa saber se tem visita agendada, usado no status mais abaixo.
    const temVisitaAgendada = rotas.some((r: any) => getOcorrencias(r).some((oc) => isAwaitingStatus(oc.status)));

    // Pendente de coleta = Preparado do card, sempre — sem subtrair o Coletado
    // do card diretamente. O Preparado do card é um MEDIDOR AO VIVO ("o que
    // está pronto pra coletar agora"), não um total acumulado do dia: ele já
    // desce sozinho conforme os itens são coletados (viram Coletado) e sobe
    // conforme novo item é preparado — subtrair o Coletado dele de novo
    // contaria a coleta 2 vezes.
    //
    // MAS o card pode ficar momentaneamente desatualizado logo depois de uma
    // coleta (Preparado ainda não desceu, Coletado ainda mostra 0/baixo) — pra
    // detectar isso, compara o Coletado do card contra o que as ROTAS JÁ
    // CONCLUÍDAS (status ≠ "Sem Início") confirmam. Se o card estiver atrasado
    // (mostrando menos do que a rota já confirmou), desconta essa diferença do
    // Preparado antes de virar Impacto — corrige o atraso sem esconder pendente
    // real de rota nenhuma (rota ainda "Sem Início" nunca entra nessa conta,
    // porque ela ainda não coletou nada mesmo).
    const coletadoConfirmadoPorRotas = rotas
      .filter((rt: any) => !isAwaitingStatus(rt.status))
      .reduce((acc: number, rt: any) => acc + (rt.coletadosRota ?? 0), 0);
    // A sincronização direta preserva os dois valores: coleta consolidada nas
    // rotas (s.coletado) e coleta ainda refletida no card (s.coletadoCard).
    // Bases antigas/importadas não têm coletadoCard, então mantemos o fallback.
    const coletadoCard: number | null = s.coletadoCard ?? coletado;
    const atrasoDoCard = Math.max(0, coletadoConfirmadoPorRotas - (coletadoCard ?? 0));
    const chegouAposColeta = !impactoNaoCalculado && (coletado as number) > 0;
    const impacto: number | null = impactoNaoCalculado ? null : Math.max((preparado as number) - atrasoDoCard, 0);

    const temCancelada = rotas.some((r: any) => getOcorrencias(r).some((oc) => isCanceledStatus(oc.status)));
    // Sem nenhuma rota do nosso hub sobrando (tudo que veio da busca era de
    // outra regional — ex: colisão de ID depois da normalização) — não dá pra
    // confiar nesse dado, força "Revisar" em vez de classificar normal.
    const semRotaDoNossoHub = s.qualidade === "REVISAR" && rotas.length === 0;
    // Só marca "Reatribuir" se sobrar mais de 100 pacotes pendentes de coleta.
    const LIMITE_REATRIBUIR = 100;
    const temRiscoPerda = !impactoNaoCalculado && (impacto as number) > LIMITE_REATRIBUIR && !temVisitaAgendada;
    let status: string;
    if (s.statusOverride === "Perdido") status = "Perdido";
    else if (impactoNaoCalculado) status = "Revisar"; // dado não lido, não dá pra classificar com segurança
    else if (semRotaDoNossoHub) status = "Revisar"; // ID bateu com dado de outro hub, nenhuma rota nossa confirmada
    else if (temCancelada) status = "Cancelado";
    else if (temVisitaAgendada && rotas.length > 1) status = "2ª Visita";
    else if (temRiscoPerda) status = "Reatribuir";
    else if (temVisitaAgendada) status = "Pendente";
    else status = "Coletado";
    if (s.statusOverride && s.statusOverride !== "Perdido") status = s.statusOverride;

    // A resposta atual da API pode não repetir uma rota já finalizada. Usa a
    // rota operacional escolhida do histórico mesclado e mantém o snapshot
    // salvo como fallback, em vez de apagar cluster e última rota.
    const clusterResolution = resolveClusterFromHistory(rotas, ultimaRotaOperacional);
    const cluster = clusterResolution.cluster !== "—" ? clusterResolution.cluster : s.cluster || "—";

    // Valor absurdamente alto de verdade (tipo 9823928) — bem acima de qualquer
    // número real que já vimos (a maioria fica na casa das centenas) — indica
    // bug de leitura/soma em algum lugar, não um volume real.
    const LIMITE_VALOR_ABSURDO = 50000;
    const valorAbsurdo =
      (typeof s.estimado === "number" && s.estimado > LIMITE_VALOR_ABSURDO) ||
      (typeof preparado === "number" && preparado > LIMITE_VALOR_ABSURDO) ||
      (typeof coletado === "number" && coletado > LIMITE_VALOR_ABSURDO);

    const dadoSuspeito =
      valorAbsurdo ||
      (typeof s.estimado === "number" && typeof coletado === "number" && s.estimado > 0 && coletado > s.estimado * 3) ||
      (typeof preparado === "number" && preparado < 0) ||
      (typeof coletado === "number" && coletado < 0) ||
      (s.qualidade && s.qualidade !== "OK") ||
      (Array.isArray(s.avisos) && s.avisos.length > 0) ||
      !!s.temConflitos ||
      (typeof s.cardsInvestigados === "number" && s.cardsInvestigados > 1);

    return {
      ...s,
      rotas,
      preparado,
      coletado,
      impacto,
      impactoBruto,
      valorAbsurdo,
      impactoNaoCalculado,
      chegouAposColeta,
      status,
      cluster,
      clusterFromHistory: clusterResolution.fromHistory,
      clusterSourceRoute: clusterResolution.sourceRoute?.rota || null,
      ultimaRota: ultimaRotaOperacional || s.ultimaRota || null,
      temRiscoPerda,
      temCancelada,
      dadoSuspeito,
    };
  });

  const sellersAmClusters = Array.from(new Set(sellersAmRows.map((r) => r.cluster))).sort(sortClusters);

  const sellersAmCards: { key: string; label: string; test: (r: any) => boolean }[] = [
    { key: "status_2visita", label: "2ª Visita", test: (r) => r.status === "2ª Visita" },
    { key: "status_pendente", label: "Pendentes", test: (r) => r.status === "Pendente" },
    { key: "status_cancelado", label: "Cancelados", test: (r) => r.status === "Cancelado" },
    { key: "status_coletado", label: "Coletados", test: (r) => r.status === "Coletado" },
    { key: "status_reatribuir", label: "Reatribuir", test: (r) => r.status === "Reatribuir" },
    { key: "status_perdido", label: "Perdidos", test: (r) => r.status === "Perdido" },
    { key: "status_revisar", label: "Revisar (dado null)", test: (r) => r.status === "Revisar" },
  ];

  const sellersAmFiltered = sellersAmRows
    .filter((r) => {
      if (sellersAmCard) {
        const card = sellersAmCards.find((c) => c.key === sellersAmCard);
        if (card && !card.test(r)) return false;
      }
      if (sellersAmClusterFilter.size > 0 && !sellersAmClusterFilter.has(r.cluster)) return false;
      if (sellersAmSearch.trim()) {
        const q = sellersAmSearch.trim().toUpperCase();
        if (!r.name.toUpperCase().includes(q) && !r.id.includes(sellersAmSearch.trim())) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const va = a[amSortKey] || 0;
      const vb = b[amSortKey] || 0;
      return amSortDir === "desc" ? vb - va : va - vb;
    });

  // Resumo por cluster — pra dar visibilidade rápida tipo "sobrou carro no C3":
  // conta de pontos, soma de pendente e quantos precisam de reatribuir por cluster.
  const sellersAmPorCluster = sellersAmClusters
    .map((cluster) => {
      const doCluster = sellersAmRows.filter((r) => r.cluster === cluster);
      return {
        cluster,
        total: doCluster.length,
        pendente: doCluster.filter((r) => !r.impactoNaoCalculado).reduce((acc, r) => acc + (r.impacto || 0), 0),
        reatribuir: doCluster.filter((r) => r.status === "Reatribuir").length,
      };
    })
    .sort((a, b) => sortClusters(a.cluster, b.cluster));

  const impactoCalculavel = sellersAmRows.filter((r) => !r.impactoNaoCalculado);
  const sellersAmKpis = {
    total: sellersAmRows.length,
    estimado: sellersAmRows.reduce((acc, r) => acc + (r.estimado || 0), 0),
    preparado: sellersAmRows.reduce((acc, r) => acc + (r.preparado || 0), 0),
    coletado: sellersAmRows.reduce((acc, r) => acc + (r.coletado || 0), 0),
    naoCalculado: sellersAmRows.length - impactoCalculavel.length,
    // bruto/positivo/negativo vêm do valor cru (Preparado - Coletado, sem
    // interpretação, pode dar negativo). "Regra adotada" é o número que a tela
    // realmente usa (Pendente de coleta, com a lógica de pós-coleta).
    impactoBruto: impactoCalculavel.reduce((acc, r) => acc + (r.impactoBruto || 0), 0),
    impactoPositivo: impactoCalculavel.filter((r) => (r.impactoBruto || 0) > 0).reduce((acc, r) => acc + (r.impactoBruto || 0), 0),
    impactoNegativo: impactoCalculavel.filter((r) => (r.impactoBruto || 0) < 0).reduce((acc, r) => acc + (r.impactoBruto || 0), 0),
    impactoRegra: impactoCalculavel.reduce((acc, r) => acc + (r.impacto || 0), 0),
    pendente2Visita: impactoCalculavel
      .filter((r) => r.status === "2ª Visita")
      .reduce((acc, r) => acc + (r.impacto || 0), 0),
    pendenteReatribuicao: impactoCalculavel
      .filter((r) => r.status === "Reatribuir")
      .reduce((acc, r) => acc + (r.impacto || 0), 0),
  };

  // Quebra por status — a soma de todas as linhas abaixo tem que bater exatamente
  // com o "Pendente de coleta (total)". Serve pra provar/conferir a conta.
  const pendentePorStatus = ["2ª Visita", "Reatribuir", "Pendente", "Coletado", "Cancelado", "Perdido", "Revisar"]
    .map((st) => {
      const doStatus = sellersAmRows.filter((r) => r.status === st);
      return {
        status: st,
        sellers: doStatus.length,
        pendente: doStatus.filter((r) => !r.impactoNaoCalculado).reduce((acc, r) => acc + (r.impacto || 0), 0),
      };
    })
    .filter((row) => row.sellers > 0);
  const somaPendentePorStatus = pendentePorStatus.reduce((acc, row) => acc + row.pendente, 0);

  // ============ ROTAS AM (lista de rotas definida manualmente por você —
  // visão invertida: abre a rota e vê os sellers dela, com Estimado/Preparado/
  // Coletado de cada um) ============
  const [rotasAmExpanded, setRotasAmExpanded] = useState<Set<number>>(new Set());
  const [rotasAmSearch, setRotasAmSearch] = useState("");
  const [rotasAmSortKey, setRotasAmSortKey] = useState<
    "estimadoTotal" | "preparadoTotal" | "coletadoTotal" | "impactoEstPrep" | "pendenteColeta" | "sellers"
  >("impactoEstPrep");
  const [rotasAmSortDir, setRotasAmSortDir] = useState<"desc" | "asc">("desc");
  function toggleRotasAmSort(
    key: "estimadoTotal" | "preparadoTotal" | "coletadoTotal" | "impactoEstPrep" | "pendenteColeta" | "sellers"
  ) {
    if (rotasAmSortKey === key) setRotasAmSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setRotasAmSortKey(key);
      setRotasAmSortDir("desc");
    }
  }
  function toggleRotaAmExpand(routeId: number) {
    setRotasAmExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(routeId)) next.delete(routeId);
      else next.add(routeId);
      return next;
    });
  }
  const [rotasAmLista, setRotasAmLista] = useState<string[]>([]);
  const [rotasAmListaInput, setRotasAmListaInput] = useState("");
  const [rotasAmListaMsg, setRotasAmListaMsg] = useState("");
  const [rotasAmListaUpdatedAt, setRotasAmListaUpdatedAt] = useState<string | null>(null);

  async function loadRotasAmLista() {
    const res = await fetch("/api/rotas-am-lista");
    const data = await res.json();
    setRotasAmLista(data.rotas || []);
    setRotasAmListaUpdatedAt(data.updatedAt || null);
  }
  useEffect(() => {
    loadRotasAmLista();
  }, []);

  async function salvarRotasAmLista() {
    const rotas = rotasAmListaInput
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const res = await fetch("/api/rotas-am-lista", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotas }),
    });
    const data = await res.json();
    if (res.ok) {
      setRotasAmListaMsg(`Lista salva! ${data.count} rota(s).`);
      setRotasAmListaInput("");
      loadRotasAmLista();
    } else {
      setRotasAmListaMsg("Erro ao salvar a lista.");
    }
  }

  const rotasAmListaSet = new Set(rotasAmLista.map((r) => r.trim().toUpperCase()));

  const rotasAmMap = new Map<
    number,
    { routeId: number; routeName: string; etaFimTs: number; sellers: any[] }
  >();
  for (const s of stops) {
    if (!rotasAmListaSet.has((s.routeName || "").trim().toUpperCase())) continue; // só as rotas da lista
    if (!rotasAmMap.has(s.routeId)) {
      rotasAmMap.set(s.routeId, { routeId: s.routeId, routeName: s.routeName, etaFimTs: 0, sellers: [] });
    }
    const entry = rotasAmMap.get(s.routeId)!;
    if ((s.timeTo || 0) > entry.etaFimTs) entry.etaFimTs = s.timeTo || 0;
    entry.sellers.push({
      nome: s.sellerName,
      id: s.rawId,
      isAgent: s.isAgent,
      estimado: s.estimatedPackages,
      preparado: s.preparedPackages,
      coletado: s.collectedPackages,
      status: s.status,
      hasProblem: s.hasProblem,
      problemType: s.problemType,
    });
  }

  const rotasAmRows = Array.from(rotasAmMap.values())
    .map((rt) => {
      const rotaInfo = routes.find((r) => r.id === rt.routeId);
      const estimadoTotal = rt.sellers.reduce((acc: number, sl: any) => acc + (sl.estimado || 0), 0);
      const preparadoTotal = rt.sellers.reduce((acc: number, sl: any) => acc + (sl.preparado || 0), 0);
      const coletadoTotal = rt.sellers.reduce((acc: number, sl: any) => acc + (sl.coletado || 0), 0);
      return {
        ...rt,
        etaTexto: rt.etaFimTs ? new Date(rt.etaFimTs * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "-",
        carrierName: rotaInfo?.carrierName || "-",
        // Rota finalizada de verdade no Logistics (status "close") — já
        // descarregou no XD, motorista foi embora.
        finalizada: (rotaInfo?.status || "").toLowerCase() === "close",
        cluster: getCluster(rt.routeName),
        estimadoTotal,
        preparadoTotal,
        coletadoTotal,
        sellers_count: rt.sellers.length,
        // Estimado - Preparado: o quanto ainda falta nem preparar.
        impactoEstPrep: estimadoTotal - preparadoTotal,
        // Preparado - Coletado: o quanto já foi preparado mas ainda não coletado.
        pendenteColeta: preparadoTotal - coletadoTotal,
      };
    })
    .filter((rt) => {
      if (!rotasAmSearch.trim()) return true;
      const q = rotasAmSearch.trim().toUpperCase();
      return (
        rt.routeName.toUpperCase().includes(q) ||
        rt.sellers.some((sl: any) => (sl.nome || "").toUpperCase().includes(q) || (sl.id || "").includes(rotasAmSearch.trim()))
      );
    })
    .sort((a, b) => {
      const key = rotasAmSortKey === "sellers" ? "sellers_count" : rotasAmSortKey;
      const va = (a as any)[key] || 0;
      const vb = (b as any)[key] || 0;
      return rotasAmSortDir === "desc" ? vb - va : va - vb;
    });

  const rotasNaoEncontradas = rotasAmLista.filter(
    (nome) => !Array.from(rotasAmMap.values()).some((rt) => rt.routeName.trim().toUpperCase() === nome.trim().toUpperCase())
  );

  function toggleExpandirTodasRotasAm() {
    const todasExpandidas = rotasAmRows.length > 0 && rotasAmRows.every((rt) => rotasAmExpanded.has(rt.routeId));
    if (todasExpandidas) setRotasAmExpanded(new Set());
    else setRotasAmExpanded(new Set(rotasAmRows.map((rt) => rt.routeId)));
  }

  // Mesma regra de "Pendente de coleta" usada na aba Sellers AM, aplicada aqui
  // por linha de seller (dentro de cada rota) antes de somar.
  function pendenteColetaSeller(preparado: number, coletado: number) {
    return coletado < preparado ? preparado - coletado : preparado;
  }

  // Separa Sellers x Places (o próprio dado já diz: ID composto tipo
  // "849817033_..." = Place; o resto = Seller) e soma cada grupo.
  const sellersVsPlaces = (() => {
    const acc = {
      seller: { total: 0, estimado: 0, preparado: 0, coletado: 0 },
      place: { total: 0, estimado: 0, preparado: 0, coletado: 0 },
    };
    const vistos = new Set<string>(); // evita contar o mesmo seller/place 2x se ele estiver em mais de 1 rota da lista
    for (const rt of rotasAmRows) {
      for (const sl of rt.sellers) {
        const chave = sl.id;
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        const grupo = sl.isAgent ? acc.place : acc.seller;
        grupo.total += 1;
        grupo.estimado += sl.estimado || 0;
        grupo.preparado += sl.preparado || 0;
        grupo.coletado += sl.coletado || 0;
      }
    }
    return acc;
  })();

  function exportarRotasAmCsv() {
    const linhas = [
      "rota,cluster,transportadora,eta_fim,seller_nome,seller_id,estimado,preparado,coletado,status,motivo_ocorrencia",
    ];
    for (const rt of rotasAmRows) {
      for (const sl of rt.sellers) {
        const campos = [
          rt.routeName,
          rt.cluster,
          rt.carrierName,
          rt.etaTexto,
          sl.nome || "",
          sl.id || "",
          sl.estimado ?? "",
          sl.preparado ?? "",
          sl.coletado ?? "",
          sl.status || "",
          sl.hasProblem ? sl.problemType || "sim" : "",
        ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
        linhas.push(campos.join(","));
      }
    }
    const csv = linhas.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `rotas-am_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  }


  const top5AtrasoAm = [...impactoCalculavel]
    .filter((r) => (r.impacto || 0) > 0)
    .sort((a, b) => (b.impacto || 0) - (a.impacto || 0))
    .slice(0, 5);

  function copySellersAmIds() {
    const ids = sellersAmFiltered.map((r) => r.id).join("\n");
    navigator.clipboard?.writeText(ids);
    setSellersAmMsg(`${sellersAmFiltered.length} IDs copiados.`);
  }
  function copySellersAmNotCollected() {
    const rows = sellersAmRows.filter((r) => r.status !== "Coletado");
    navigator.clipboard?.writeText(rows.map((r) => r.id).join("\n"));
    setSellersAmMsg(`${rows.length} IDs (não coletados) copiados.`);
  }
  function copySellersAmAll() {
    navigator.clipboard?.writeText(sellersAmRows.map((r) => r.id).join("\n"));
    setSellersAmMsg(`${sellersAmRows.length} IDs (todos) copiados.`);
  }

  async function loadData() {
    const res = await fetch("/api/routes-data");
    const data = await res.json();
    setRoutes(data.routes || []);
    setUpdatedAt(data.updatedAt);
  }

  useEffect(() => {
    loadData();
  }, []);

  // Reconhece se o texto colado é a tabela do DevTools (Application > Cookies,
  // uma linha por cookie, colunas separadas por TAB: Name, Value, Domain...)
  // e converte pro formato "name=value; name2=value2" que o site espera.
  // Se já vier nesse formato (colado de outro jeito), usa direto sem mexer.
  function normalizeCookieInput(raw: string): string {
    const text = raw.trim();
    if (!text) return text;
    const looksLikeTable = text.includes("\t") && text.includes("\n");
    if (!looksLikeTable) return text;

    const pairs: string[] = [];
    for (const line of text.split("\n")) {
      const cols = line.split("\t");
      const name = (cols[0] || "").trim();
      const value = (cols[1] || "").trim();
      if (name && value) pairs.push(`${name}=${value}`);
    }
    return pairs.length > 0 ? pairs.join("; ") : text;
  }

  async function saveSession() {
    setSavingSession(true);
    setMsg("");
    try {
      const cookieToSave = normalizeCookieInput(cookie);
      const res = await fetch("/api/save-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: cookieToSave }),
      });
      const data = await res.json().catch(() => ({}));
      setMsg(res.ok ? "Sessão validada e salva. Clique em Atualizar rotas quando quiser iniciar a busca." : `Erro: ${data.error || "não foi possível salvar a sessão."}`);
      if (res.ok) setCookie("");
    } catch (error: any) {
      setMsg(`Erro: ${error?.message || "não foi possível salvar a sessão."}`);
    } finally {
      setSavingSession(false);
    }
  }

  const [puLive, setPuLive] = useState<{ estimatedPackages: number; collectedPackages: number } | null>(null);
  const [puLiveUpdatedAt, setPuLiveUpdatedAt] = useState<string | null>(null);

  async function loadPuLive() {
    const res = await fetch("/api/pu-live");
    const data = await res.json();
    if (res.ok) {
      setPuLive(data.resumo);
      setPuLiveUpdatedAt(data.updatedAt);
    }
  }

  useEffect(() => {
    if (activeTab === "diagnostico" && !puLive) {
      loadPuLive();
    }
  }, [activeTab]);

  useEffect(() => {
    if (!clientId) return;
    let disposed = false;

    const pollSharedUpdate = async () => {
      try {
        const res = await fetch("/api/update-status", { cache: "no-store" });
        if (!res.ok) return;
        const state: SharedUpdate = await res.json();
        if (disposed) return;
        setSharedUpdate(state);

        if (lastSharedRevision.current === null) {
          lastSharedRevision.current = state.revision;
        } else if (state.revision > lastSharedRevision.current) {
          const updatedByAnotherSession = state.clientId !== clientId;
          lastSharedRevision.current = state.revision;
          await Promise.all([loadData(), loadStops(), loadRadarSummary(), loadSellersAm(), loadPuLive()]);
          if (updatedByAnotherSession) {
            setMsg(`Dados sincronizados automaticamente após atualização em ${state.deviceLabel || "outro dispositivo"}.`);
          }
        }
      } catch {
        // Uma falha pontual no indicador não interrompe o uso do painel.
      }
    };

    pollSharedUpdate();
    const timer = window.setInterval(pollSharedUpdate, 3_000);
    const onVisible = () => document.visibilityState === "visible" && pollSharedUpdate();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [clientId]);

  async function startSharedResume(): Promise<string | null> {
    const res = await fetch("/api/update-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "start",
        clientId,
        deviceLabel: window.innerWidth <= 900 ? "celular" : "computador",
        stage: "stops",
        total: routes.length,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSharedUpdate(data.state || null);
      setMsg(data.error || "Já existe uma atualização em andamento.");
      return null;
    }
    setSharedUpdate(data.state);
    return data.operationId;
  }

  // "Atualizar rotas" agora faz as duas coisas em sequência: atualiza a lista
  // de rotas (leve) e, em seguida, roda a varredura completa (pesada, rota por
  // rota) — um botão só, sem precisar ficar trocando de aba pra continuar o
  // processo. A atualização automática de 2 em 2 min foi removida por decisão
  // do usuário — só roda quando clicado manualmente.
  async function refresh() {
    if (lastCursor > 0) {
      const operationId = await startSharedResume();
      if (!operationId) return;
      setMsg(`Retomando a varredura na posição ${lastCursor}, sem buscar uma nova lista de rotas...`);
      await scanAllStops(operationId);
      return;
    }
    setRefreshingRoutes(true);
    setMsg("Buscando rotas no Mercado Livre...");
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          deviceLabel: window.innerWidth <= 900 ? "celular" : "computador",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.state) setSharedUpdate(data.state);
        setMsg(`Erro: ${data.error || "não foi possível atualizar as rotas."}`);
        return;
      }
      setMsg(`Rotas atualizadas (${data.count})! Buscando as paradas de cada uma...`);
      loadData();
      loadPuLive(); // PU LIVE junto, sem esperar a varredura pesada terminar
      setRefreshingRoutes(false);
      await scanAllStops(data.operationId);
    } catch (error: any) {
      setMsg(`Erro: ${error?.message || "não foi possível atualizar as rotas."}`);
    } finally {
      setRefreshingRoutes(false);
    }
  }


  async function resetDay() {
    const confirmado = window.confirm(
      "Isso vai apagar todas as rotas, paradas, o Radar e a base de Sellers AM salvas (para começar um novo dia). A sessão do Mercado Livre continua salva. Tem certeza?"
    );
    if (!confirmado) return;

    setResetting(true);
    setMsg("Zerando o painel...");
    try {
      const [res, sellersRes] = await Promise.all([
        fetch("/api/reset-day", { method: "POST" }),
        fetch("/api/sellers-am", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reset" }),
        }),
      ]);
      if (res.ok && sellersRes.ok) {
        setMsg("Painel zerado! Clica em 'Atualizar rotas' pra puxar o dia novo.");
        setRoutes([]);
        setUpdatedAt(null);
        setStops([]);
        setStopsUpdatedAt(null);
        setLastCursor(0);
        setSellersAm({});
        setSellersAmUpdatedAt(null);
        setRadarSummary({ total: 0, active: 0, pending: 0 });
      } else {
        setMsg("Erro ao zerar o painel.");
      }
    } finally {
      setResetting(false);
    }
  }

  const filtered = routes.filter((r) => {
    if (filter === "sem_inicio") {
      if (!(r.status === "pending" || (r.successfulStops === 0 && r.collectedPackages === 0))) return false;
    }
    if (filter === "com_problema") {
      if (!(r.withProblemStops > 0 || r.failedStops > 0)) return false;
    }
    if (clusterFilter !== "todos" && getCluster(r.routeName) !== clusterFilter) return false;
    if (carrierFilter !== "todas" && (r.carrierName || "-") !== carrierFilter) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    for (const sk of sortKeys) {
      let va: number;
      let vb: number;
      if (sk.key === "pacotes") {
        // "Pacotes" ordena pelo que falta coletar (pendente) — é o que importa operacionalmente.
        va = a.estimatedPackages - a.collectedPackages;
        vb = b.estimatedPackages - b.collectedPackages;
      } else {
        va = a.estimatedPackages > 0 ? a.collectedPackages / a.estimatedPackages : 0;
        vb = b.estimatedPackages > 0 ? b.collectedPackages / b.estimatedPackages : 0;
      }
      const diff = sk.dir === "desc" ? vb - va : va - vb;
      if (diff !== 0) return diff;
    }
    return 0;
  });

  function progressColor(pct: number): string {
    const hue = Math.max(0, Math.min(120, pct * 1.2));
    return `hsl(${hue}, 70%, 45%)`;
  }

  const clusters = Array.from(new Set(routes.map((r) => getCluster(r.routeName)))).sort(sortClusters);
  const carriers = Array.from(new Set(routes.map((r) => r.carrierName || "-"))).sort();

  const byCluster = clusters
    .map((c) => {
      const routesInCluster = routes.filter((r) => getCluster(r.routeName) === c);
      return {
        cluster: c,
        rotas: routesInCluster.length,
        estimado: routesInCluster.reduce((acc, r) => acc + (r.estimatedPackages || 0), 0),
        coletado: routesInCluster.reduce((acc, r) => acc + (r.collectedPackages || 0), 0),
        semInicio: routesInCluster.filter((r) => r.status === "pending").length,
        comProblema: routesInCluster.filter((r) => r.withProblemStops > 0 || r.failedStops > 0).length,
      };
    })
    .sort((a, b) => sortClusters(a.cluster as string, b.cluster as string));

  // Mapa real: agrupa as paradas já escaneadas (com lat/lng) por cluster, calculando
  // um ponto central (média) e o quanto ainda falta coletar naquele cluster.
  const clusterGeo = (() => {
    const withCoords = stops.filter((s) => typeof s.lat === "number" && typeof s.lng === "number");
    if (withCoords.length === 0) return [];
    const byC = new Map<string, { lat: number; lng: number; n: number; estimado: number; coletado: number }>();
    for (const s of withCoords) {
      const c = getCluster(s.routeName);
      const cur = byC.get(c) || { lat: 0, lng: 0, n: 0, estimado: 0, coletado: 0 };
      cur.lat += s.lat as number;
      cur.lng += s.lng as number;
      cur.n += 1;
      cur.estimado += s.estimatedPackages || 0;
      cur.coletado += s.collectedPackages || 0;
      byC.set(c, cur);
    }
    return Array.from(byC.entries()).map(([cluster, v]) => ({
      cluster,
      lat: v.lat / v.n,
      lng: v.lng / v.n,
      estimado: v.estimado,
      coletado: v.coletado,
      pendente: Math.max(v.estimado - v.coletado, 0),
    }));
  })();

  const byCarrier = carriers
    .map((c) => {
      const routesOfCarrier = routes.filter((r) => (r.carrierName || "-") === c);
      return {
        carrier: c,
        rotas: routesOfCarrier.length,
        estimado: routesOfCarrier.reduce((acc, r) => acc + (r.estimatedPackages || 0), 0),
        coletado: routesOfCarrier.reduce((acc, r) => acc + (r.collectedPackages || 0), 0),
        semInicio: routesOfCarrier.filter((r) => r.status === "pending").length,
        comProblema: routesOfCarrier.filter((r) => r.withProblemStops > 0 || r.failedStops > 0).length,
      };
    })
    .sort((a, b) => b.estimado - a.estimado);

  const semInicio = routes.filter((r) => r.status === "pending").length;
  const comProblema = routes.filter((r) => r.withProblemStops > 0 || r.failedStops > 0).length;

  const totalParadas = routes.reduce((acc, r) => acc + (r.totalStops || 0), 0);
  const totalEstimado = routes.reduce((acc, r) => acc + (r.estimatedPackages || 0), 0);
  const totalColetado = routes.reduce((acc, r) => acc + (r.collectedPackages || 0), 0);
  const totalRestante = totalEstimado - totalColetado;

  const navItems: { key: Tab; label: string; badge?: number }[] = [
    { key: "visao_geral", label: "Visão Geral" },
    { key: "diagnostico", label: "Diagnóstico" },
    { key: "radar", label: "Radar operacional", badge: radarSummary.active || undefined },
    { key: "sellers", label: "Sellers / Places" },
    { key: "sellers_am", label: "Sellers AM" },
    { key: "rotas_am", label: "Rotas AM" },
    { key: "rotas", label: "Rotas" },
  ];

  return (
    <div className="dashboard-shell" style={{ display: "flex", minHeight: "100vh" }}>
      {mobileNavOpen && <button className="mobile-nav-backdrop" aria-label="Fechar menu" onClick={() => setMobileNavOpen(false)} />}
      {/* SIDEBAR */}
      <aside
        className={`app-sidebar${mobileNavOpen ? " app-sidebar-open" : ""}`}
        style={{
          width: 240,
          background: "var(--sidebar-bg)",
          borderRight: "1px solid var(--sidebar-border)",
          padding: "24px 16px",
          position: "sticky",
          top: 0,
          height: "100vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 32, padding: "0 8px" }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
              color: "#14161a",
              fontSize: 14,
            }}
          >
            <svg width="24" height="24" viewBox="0 0 64 64" aria-label="PULSE" role="img">
              <path d="M8 34h12l6-17 10 31 7-20 5 6h8" fill="none" stroke="#14161a" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <div style={{ color: "var(--text-inverse)", fontWeight: 850, fontSize: 16, lineHeight: 1.1, letterSpacing: "0.08em" }}>
              PULSE
            </div>
            <div style={{ color: "var(--text-inverse-muted)", fontSize: 10, marginTop: 3 }}>First Mile Operations · BRRJ02</div>
          </div>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => {
                setActiveTab(item.key);
                setMobileNavOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: 10,
                border: "none",
                background: activeTab === item.key ? "rgba(255,230,0,0.12)" : "transparent",
                color: activeTab === item.key ? "var(--accent)" : "var(--text-inverse-muted)",
                fontWeight: activeTab === item.key ? 700 : 500,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              <span>{item.label}</span>
              {!!item.badge && (
                <span
                  style={{
                    background: "var(--red)",
                    color: "white",
                    fontSize: 11,
                    fontWeight: 700,
                    borderRadius: 999,
                    padding: "1px 7px",
                  }}
                >
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div style={{ marginTop: "auto", paddingTop: 16, borderTop: "1px solid var(--sidebar-border)" }}>
          <div style={{ color: "var(--text-inverse-muted)", fontSize: 11 }}>
            {updatedAt ? `Atualizado ${new Date(updatedAt).toLocaleTimeString("pt-BR")}` : "Sem dados ainda"}
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <main className="app-main" style={{ flex: 1, background: "var(--content-bg)", minHeight: "100vh" }}>
        {/* TOP BAR */}
        <div
          className="app-topbar"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 32px",
            borderBottom: "1px solid var(--border)",
            background: "var(--card-bg)",
            position: "sticky",
            top: 0,
            zIndex: 5,
          }}
        >
          <div className="topbar-title-group">
            <button className="mobile-menu-button" aria-label="Abrir menu" onClick={() => setMobileNavOpen(true)}>
              <span />
              <span />
              <span />
            </button>
            <h1 style={{ fontSize: 20, fontWeight: 700 }}>
              {navItems.find((n) => n.key === activeTab)?.label}
            </h1>
          </div>
          <div className="topbar-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {msg && <span className="topbar-message" style={{ fontSize: 12, color: "var(--text-secondary)", maxWidth: 360 }}>{msg}</span>}
            {scanProgress && scanning && (
              <span className="topbar-progress" style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {scanProgress.processed}/{scanProgress.total} rotas
                {typeof scanProgress.puladas === "number" && scanProgress.puladas > 0 ? ` · ${scanProgress.puladas} sem mudança` : ""}
              </span>
            )}
            <button className="mobile-admin-action" onClick={resetDay} disabled={actionInProgress || scanning} style={{ ...secondaryBtn, color: "var(--red)" }}>
              {resetting ? "Zerando painel..." : "Zerar painel (novo dia)"}
            </button>
            <div style={{ position: "relative" }}>
              <button onClick={refresh} disabled={actionInProgress || scanning} style={primaryBtn}>
                {remoteUpdating
                  ? "Atualização em andamento"
                  : scanning
                  ? "Varrendo paradas..."
                  : refreshingRoutes
                  ? "Buscando rotas..."
                  : lastCursor > 0
                  ? `Continuar varredura (rota ${lastCursor})`
                  : "Atualizar rotas"}
              </button>
              {scanning && scanProgress && scanProgress.total > 0 && (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: -5,
                    height: 3,
                    background: "rgba(0,0,0,0.08)",
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, Math.round((scanProgress.processed / scanProgress.total) * 100))}%`,
                      height: "100%",
                      background: "var(--accent)",
                      transition: "width 0.3s",
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {sharedUpdate?.status === "running" && (
          <div className="shared-update-banner" role="status" aria-live="polite">
            <span className="shared-update-pulse" />
            <strong>Atualização em andamento</strong>
            <span>
              em {sharedUpdate.deviceLabel || "outro dispositivo"}
              {sharedUpdate.stage === "routes"
                ? " · buscando rotas"
                : sharedUpdate.stage === "radar"
                ? " · consolidando o Radar"
                : sharedUpdate.total > 0
                ? ` · ${sharedUpdate.processed}/${sharedUpdate.total} rotas`
                : " · buscando paradas"}
            </span>
          </div>
        )}

        <div className="app-content" style={{ padding: 32, maxWidth: 1280, margin: "0 auto" }}>
          {/* SESSION BOX — sempre visível, discreto */}
          <details className="admin-session" style={{ marginBottom: 24 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-secondary)" }}>
              Sessão do Mercado Livre {cookie ? "" : "(clica pra colar o cookie)"}
            </summary>
            <div style={{ ...cardStyle, marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
                Cola aqui o cookie: pode ser a string "nome=valor; nome2=valor2" direto, OU a tabela inteira que
                você copia do DevTools (Application → Cookies → Ctrl+A → Ctrl+C) — o app reconhece os dois formatos
                sozinho.
              </p>
              <textarea
                value={cookie}
                onChange={(e) => setCookie(e.target.value)}
                placeholder="Cole aqui (string de cookie ou a tabela copiada do DevTools)"
                rows={4}
                style={{ padding: 8, borderRadius: 8, border: "1px solid var(--border)", fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
              />
              <button onClick={saveSession} disabled={actionInProgress || scanning || !cookie} style={{ ...secondaryBtn, alignSelf: "flex-start" }}>
                {savingSession ? "Validando e salvando..." : "Salvar sessão"}
              </button>
            </div>
          </details>

          {activeTab === "visao_geral" && (
            <>
              <KpiRow>
                <Kpi label="Rotas" value={routes.length} />
                <Kpi label="Total de paradas" value={totalParadas.toLocaleString("pt-BR")} />
                <Kpi label="Pacotes estimados" value={totalEstimado.toLocaleString("pt-BR")} />
                <Kpi
                  label="Coletados"
                  value={totalColetado.toLocaleString("pt-BR")}
                  color="var(--green)"
                  pct={totalEstimado > 0 ? (totalColetado / totalEstimado) * 100 : 0}
                />
                <Kpi
                  label="Restantes"
                  value={totalRestante.toLocaleString("pt-BR")}
                  color="var(--orange)"
                  pct={totalEstimado > 0 ? (totalRestante / totalEstimado) * 100 : 0}
                />
              </KpiRow>

              <SectionTitle>Alertas</SectionTitle>
              <KpiRow>
                <Kpi
                  label="Sem início"
                  value={semInicio}
                  color="var(--red)"
                  onClick={() => {
                    setFilter("sem_inicio");
                    setActiveTab("rotas");
                  }}
                />
                <Kpi
                  label="Com problema"
                  value={comProblema}
                  color="var(--orange)"
                  onClick={() => {
                    setFilter("com_problema");
                    setActiveTab("rotas");
                  }}
                />
                <Kpi
                  label="Radar ativo"
                  value={radarSummary.active}
                  color="var(--red)"
                  sub={`${radarSummary.pending.toLocaleString("pt-BR")} pacotes pendentes`}
                  onClick={() => setActiveTab("radar")}
                />
              </KpiRow>

              <SectionTitle>Detalhamento operacional</SectionTitle>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <button
                  onClick={() => setOverviewBreakdown("clusters")}
                  style={{ ...secondaryBtn, border: overviewBreakdown === "clusters" ? "2px solid #14161a" : "1px solid var(--border)" }}
                >
                  Clusters
                </button>
                <button
                  onClick={() => setOverviewBreakdown("transportadoras")}
                  style={{ ...secondaryBtn, border: overviewBreakdown === "transportadoras" ? "2px solid #14161a" : "1px solid var(--border)" }}
                >
                  Transportadoras
                </button>
              </div>
              <div style={cardStyle}>
                {overviewBreakdown === "clusters" ? (
                  <Table
                    headers={["Cluster", "Pontos", "Rotas", "Preparado", "Coletado", "Pendente real", "% coletado"]}
                    rows={operationalClusterRows.map((c) => [
                      c.cluster,
                      c.total,
                      c.rotas,
                      c.preparado.toLocaleString("pt-BR"),
                      c.coletado.toLocaleString("pt-BR"),
                      c.pendente.toLocaleString("pt-BR"),
                      `${c.pctColetado}%`,
                    ])}
                    onRowClick={(i) => {
                      setSellerClusterFilter(operationalClusterRows[i].cluster);
                      setActiveTab("sellers");
                    }}
                  />
                ) : (
                  <Table
                    headers={["Transportadora", "Pontos", "Preparado", "Coletado", "Pendente real", "% coletado", "Reatribuir"]}
                    rows={operationalCarrierRows.map((c) => [
                      c.carrier,
                      c.total,
                      c.preparado.toLocaleString("pt-BR"),
                      c.coletado.toLocaleString("pt-BR"),
                      c.pendente.toLocaleString("pt-BR"),
                      `${c.pctColetado}%`,
                      c.reatribuir,
                    ])}
                  />
                )}
              </div>
            </>
          )}

          {activeTab === "diagnostico" && (
            <>
              {(() => {
                const carriersRanked = [...byCarrier]
                  .map((c) => ({ ...c, pct: c.estimado > 0 ? Math.round((c.coletado / c.estimado) * 100) : 0 }))
                  .sort((a, b) => b.estimado - a.estimado);
                const clustersRanked = [...byCluster]
                  .map((c) => ({
                    ...c,
                    label: c.cluster === "—" ? "Sem cluster (rotas avulsas)" : c.cluster,
                    pct: c.estimado > 0 ? Math.round((c.coletado / c.estimado) * 100) : 0,
                  }))
                  // "Sem cluster" sempre por último, o resto em ordem alfabética/numérica normal
                  .sort((a, b) => {
                    if (a.cluster === "—") return 1;
                    if (b.cluster === "—") return -1;
                    return sortClusters(a.cluster as string, b.cluster as string);
                  });

                const top5Volume = [...sellerRows].sort((a, b) => (b.estimado || 0) - (a.estimado || 0)).slice(0, 5);
                const top5Impacto = [...sellerRows].sort((a, b) => (b.pendente || 0) - (a.pendente || 0)).slice(0, 5);
                const visitasReconciliadas = sellerRows.filter((row) => (row.sobreposicaoRemovida || 0) > 0);
                const totalSobreposicaoRemovida = visitasReconciliadas.reduce(
                  (acc, row) => acc + (row.sobreposicaoRemovida || 0),
                  0
                );
                const maiorColetaReconciliada = [...visitasReconciliadas].sort(
                  (a, b) => (b.sobreposicaoRemovida || 0) - (a.sobreposicaoRemovida || 0)
                )[0];
                const metricsOf = (row: any) => ({ pendente: row.pendente, preparado: row.preparado, coletado: row.coletado });
                const clusterMaiorImpacto = buildLargestImpactGroup(
                  sellerRows,
                  (row) => row.cluster || "Sem cluster",
                  metricsOf
                );
                const transportadoraMaiorImpacto = buildHighestProportionalImpactGroup(
                  sellerRows,
                  (row) => row.rotaOperacional?.carrierName || row.ultimaRota?.carrierName || "Sem transportadora",
                  metricsOf
                );
                const transportadoraMaiorImpactoBruto = buildLargestImpactGroup(
                  sellerRows,
                  (row) => row.rotaOperacional?.carrierName || row.ultimaRota?.carrierName || "Sem transportadora",
                  metricsOf
                );
                const pontoMaiorImpacto = top5Impacto[0]
                  ? buildLargestImpactGroup([top5Impacto[0]], (row) => row.name, metricsOf)
                  : null;
                const cancelledScheduledRoutes = routes.filter(isScheduledCancelledRoute);
                const cancelledScheduledRouteIds = new Set(cancelledScheduledRoutes.map((route) => Number(route.id)));
                const cancelledScheduledPoints = sellerRows.filter((row) =>
                  row.rotas.some((route: any) => cancelledScheduledRouteIds.has(Number(route.routeId)))
                );
                const cancelledScheduledPending = cancelledScheduledPoints.reduce(
                  (sum, row) => sum + (row.pendente || 0),
                  0
                );
                const clustersAbaixoMeta = operationalClusterRows.filter(
                  (cluster) => cluster.preparado > 0 && cluster.coletado / cluster.preparado < 0.93
                );
                const pendenteClustersAbaixoMeta = clustersAbaixoMeta.reduce((sum, cluster) => sum + cluster.pendente, 0);
                const ImpactCard = ({ titulo, item, icone, proporcional = false }: { titulo: string; item: any; icone: string; proporcional?: boolean }) => (
                  <div className="closing-card" style={{ ...cardStyle, flex: 1, borderTop: "4px solid var(--orange)" }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 700 }}>{icone} {titulo}</div>
                    <div style={{ fontSize: 18, lineHeight: 1.15, fontWeight: 900, margin: "5px 0" }}>{item?.nome || "Sem dados"}</div>
                    {item && (
                      <>
                        <div style={{ fontSize: 23, fontWeight: 900, color: "var(--red)" }}>
                          {item.pendente.toLocaleString("pt-BR")}
                          <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 5 }}>pacotes não coletados</span>
                        </div>
                        <div style={{ fontSize: 11, marginTop: 6 }}>
                          <b>{item.taxaColeta.toFixed(1).replace(".", ",")}%</b> coletado · <b>{item.percentualDaMeta.toFixed(1).replace(".", ",")}%</b> da meta de 93%
                        </div>
                        {proporcional && typeof item.taxaImpacto === "number" && (
                          <div style={{ fontSize: 10, lineHeight: 1.3, color: "var(--text-secondary)", marginTop: 3 }}>
                            {item.taxaImpacto.toFixed(1).replace(".", ",")}% de impacto proporcional · comparação entre operações com volume relevante
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: item.faltaParaMeta > 0 ? "var(--orange)" : "var(--green)", marginTop: 3 }}>
                          {item.faltaParaMeta > 0
                            ? `Faltam ${item.faltaParaMeta.toLocaleString("pt-BR")} pacotes para a meta`
                            : "Meta operacional atingida"}
                          {` · ${item.pontos} ponto(s)`}
                        </div>
                      </>
                    )}
                  </div>
                );
                const IndicatorCard = ({ titulo, icone, valor, unidade, detalhe, cor = "var(--red)" }: any) => (
                  <div className="closing-card" style={{ ...cardStyle, borderTop: `4px solid ${cor}` }}>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 700 }}>{icone} {titulo}</div>
                    <div style={{ fontSize: 23, fontWeight: 900, color: cor, margin: "7px 0 3px" }}>
                      {valor}
                      {unidade && <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 5 }}>{unidade}</span>}
                    </div>
                    <div style={{ fontSize: 10, lineHeight: 1.35, color: "var(--text-secondary)" }}>{detalhe}</div>
                  </div>
                );

                const piorCarrier = carriersRanked.length > 0 ? [...carriersRanked].sort((a, b) => a.pct - b.pct)[0] : null;
                const melhorCarrier = carriersRanked.length > 0 ? [...carriersRanked].sort((a, b) => b.pct - a.pct)[0] : null;
                const piorCluster = clustersRanked.length > 0 ? [...clustersRanked].sort((a, b) => a.pct - b.pct)[0] : null;
                const qtdReatribuir = sellerRows.filter((r) => r.status === "Reatribuir").length;

                return (
                  <>
                    <h2 style={{ fontSize: 18, fontWeight: 800, margin: "0 0 4px" }}>📊 Diagnóstico</h2>
                    <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
                      Diagnóstico gerado a partir dos dados atuais — {new Date().toLocaleString("pt-BR")}
                    </p>

                    <SectionTitle>Visão geral do dia</SectionTitle>
                    <KpiRow>
                      <Kpi label="Rotas" value={routes.length} />
                      <Kpi label="Total de paradas" value={totalParadas.toLocaleString("pt-BR")} />
                      <Kpi label="Estimado" value={totalEstimado.toLocaleString("pt-BR")} />
                      <Kpi label="Coletado" value={totalColetado.toLocaleString("pt-BR")} color="var(--green)" />
                      <Kpi label="Restante" value={totalRestante.toLocaleString("pt-BR")} color="var(--orange)" />
                    </KpiRow>

                    {puLive ? (
                      (() => {
                        const restante = puLive.estimatedPackages - puLive.collectedPackages;
                        const pctColetado = puLive.estimatedPackages > 0 ? (puLive.collectedPackages / puLive.estimatedPackages) * 100 : 0;
                        const pctRestante = puLive.estimatedPackages > 0 ? (restante / puLive.estimatedPackages) * 100 : 0;
                        const META_PCT = 0.93; // 93%
                        const metaPacotes = Math.ceil(puLive.estimatedPackages * META_PCT);
                        const faltaParaMeta = Math.max(metaPacotes - puLive.collectedPackages, 0);
                        const metaBatida = faltaParaMeta === 0;
                        const Coluna = ({ label, valor, sub, cor }: { label: string; valor: string; sub?: string; cor?: string }) => (
                          <div className={`pu-live-column${label.startsWith("Falta") ? " pu-live-target" : ""}`}>
                            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 2 }}>{label}</div>
                            <div style={{ fontSize: 18, fontWeight: 800, color: cor || "var(--text-primary)" }}>
                              {valor}
                              {sub && <span style={{ fontSize: 12, fontWeight: 600, marginLeft: 4 }}>{sub}</span>}
                            </div>
                          </div>
                        );
                        return (
                          <div
                            className="pu-live-card"
                            style={{
                              ...cardStyle,
                              marginBottom: 24,
                              padding: "12px 16px",
                            }}
                          >
                            <div
                              className="pu-live-badge"
                              style={{
                                fontSize: 13,
                                fontWeight: 800,
                                color: "var(--accent)",
                                background: "#14161a",
                                padding: "4px 10px",
                                borderRadius: 6,
                                whiteSpace: "nowrap",
                              }}
                            >
                              PU LIVE
                            </div>
                            <div className="pu-live-metrics">
                              <Coluna label="Estimados" valor={puLive.estimatedPackages.toLocaleString("pt-BR")} />
                              <Coluna
                                label="Coletados"
                                valor={puLive.collectedPackages.toLocaleString("pt-BR")}
                                sub={`${pctColetado.toFixed(1).replace(".", ",")}%`}
                                cor="var(--green)"
                              />
                              <Coluna
                                label="Restantes"
                                valor={restante.toLocaleString("pt-BR")}
                                sub={`${pctRestante.toFixed(1).replace(".", ",")}%`}
                                cor="var(--orange)"
                              />
                              <Coluna
                                label="Falta p/ meta (93%)"
                                valor={metaBatida ? "Meta batida! 🎉" : faltaParaMeta.toLocaleString("pt-BR")}
                                cor={metaBatida ? "var(--green)" : "var(--red)"}
                              />
                            </div>
                            <button className="pu-live-refresh" onClick={loadPuLive} title="Atualizar PU LIVE" style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15 }}>
                              🔄
                            </button>
                          </div>
                        );
                      })()
                    ) : (
                      <div style={{ ...cardStyle, marginBottom: 24, fontSize: 13, color: "var(--text-secondary)" }}>
                        Buscando o PU LIVE...
                      </div>
                    )}

                    <SectionTitle>Fechamento operacional</SectionTitle>
                    <div className="closing-grid">
                      <ImpactCard titulo="Cluster com maior impacto" item={clusterMaiorImpacto} icone="📍" />
                      <ImpactCard titulo="Transportadora com maior impacto proporcional" item={transportadoraMaiorImpacto} icone="🚚" proporcional />
                      <ImpactCard titulo="Transportadora com maior impacto bruto" item={transportadoraMaiorImpactoBruto} icone="📊" />
                      <ImpactCard titulo="Ponto com maior impacto" item={pontoMaiorImpacto} icone="📦" />
                      <IndicatorCard
                        titulo="Rotas canceladas (no-show)"
                        icone="🚫"
                        valor={cancelledScheduledRoutes.length.toLocaleString("pt-BR")}
                        unidade="rotas"
                        detalhe={`${cancelledScheduledPoints.length.toLocaleString("pt-BR")} ponto(s) · ${cancelledScheduledPending.toLocaleString("pt-BR")} pendentes reais · somente programadas, com zero coleta e todas as paradas em insucesso`}
                      />
                      <IndicatorCard
                        titulo="Pontos sem cobertura"
                        icone="⚠️"
                        valor={radarSummary.active.toLocaleString("pt-BR")}
                        unidade="pontos ativos"
                        detalhe={`${radarSummary.pending.toLocaleString("pt-BR")} pacotes pendentes no Radar`}
                      />
                      <IndicatorCard
                        titulo="Recuperados em outra rota"
                        icone="🔄"
                        valor={totalSobreposicaoRemovida.toLocaleString("pt-BR")}
                        unidade="pacotes reconciliados"
                        detalhe={`${visitasReconciliadas.length.toLocaleString("pt-BR")} ponto(s)${maiorColetaReconciliada ? ` · maior recuperação: ${maiorColetaReconciliada.name}` : ""}`}
                        cor="var(--green)"
                      />
                      <IndicatorCard
                        titulo="Clusters abaixo da meta"
                        icone="📉"
                        valor={clustersAbaixoMeta.length.toLocaleString("pt-BR")}
                        unidade="clusters abaixo de 93%"
                        detalhe={`${pendenteClustersAbaixoMeta.toLocaleString("pt-BR")} pacotes pendentes nesses clusters`}
                        cor="var(--orange)"
                      />
                    </div>

                    <SectionTitle>💡 Insights</SectionTitle>
                    <div style={{ ...cardStyle, marginBottom: 24, display: "flex", flexDirection: "column", gap: 8 }}>
                      {melhorCarrier && (
                        <div style={{ fontSize: 13 }}>
                          🟢 <b>{melhorCarrier.carrier}</b> tem a melhor taxa de coleta entre as transportadoras com volume
                          relevante ({melhorCarrier.pct}%).
                        </div>
                      )}
                      {piorCarrier && (
                        <div style={{ fontSize: 13 }}>
                          🔴 <b>{piorCarrier.carrier}</b> tem a pior taxa de coleta ({piorCarrier.pct}%) — vale investigar.
                        </div>
                      )}
                      {piorCluster && (
                        <div style={{ fontSize: 13 }}>
                          📍 Cluster <b>{piorCluster.cluster}</b> é o que está com a menor taxa de coleta no momento (
                          {piorCluster.pct}%).
                        </div>
                      )}
                      {qtdReatribuir > 0 && (
                        <div style={{ fontSize: 13 }}>
                          ⚠️ <b>{qtdReatribuir}</b> seller(s)/place(s) precisam de reatribuição agora.
                        </div>
                      )}
                      {totalSobreposicaoRemovida > 0 && (
                        <div style={{ fontSize: 13 }}>
                          🔄 <b>{totalSobreposicaoRemovida.toLocaleString("pt-BR")}</b> pacote(s) de atribuições repetidas foram
                          reconciliados porque outra rota já confirmou a coleta em {visitasReconciliadas.length} ponto(s).
                        </div>
                      )}
                      {maiorColetaReconciliada && (
                        <div style={{ fontSize: 13 }}>
                          ✅ <b>{maiorColetaReconciliada.name}</b>: {maiorColetaReconciliada.coletado.toLocaleString("pt-BR")} coletados
                          de verdade; {(maiorColetaReconciliada.pendente || 0).toLocaleString("pt-BR")} pendente(s) real(is) após
                          conciliar as visitas.
                        </div>
                      )}
                      {top5Impacto[0] && (
                        <div style={{ fontSize: 13 }}>
                          📦 Maior pendente individual: <b>{top5Impacto[0].name}</b> ({(top5Impacto[0].pendente || 0).toLocaleString("pt-BR")} pacotes pendentes).
                        </div>
                      )}
                    </div>

                    <SectionTitle>Performance por Transportadora</SectionTitle>
                    <div style={{ ...cardStyle, marginBottom: 24 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr style={{ textAlign: "left" }}>
                            <th style={th}>Transportadora</th>
                            <th style={th}>Rotas</th>
                            <th style={th}>Estimado</th>
                            <th style={th}>Coletado</th>
                            <th style={th}>% Coletado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {carriersRanked.map((c) => (
                            <tr key={c.carrier} style={{ borderTop: "1px solid var(--border)" }}>
                              <td style={td}>{c.carrier}</td>
                              <td style={td}>{c.rotas}</td>
                              <td style={td}>{c.estimado.toLocaleString("pt-BR")}</td>
                              <td style={td}>{c.coletado.toLocaleString("pt-BR")}</td>
                              <td style={td}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <div style={{ width: 80, height: 8, background: "#eee", borderRadius: 4, overflow: "hidden" }}>
                                    <div style={{ width: `${c.pct}%`, height: "100%", background: progressColor(c.pct) }} />
                                  </div>
                                  <span>{c.pct}%</span>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
                      <div style={{ ...cardStyle, flex: 1, minWidth: 320 }}>
                        <div style={{ fontWeight: 700, marginBottom: 8 }}>🏆 Top 5 — maior volume (Estimado)</div>
                        {top5Volume.map((r, i) => (
                          <div key={r.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0", borderTop: i > 0 ? "1px solid var(--border)" : "none" }}>
                            <span>{i + 1}. {r.name}</span>
                            <span style={{ fontWeight: 700 }}>{(r.estimado || 0).toLocaleString("pt-BR")}</span>
                          </div>
                        ))}
                      </div>
                      <div style={{ ...cardStyle, flex: 1, minWidth: 320 }}>
                        <div style={{ fontWeight: 700, marginBottom: 8 }}>🔥 Top 5 — maior impacto (Pendente)</div>
                        {top5Impacto.map((r, i) => (
                          <div key={r.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "6px 0", borderTop: i > 0 ? "1px solid var(--border)" : "none" }}>
                            <span>{i + 1}. {r.name}</span>
                            <span style={{ fontWeight: 700, color: "var(--red)" }}>{(r.pendente || 0).toLocaleString("pt-BR")}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <SectionTitle>Performance por Cluster</SectionTitle>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
                        gap: 12,
                        marginBottom: 24,
                      }}
                    >
                      {clustersRanked.map((c) => (
                        <div
                          key={c.cluster}
                          onClick={() => {
                            setClusterFilter(c.cluster);
                            setActiveTab("rotas");
                          }}
                          style={{
                            ...cardStyle,
                            cursor: "pointer",
                            opacity: c.cluster === "—" ? 0.75 : 1,
                            borderStyle: c.cluster === "—" ? "dashed" : "solid",
                          }}
                        >
                          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{c.label}</div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 8 }}>
                            <span style={{ fontSize: 24, fontWeight: 800, color: progressColor(c.pct) }}>{c.pct}%</span>
                            <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>coletado</span>
                          </div>
                          <div style={{ width: "100%", height: 6, background: "#eee", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
                            <div style={{ width: `${c.pct}%`, height: "100%", background: progressColor(c.pct) }} />
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                            {c.rotas} rota(s) · {c.estimado.toLocaleString("pt-BR")} est. · {c.coletado.toLocaleString("pt-BR")} colet.
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                );
              })()}
            </>
          )}

          {activeTab === "radar" && (
            <RadarTab
              stopsUpdatedAt={stopsUpdatedAt}
              stopsCount={stops.length}
              lastCursor={lastCursor}
              onResetCursor={() => setLastCursor(0)}
              onSummaryChange={setRadarSummary}
            />
          )}

          {activeTab === "sellers" && (
            <>
              {(csvMsg || stops.length === 0) && (
                <div style={{ ...cardStyle, marginBottom: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  {csvMsg && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{csvMsg}</span>}
                  {stops.length === 0 && (
                    <span style={{ fontSize: 12, color: "var(--orange)" }}>
                      Sem dados de paradas ainda — use Atualizar rotas para executar a varredura e alimentar esta visão.
                    </span>
                  )}
                </div>
              )}

              <KpiRow>
                <Kpi label="Sellers / Places" value={sellerKpis.total} />
                <Kpi label="Estimado" value={sellerKpis.estimado.toLocaleString("pt-BR")} />
                <Kpi
                  label="Preparado"
                  value={sellerKpis.preparado.toLocaleString("pt-BR")}
                  sub={pct(sellerKpis.preparado, sellerKpis.estimado)}
                />
                <Kpi
                  label="Coletado"
                  value={sellerKpis.coletado.toLocaleString("pt-BR")}
                  color="var(--green)"
                  sub={pct(sellerKpis.coletado, sellerKpis.preparado)}
                />
                <Kpi
                  label="Pendente"
                  value={sellerKpis.pendente.toLocaleString("pt-BR")}
                  color="var(--orange)"
                  sub={pct(sellerKpis.pendente, sellerKpis.preparado)}
                />
              </KpiRow>

              <SectionTitle>Impacto por cluster</SectionTitle>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
                  gap: 12,
                  marginBottom: 20,
                }}
              >
                {sellerClusterSummaries.map((summary) => {
                  const active = sellerClusterFilter === summary.cluster;
                  return (
                    <button
                      key={summary.cluster}
                      onClick={() => setSellerClusterFilter(active ? "todos" : summary.cluster)}
                      style={{
                        ...cardStyle,
                        textAlign: "left",
                        cursor: "pointer",
                        color: "var(--text-primary)",
                        border: active ? "2px solid #14161a" : "1px solid var(--border)",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 15, fontWeight: 850 }}>{summary.cluster}</span>
                        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{summary.total} ponto(s)</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginTop: 10 }}>
                        <span style={{ fontSize: 24, fontWeight: 850, color: summary.pendente > 0 ? "var(--red)" : "var(--green)" }}>
                          {summary.pendente.toLocaleString("pt-BR")}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>pendentes</span>
                      </div>
                      <div style={{ height: 6, borderRadius: 999, background: "#e5e7eb", overflow: "hidden", margin: "8px 0" }}>
                        <div
                          style={{
                            width: `${Math.min(summary.pctColetado, 100)}%`,
                            height: "100%",
                            background: progressColor(summary.pctColetado),
                          }}
                        />
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                        {summary.pctColetado}% coletado · {summary.reatribuir} para reatribuir
                      </div>
                    </button>
                  );
                })}
              </div>

              <SectionTitle>Alertas (clica pra filtrar a tabela)</SectionTitle>
              <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                {sellerCards.map((c) => {
                  const count = sellerRowsClusterScope.filter(c.test).length;
                  const active = sellerCard === c.key;
                  return (
                    <div
                      key={c.key}
                      onClick={() => setSellerCard(active ? null : c.key)}
                      style={{
                        ...cardStyle,
                        flex: 1,
                        minWidth: 160,
                        cursor: "pointer",
                        border: active ? "2px solid #14161a" : "1px solid var(--border)",
                        padding: 16,
                      }}
                    >
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>{c.label}</div>
                      <div style={{ fontSize: 22, fontWeight: 800 }}>{count}</div>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
                <div style={{ ...cardStyle, flex: 1, minWidth: 280 }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>Top 5 — mais pacotes pendentes</div>
                  {top5Pendente.length === 0 ? (
                    <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Nenhum pendente.</div>
                  ) : (
                    top5Pendente.map((r) => (
                      <div key={r.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0" }}>
                        <span>{r.name}</span>
                        <span style={{ color: "var(--orange)", fontWeight: 600 }}>{r.pendente}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div style={{ ...cardStyle, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
                <input
                  value={sellerSearch}
                  onChange={(e) => setSellerSearch(e.target.value)}
                  placeholder="Buscar por nome ou ID..."
                  style={{ flex: 1, minWidth: 200, padding: 9, borderRadius: 8, border: "1px solid var(--border)" }}
                />
                <select value={sellerClusterFilter} onChange={(e) => setSellerClusterFilter(e.target.value)} style={selectStyle}>
                  <option value="todos">Todos os clusters</option>
                  {sellerClusters.map((cluster) => (
                    <option key={cluster} value={cluster}>{cluster}</option>
                  ))}
                </select>
                <select
                  value={`${spSortKey}-${spSortDir}`}
                  onChange={(e) => {
                    const [key, direction] = e.target.value.split("-") as [typeof spSortKey, typeof spSortDir];
                    setSpSortKey(key);
                    setSpSortDir(direction);
                  }}
                  style={selectStyle}
                  title="Ordenar os pontos da tabela"
                >
                  <option value="pendente-desc">Impacto: maior → menor</option>
                  <option value="pendente-asc">Impacto: menor → maior</option>
                  <option value="coletado-desc">Coletado: maior → menor</option>
                  <option value="preparado-desc">Preparado: maior → menor</option>
                  <option value="estimado-desc">Estimado: maior → menor</option>
                </select>
                {sellerClusterFilter !== "todos" && (
                  <button onClick={() => setSellerClusterFilter("todos")} style={{ ...secondaryBtn, padding: "6px 10px" }}>
                    Limpar cluster
                  </button>
                )}
                {sellerCard && (
                  <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                    Filtro: {sellerCards.find((c) => c.key === sellerCard)?.label} ({sellersFiltered.length})
                    <button onClick={() => setSellerCard(null)} style={{ ...secondaryBtn, marginLeft: 8, padding: "4px 10px" }}>
                      Limpar filtro
                    </button>
                  </span>
                )}
                <button onClick={copySellerIds} style={secondaryBtn}>
                  Copiar IDs ({sellersFiltered.length})
                </button>
              </div>

              <details style={{ marginBottom: 16 }}>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-secondary)" }}>
                  ⚡ Pesquisar ao vivo (busca direto no Mercado Livre, sem precisar estar em nenhuma base — clica pra abrir)
                </summary>
                <div style={{ ...cardStyle, marginTop: 8 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
                    <textarea
                      value={pesquisaIdsInput}
                      onChange={(e) => setPesquisaIdsInput(e.target.value)}
                      placeholder={"849817033_100637\nBRP18169709922\n1224143462\n..."}
                      rows={2}
                      style={{
                        flex: 1,
                        minWidth: 240,
                        padding: 8,
                        borderRadius: 8,
                        border: "1px solid var(--border)",
                        fontFamily: "monospace",
                        fontSize: 12,
                        boxSizing: "border-box",
                      }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <button onClick={pesquisarIdsEmLote} disabled={pesquisaLoading || !pesquisaIdsInput.trim()} style={primaryBtn}>
                        {pesquisaLoading ? "Pesquisando..." : "🔎 Pesquisar"}
                      </button>
                      {(pesquisaIdsInput || pesquisaResultados.length > 0) && (
                        <button
                          onClick={() => {
                            setPesquisaIdsInput("");
                            setPesquisaResultados([]);
                          }}
                          style={secondaryBtn}
                        >
                          Limpar busca
                        </button>
                      )}
                    </div>
                  </div>

                  {pesquisaResultados.length > 0 && (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                        gap: 10,
                      }}
                    >
                      {pesquisaResultados.map((r) => (
                        <div
                          key={r.id}
                          style={{
                            ...cardStyle,
                            padding: 12,
                            borderColor: r.ok ? "var(--border)" : "var(--red)",
                          }}
                        >
                          {r.ok ? (
                            <>
                              <div style={{ fontWeight: 700, fontSize: 13 }}>
                                {r.summary?.customerName}
                                {r.usouIdCru && <span title="Precisou do ID cru"> ⚠️</span>}
                              </div>
                              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                                {r.id} · {r.tipoTestado === "place" ? "Place" : "Seller"}
                              </div>
                              <div style={{ display: "flex", gap: 10, marginTop: 8, fontSize: 12 }}>
                                <span>
                                  Est. <b>{r.summary?.estimado?.toLocaleString("pt-BR")}</b>
                                </span>
                                <span>
                                  Prep. <b>{r.summary?.preparado?.toLocaleString("pt-BR")}</b>
                                </span>
                                <span style={{ color: "var(--green)" }}>
                                  Colet. <b>{r.summary?.coletado?.toLocaleString("pt-BR")}</b>
                                </span>
                              </div>
                              {r.rotas?.length > 0 && (
                                <div style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                                  {r.rotas.map((rt: any, i: number) => (
                                    <div key={i} style={{ fontSize: 11, color: "var(--text-secondary)", padding: "2px 0" }}>
                                      {rt.rota} · {rt.intervalo} · {rt.status}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              <div style={{ fontWeight: 700, fontSize: 13 }}>{r.id}</div>
                              <div style={{ fontSize: 12, color: "var(--red)" }}>{r.erro}</div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </details>

              <div style={cardStyle}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ textAlign: "left" }}>
                      <th style={th}>Seller / Place</th>
                      <th style={th}>Cluster</th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleSpSort("estimado")}>
                        Estimado{sortArrow(spSortKey === "estimado", spSortDir)}
                      </th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleSpSort("preparado")}>
                        Preparado{sortArrow(spSortKey === "preparado", spSortDir)}
                      </th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleSpSort("coletado")}>
                        Coletado{sortArrow(spSortKey === "coletado", spSortDir)}
                      </th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleSpSort("pendente")}>
                        Pendente{sortArrow(spSortKey === "pendente", spSortDir)}
                      </th>
                      <th style={th}>Status</th>
                      <th style={th}>Última rota</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sellersFiltered.length === 0 ? (
                      <tr>
                        <td style={td} colSpan={8}>
                          Nenhum seller encontrado. {stops.length === 0 && "Use Atualizar rotas para executar a varredura primeiro."}
                        </td>
                      </tr>
                    ) : (
                      sellersFiltered.map((r) => (
                        <Fragment key={r.id}>
                          <tr key={r.id} style={{ borderTop: "1px solid var(--border)" }}>
                            <td style={td}>
                              <div style={{ fontWeight: 600 }}>
                                {r.name} {r.dadoSuspeito && <span title="Dado suspeito">🚩</span>}
                              </div>
                              <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                                {r.id}{" "}
                                {r.rotas.length > 0 && (
                                  <span
                                    onClick={() => setExpandedSeller(expandedSeller === r.id ? null : r.id)}
                                    style={{ cursor: "pointer", color: "#2563eb" }}
                                  >
                                    🔍 {r.rotas.length} rota(s)
                                  </span>
                                )}
                                {r.sobreposicaoRemovida > 0 && (
                                  <span
                                    title="Pacotes repetidos em mais de uma atribuição e já cobertos por outra coleta"
                                    style={{ marginLeft: 6, color: "var(--green)" }}
                                  >
                                    · {r.sobreposicaoRemovida.toLocaleString("pt-BR")} sobrepostos reconciliados
                                  </span>
                                )}
                              </div>
                            </td>
                            <td style={td}>
                              <button
                                onClick={() => setSellerClusterFilter(r.cluster)}
                                style={{ ...secondaryBtn, padding: "4px 8px", fontSize: 11 }}
                                title="Filtrar por este cluster"
                              >
                                {r.cluster}
                              </button>
                              {r.clusterFromHistory && (
                                <div
                                  title={r.clusterSourceRoute ? `Cluster recuperado da rota ${r.clusterSourceRoute}` : "Cluster recuperado do histórico do ponto"}
                                  style={{ fontSize: 10, color: "var(--orange)", marginTop: 3 }}
                                >
                                  histórico do ponto{r.clusterSourceRoute ? ` · ${r.clusterSourceRoute}` : ""}
                                </div>
                              )}
                              {r.clusters.length > 1 && (
                                <div style={{ fontSize: 10, color: "var(--text-secondary)", marginTop: 3 }}>
                                  histórico: {r.clusters.join(" → ")}
                                </div>
                              )}
                            </td>
                            <td style={td}>{r.estimado || "-"}</td>
                            <td style={td}>{r.preparado}</td>
                            <td style={td}>{r.coletado}</td>
                            <td style={td}>
                              <span style={{ color: r.pendente > 0 ? "var(--red)" : "var(--green)", fontWeight: 700 }}>
                                {r.pendente}
                              </span>
                            </td>
                            <td style={td}>
                              <select
                                value={r.status}
                                onChange={(e) => setSellerStatus(r.id, e.target.value)}
                                style={selectStyle}
                              >
                                {["Coletado", "Pendente", "Perdido", "2ª Visita", "Reatribuir", "Sem Início"].map((s) => (
                                  <option key={s} value={s}>
                                    {s}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td style={td}>
                              {r.ultimaRota ? `${r.ultimaRota.rota} (${r.ultimaRota.status})` : "Aguardando/Sem início"}
                            </td>
                          </tr>
                          {expandedSeller === r.id && (
                            <tr>
                              <td style={{ ...td, background: "#fafafa" }} colSpan={8}>
                                <table style={{ width: "100%", fontSize: 13 }}>
                                  <thead>
                                    <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                                      <th style={{ padding: "4px 8px" }}>Rota</th>
                                      <th style={{ padding: "4px 8px" }}>Intervalo</th>
                                      <th style={{ padding: "4px 8px" }}>Preparado</th>
                                      <th style={{ padding: "4px 8px" }}>Coletado</th>
                                      <th style={{ padding: "4px 8px" }}>Restante</th>
                                      <th style={{ padding: "4px 8px" }}>Status</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {r.rotas.map((rt, i) => (
                                      <tr key={i}>
                                        <td style={{ padding: "4px 8px" }}>{rt.rota}</td>
                                        <td style={{ padding: "4px 8px" }}>{rt.intervalo}</td>
                                        <td style={{ padding: "4px 8px" }}>{rt.preparadosRota}</td>
                                        <td style={{ padding: "4px 8px" }}>{rt.coletadosRota}</td>
                                        <td style={{ padding: "4px 8px" }}>{rt.restantesRota}</td>
                                        <td style={{ padding: "4px 8px" }}>{rt.status}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}


          {activeTab === "sellers_am" && (
            <>
              <div style={{ ...cardStyle, marginBottom: 12, padding: 10, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <button onClick={resetSellersAm} style={{ ...secondaryBtnSm, color: "var(--red)" }}>
                  🗑 Zerar
                </button>
                <button onClick={gerarBaseDaVarredura} style={secondaryBtnSm}>
                  🔄 Base da varredura
                </button>
                <button onClick={() => sincronizarViaApi()} disabled={syncingApi} style={primaryBtnSm}>
                  {syncingApi ? "Sincronizando..." : "⚡ Atualizar via API — tudo"}
                </button>
                {sellersAmMsg && <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{sellersAmMsg}</span>}
              </div>

              <div style={{ ...cardStyle, marginBottom: 16, padding: 10, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  value={syncOnlyIdsInput}
                  onChange={(e) => setSyncOnlyIdsInput(e.target.value)}
                  placeholder="IDs específicos (opcional)"
                  style={{ flex: 1, minWidth: 200, padding: 6, fontSize: 12, borderRadius: 8, border: "1px solid var(--border)", boxSizing: "border-box" }}
                />
                <button
                  onClick={() => sincronizarViaApi(syncOnlyIdsInput.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))}
                  disabled={syncingApi || !syncOnlyIdsInput.trim()}
                  style={secondaryBtnSm}
                >
                  ⚡ Só esses
                </button>
                {syncApiResultados.some((r) => r.status === "error") && (
                  <button
                    onClick={() =>
                      sincronizarViaApi(syncApiResultados.filter((r) => r.status === "error").map((r) => r.id))
                    }
                    disabled={syncingApi}
                    style={{ ...secondaryBtnSm, color: "var(--red)" }}
                  >
                    🔁 Só os com erro ({syncApiResultados.filter((r) => r.status === "error").length})
                  </button>
                )}
              </div>

              {syncApiProgress && (
                <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: -8, marginBottom: 8 }}>
                  {syncApiProgress.processed}/{syncApiProgress.total} processados — {syncApiProgress.matched} atualizados,{" "}
                  {syncApiProgress.notFound} não encontrados
                  {syncApiProgress.errors > 0 ? `, ${syncApiProgress.errors} com erro` : ""}.
                </p>
              )}
              {syncApiResultados.length > 0 && (
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
                  {syncApiResultados.filter((r) => r.status === "ok").length > 0 && (
                    <details style={{ flex: 1, minWidth: 280 }}>
                      <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--green)" }}>
                        ✅ Concluídos com sucesso ({syncApiResultados.filter((r) => r.status === "ok").length}) — clica pra abrir
                      </summary>
                      <div style={{ ...cardStyle, marginTop: 8, maxHeight: 240, overflowY: "auto" }}>
                        {syncApiResultados
                          .filter((r) => r.status === "ok")
                          .map((r) => (
                            <div key={r.id} style={{ fontSize: 12, padding: "4px 0", borderTop: "1px solid var(--border)" }}>
                              {r.id}
                            </div>
                          ))}
                      </div>
                    </details>
                  )}
                  {syncApiResultados.filter((r) => r.status !== "ok").length > 0 && (
                    <details style={{ flex: 1, minWidth: 280 }}>
                      <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--red)" }}>
                        ❌ Não concluídos ({syncApiResultados.filter((r) => r.status !== "ok").length}) — clica pra abrir
                      </summary>
                      <div style={{ ...cardStyle, marginTop: 8, maxHeight: 240, overflowY: "auto" }}>
                        {syncApiResultados
                          .filter((r) => r.status !== "ok")
                          .map((r) => (
                            <div key={r.id} style={{ fontSize: 12, padding: "4px 0", borderTop: "1px solid var(--border)" }}>
                              <b>{r.id}</b> — {r.status === "not_found" ? "não encontrado no Logistics" : r.erro}
                            </div>
                          ))}
                      </div>
                    </details>
                  )}
                </div>
              )}


              {sellersAmUpdatedAt && (
                <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: -8, marginBottom: 16 }}>
                  Última atualização: {new Date(sellersAmUpdatedAt).toLocaleString("pt-BR")}
                </p>
              )}

              <KpiRow>
                <Kpi label="Sellers" value={sellersAmRows.length} />
                <Kpi label="Estimado" value={sellersAmKpis.estimado.toLocaleString("pt-BR")} />
                <Kpi label="Preparado" value={sellersAmKpis.preparado.toLocaleString("pt-BR")} />
                <Kpi label="Coletado" value={sellersAmKpis.coletado.toLocaleString("pt-BR")} color="var(--green)" />
              </KpiRow>

              <SectionTitle>Pendente de coleta</SectionTitle>
              <KpiRow>
                <Kpi
                  label="Pendente de coleta (total)"
                  value={sellersAmKpis.impactoRegra.toLocaleString("pt-BR")}
                  color={sellersAmKpis.impactoRegra > 0 ? "var(--red)" : "var(--green)"}
                />
                <Kpi
                  label="Pendente com 2ª visita"
                  value={sellersAmKpis.pendente2Visita.toLocaleString("pt-BR")}
                  color="var(--orange)"
                />
                <Kpi
                  label="Pendente de reatribuição"
                  value={sellersAmKpis.pendenteReatribuicao.toLocaleString("pt-BR")}
                  color="var(--red)"
                />
              </KpiRow>

              <button
                onClick={() => setClusterPanelOpen(true)}
                style={{
                  ...secondaryBtn,
                  marginBottom: 24,
                  borderColor: sellersAmClusterFilter.size > 0 ? "var(--accent)" : undefined,
                }}
              >
                📍 Ver por cluster{sellersAmClusterFilter.size > 0 ? ` (${sellersAmClusterFilter.size} selecionado${sellersAmClusterFilter.size > 1 ? "s" : ""})` : ""}
              </button>

              <details style={{ marginBottom: 24 }}>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-secondary)" }}>
                  Conferir a conta — Pendente somado por status (clica pra abrir)
                </summary>
                <div style={{ ...cardStyle, marginTop: 8 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ textAlign: "left" }}>
                        <th style={th}>Status</th>
                        <th style={th}>Sellers</th>
                        <th style={th}>Pendente somado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendentePorStatus.map((row) => (
                        <tr key={row.status} style={{ borderTop: "1px solid var(--border)" }}>
                          <td style={td}>{row.status}</td>
                          <td style={td}>{row.sellers}</td>
                          <td style={td}>{row.pendente.toLocaleString("pt-BR")}</td>
                        </tr>
                      ))}
                      <tr style={{ borderTop: "2px solid var(--border)", fontWeight: 700 }}>
                        <td style={td}>Soma de tudo acima</td>
                        <td style={td}></td>
                        <td style={td}>{somaPendentePorStatus.toLocaleString("pt-BR")}</td>
                      </tr>
                      <tr>
                        <td style={td}>"Pendente de coleta (total)" mostrado no card</td>
                        <td style={td}></td>
                        <td style={td}>{sellersAmKpis.impactoRegra.toLocaleString("pt-BR")}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8, marginBottom: 0 }}>
                    {somaPendentePorStatus === sellersAmKpis.impactoRegra
                      ? "✅ Os dois números batem — a conta está correta."
                      : `⚠️ Diferença de ${(sellersAmKpis.impactoRegra - somaPendentePorStatus).toLocaleString("pt-BR")} — isso indicaria um bug de verdade, me avisa com esse print.`}
                  </p>
                </div>
              </details>

              <SectionTitle>Alertas (clica pra filtrar a tabela)</SectionTitle>
              <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                {sellersAmCards.map((c) => {
                  const count = sellersAmRows.filter(c.test).length;
                  const active = sellersAmCard === c.key;
                  return (
                    <div
                      key={c.key}
                      onClick={() => setSellersAmCard(active ? null : c.key)}
                      style={{
                        ...cardStyle,
                        flex: 1,
                        minWidth: 160,
                        cursor: "pointer",
                        border: active ? "2px solid #14161a" : "1px solid var(--border)",
                        padding: 16,
                      }}
                    >
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>{c.label}</div>
                      <div style={{ fontSize: 22, fontWeight: 800 }}>{count}</div>
                    </div>
                  );
                })}
              </div>

              {sellersAmCard &&
                (() => {
                  const cardAtivo = sellersAmCards.find((c) => c.key === sellersAmCard);
                  const linhasDoFiltro = sellersAmRows.filter((r) => cardAtivo?.test(r));
                  const impactoDoFiltro = linhasDoFiltro
                    .filter((r) => !r.impactoNaoCalculado)
                    .reduce((acc, r) => acc + (r.impacto || 0), 0);
                  return (
                    <div
                      style={{
                        ...cardStyle,
                        marginBottom: 24,
                        display: "flex",
                        gap: 24,
                        alignItems: "center",
                        borderColor: "var(--accent)",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Filtro ativo</div>
                        <div style={{ fontSize: 16, fontWeight: 700 }}>{cardAtivo?.label}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Sellers</div>
                        <div style={{ fontSize: 20, fontWeight: 800 }}>{linhasDoFiltro.length}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Impacto total desse filtro</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: impactoDoFiltro > 0 ? "var(--red)" : "var(--green)" }}>
                          {impactoDoFiltro.toLocaleString("pt-BR")}
                        </div>
                      </div>
                    </div>
                  );
                })()}

              <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
                <div style={{ ...cardStyle, flex: 1, minWidth: 280 }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>Top 5 — maior pendente de coleta</div>
                  {top5AtrasoAm.length === 0 ? (
                    <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Nenhum seller atrasado.</div>
                  ) : (
                    top5AtrasoAm.map((r) => (
                      <div key={r.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0" }}>
                        <span>{r.name}</span>
                        <span style={{ color: "var(--red)", fontWeight: 600 }}>{r.impacto}</span>
                      </div>
                    ))
                  )}
                </div>
                <div style={{ ...cardStyle, flex: 1, minWidth: 280 }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>Top 5 — maior volume preparado</div>
                  {[...sellersAmRows].sort((a, b) => (b.preparado || 0) - (a.preparado || 0)).slice(0, 5).map((r) => (
                    <div key={r.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0" }}>
                      <span>{r.name}</span>
                      <span style={{ fontWeight: 600 }}>{r.preparado}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ ...cardStyle, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
                <input
                  value={sellersAmSearch}
                  onChange={(e) => setSellersAmSearch(e.target.value)}
                  placeholder="Buscar por nome ou ID..."
                  style={{ flex: 1, minWidth: 200, padding: 9, borderRadius: 8, border: "1px solid var(--border)" }}
                />
                {(sellersAmCard || sellersAmClusterFilter.size > 0) && (
                  <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                    Filtro:{" "}
                    {[
                      sellersAmCard ? sellersAmCards.find((c) => c.key === sellersAmCard)?.label : null,
                      sellersAmClusterFilter.size > 0 ? `Clusters ${Array.from(sellersAmClusterFilter).sort(sortClusters).join(", ")}` : null,
                    ]
                      .filter(Boolean)
                      .join(" + ")}{" "}
                    ({sellersAmFiltered.length})
                    <button
                      onClick={() => {
                        setSellersAmCard(null);
                        setSellersAmClusterFilter(new Set());
                      }}
                      style={{ ...secondaryBtn, marginLeft: 8, padding: "4px 10px" }}
                    >
                      Limpar filtro
                    </button>
                  </span>
                )}
                <button onClick={copySellersAmIds} style={secondaryBtn}>
                  Copiar IDs (filtro: {sellersAmFiltered.length})
                </button>
                <button onClick={copySellersAmNotCollected} style={secondaryBtn}>
                  Copiar não coletados
                </button>
                <button onClick={copySellersAmAll} style={secondaryBtn}>
                  Copiar tudo
                </button>
              </div>

              <div style={{ ...cardStyle, marginBottom: 16, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Excluir em massa:</span>
                <button
                  onClick={() => deleteSellerAmBulk(Array.from(selectedSellerAmIds))}
                  disabled={selectedSellerAmIds.size === 0}
                  style={{ ...secondaryBtn, color: "var(--red)" }}
                >
                  Excluir selecionados ({selectedSellerAmIds.size})
                </button>
                <span style={{ fontSize: 13, color: "var(--text-secondary)", marginLeft: 8 }}>Estimado até</span>
                <input
                  type="number"
                  value={excluirEstimadoAte}
                  onChange={(e) => setExcluirEstimadoAte(e.target.value)}
                  style={{ ...inlineInputStyle, width: 60 }}
                />
                <button
                  onClick={() => {
                    const limite = Number(excluirEstimadoAte) || 0;
                    const ids = sellersAmRows.filter((r) => (r.estimado || 0) <= limite).map((r) => r.id);
                    deleteSellerAmBulk(ids);
                  }}
                  style={secondaryBtn}
                >
                  Excluir com estimado ≤ {excluirEstimadoAte || 0}
                </button>
                <button
                  onClick={() => setSelectedSellerAmIds(new Set(sellersAmFiltered.map((r) => r.id)))}
                  style={secondaryBtn}
                >
                  Selecionar tudo (filtro atual)
                </button>
                {selectedSellerAmIds.size > 0 && (
                  <button onClick={() => setSelectedSellerAmIds(new Set())} style={secondaryBtn}>
                    Limpar seleção
                  </button>
                )}
              </div>

              <div style={cardStyle}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: "left" }}>
                      <th style={th}>
                        <input
                          type="checkbox"
                          checked={sellersAmFiltered.length > 0 && sellersAmFiltered.every((r) => selectedSellerAmIds.has(r.id))}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedSellerAmIds(new Set(sellersAmFiltered.map((r) => r.id)));
                            else setSelectedSellerAmIds(new Set());
                          }}
                        />
                      </th>
                      <th style={th}>Seller</th>
                      <th style={th}>Cluster</th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleAmSort("estimado")}>
                        Estimado{sortArrow(amSortKey === "estimado", amSortDir)}
                      </th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleAmSort("preparado")}>
                        Preparado{sortArrow(amSortKey === "preparado", amSortDir)}
                      </th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleAmSort("coletado")}>
                        Coletado{sortArrow(amSortKey === "coletado", amSortDir)}
                      </th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleAmSort("impacto")}>
                        Pendente{sortArrow(amSortKey === "impacto", amSortDir)}
                      </th>
                      <th style={th}>Status</th>
                      <th style={th}>Última rota</th>
                      <th style={th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sellersAmFiltered.length === 0 ? (
                      <tr>
                        <td style={td} colSpan={10}>
                          Nenhum seller ainda. Importa o CSV da base primeiro.
                        </td>
                      </tr>
                    ) : (
                      sellersAmFiltered.map((r) => {
                        const ultimaRota = r.ultimaRota;
                        return (
                          <Fragment key={r.id}>
                            <tr style={{ borderTop: "1px solid var(--border)", background: r.temRiscoPerda ? "#fef2f2" : "transparent" }}>
                              <td style={td}>
                                <input
                                  type="checkbox"
                                  checked={selectedSellerAmIds.has(r.id)}
                                  onChange={(e) => {
                                    setSelectedSellerAmIds((prev) => {
                                      const next = new Set(prev);
                                      if (e.target.checked) next.add(r.id);
                                      else next.delete(r.id);
                                      return next;
                                    });
                                  }}
                                />
                              </td>
                              <td style={td}>
                                <div style={{ fontWeight: 600 }}>
                                  {r.name}{" "}
                                  {r.dadoSuspeito && (
                                    <span
                                      title={
                                        r.valorAbsurdo
                                          ? "Número absurdamente alto (bug de leitura/soma, provavelmente) — confere antes de usar."
                                          : Array.isArray(r.avisos) && r.avisos.length > 0
                                          ? r.avisos.join(" | ")
                                          : r.qualidade && r.qualidade !== "OK"
                                          ? `Qualidade: ${r.qualidade}`
                                          : "Dado suspeito"
                                      }
                                    >
                                      🚩
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                                  {r.id} {r.horario ? `· ${r.horario}` : ""}{" "}
                                  <span style={{ color: timeAgoColor(r.updatedAt) }}>· {timeAgo(r.updatedAt)}</span>
                                  {r.rotas.length > 0 && (
                                    <>
                                      {" · "}
                                      <span
                                        onClick={() => setExpandedSellerAm(expandedSellerAm === r.id ? null : r.id)}
                                        style={{ cursor: "pointer", color: "var(--text-secondary)", textDecoration: "underline" }}
                                      >
                                        {r.rotas.length} rota(s)
                                      </span>
                                    </>
                                  )}
                                </div>
                              </td>
                              <td style={td}>
                                <span
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleSellersAmCluster(r.cluster);
                                  }}
                                  style={{ cursor: "pointer", color: "#2563eb", fontWeight: 600 }}
                                  title="Filtrar pela cluster desse ponto"
                                >
                                  {r.cluster}
                                </span>
                                {r.clusterFromHistory && (
                                  <div
                                    title={r.clusterSourceRoute ? `Cluster recuperado da rota ${r.clusterSourceRoute}` : "Cluster recuperado do histórico do ponto"}
                                    style={{ fontSize: 10, color: "var(--orange)", marginTop: 3 }}
                                  >
                                    histórico do ponto
                                  </div>
                                )}
                              </td>
                              <td style={td}>
                                <input
                                  key={`${r.id}-est-${r.estimado}`}
                                  type="number"
                                  defaultValue={r.estimado}
                                  onBlur={(e) => updateSellerAmField(r.id, "estimado", Number(e.target.value))}
                                  style={inlineInputStyle}
                                />
                              </td>
                              <td style={td}>
                                <input
                                  key={`${r.id}-prep-${r.preparado}`}
                                  type="number"
                                  defaultValue={r.preparado}
                                  onBlur={(e) => updateSellerAmField(r.id, "preparado", Number(e.target.value))}
                                  style={inlineInputStyle}
                                />
                              </td>
                              <td style={td}>
                                <input
                                  key={`${r.id}-col-${r.coletado}`}
                                  type="number"
                                  defaultValue={r.coletado}
                                  onBlur={(e) => updateSellerAmField(r.id, "coletado", Number(e.target.value))}
                                  style={inlineInputStyle}
                                />
                              </td>
                              <td style={td}>
                                {r.impactoNaoCalculado ? (
                                  <span
                                    title="Preparado ou Coletado não foram lidos pelo script (null) — sem base pra calcular."
                                    style={{ color: "var(--text-secondary)", fontWeight: 700 }}
                                  >
                                    Revisar
                                  </span>
                                ) : (
                                  <>
                                    <span style={{ color: r.impacto > 0 ? "var(--red)" : "var(--green)", fontWeight: 700 }}>
                                      {r.impacto}
                                    </span>
                                    {r.chegouAposColeta && (
                                      <div
                                        title="A rota já passou nesse horário — esse preparado chegou depois e ainda não tem coleta agendada."
                                        style={{ fontSize: 10, color: "var(--orange)", fontWeight: 600, whiteSpace: "nowrap", marginTop: 3 }}
                                      >
                                        Após a coleta
                                      </div>
                                    )}
                                  </>
                                )}
                              </td>
                              <td style={td}>
                                <select
                                  value={r.status}
                                  onChange={(e) => updateSellerAmField(r.id, "status", e.target.value)}
                                  style={{
                                    ...selectStyle,
                                    background: statusColors(r.status).bg,
                                    color: statusColors(r.status).fg,
                                    fontWeight: 600,
                                    border: "none",
                                  }}
                                >
                                  {["Coletado", "Pendente", "Perdido", "2ª Visita", "Reatribuir", "Cancelado", "Revisar"].map((s) => (
                                    <option key={s} value={s}>
                                      {s}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td style={td}>
                                {ultimaRota ? (
                                  `${ultimaRota.rota} · ${ultimaRota.status}`
                                ) : (
                                  <span
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 4,
                                      background: "#fef3c7",
                                      color: "#92400e",
                                      padding: "3px 10px",
                                      borderRadius: 999,
                                      fontSize: 12,
                                      fontWeight: 600,
                                    }}
                                  >
                                    ⏳ Aguardando / Sem início
                                  </span>
                                )}
                              </td>
                              <td style={td}>
                                <button
                                  onClick={() => deleteSellerAm(r.id)}
                                  style={{ background: "none", border: "none", color: "var(--red)", cursor: "pointer", fontSize: 16 }}
                                  title="Remover"
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                            {expandedSellerAm === r.id && (
                              <tr>
                                <td style={{ ...td, background: "#fafafa" }} colSpan={10}>
                                  <table style={{ width: "100%", fontSize: 12 }}>
                                    <thead>
                                      <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                                        <th style={{ padding: "4px 8px" }}>Rota</th>
                                        <th style={{ padding: "4px 8px" }}>Intervalo</th>
                                        <th style={{ padding: "4px 8px" }}>Preparado</th>
                                        <th style={{ padding: "4px 8px" }}>Coletado</th>
                                        <th style={{ padding: "4px 8px" }}>Restante</th>
                                        <th style={{ padding: "4px 8px" }}>Status</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {r.rotas.map((rt: any, i: number) => {
                                        const ocorrencias = getOcorrencias(rt);
                                        const temConflito = Array.isArray(rt.conflitos) && rt.conflitos.length > 0;
                                        return (
                                          <Fragment key={i}>
                                            {ocorrencias.length > 1 && (
                                              <tr style={{ background: "#f0f0f0" }}>
                                                <td style={{ padding: "4px 8px", fontWeight: 700 }} colSpan={6}>
                                                  {rt.rota} {temConflito && <span title="Conflito entre leituras">⚠</span>}{" "}
                                                  <span style={{ fontWeight: 400, color: "var(--text-secondary)" }}>
                                                    ({ocorrencias.length} passagens registradas)
                                                  </span>
                                                </td>
                                              </tr>
                                            )}
                                            {ocorrencias.map((oc: any, j: number) => (
                                              <tr key={j}>
                                                <td style={{ padding: "4px 8px" }}>
                                                  {ocorrencias.length > 1 ? "↳" : rt.rota}
                                                </td>
                                                <td style={{ padding: "4px 8px" }}>{oc.intervalo ?? "-"}</td>
                                                <td style={{ padding: "4px 8px" }}>
                                                  {oc.preparadosRota === null ? "—" : oc.preparadosRota ?? "-"}
                                                </td>
                                                <td style={{ padding: "4px 8px" }}>
                                                  {oc.coletadosRota === null ? "—" : oc.coletadosRota ?? "-"}
                                                </td>
                                                <td style={{ padding: "4px 8px" }}>
                                                  {oc.restantesRota === null ? "—" : oc.restantesRota ?? "-"}
                                                </td>
                                                <td style={{ padding: "4px 8px" }}>{oc.status || "-"}</td>
                                              </tr>
                                            ))}
                                          </Fragment>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <details style={{ marginBottom: 24 }}>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-secondary)" }}>
                  🧪 Testar IDs específicos (debug — clica pra abrir)
                </summary>
                <div style={{ ...cardStyle, marginTop: 8 }}>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 0 }}>
                    Cola aqui alguns IDs (um por linha) pra ver o erro exato de cada um, sem precisar rodar a base
                    inteira.
                  </p>
                  <textarea
                    value={testIdsInput}
                    onChange={(e) => setTestIdsInput(e.target.value)}
                    placeholder={"849817033_214166239\n..."}
                    rows={3}
                    style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid var(--border)", fontFamily: "monospace", fontSize: 12, boxSizing: "border-box" }}
                  />
                  <button onClick={testarIdsApi} disabled={testingIds} style={{ ...primaryBtn, marginTop: 8 }}>
                    {testingIds ? "Testando..." : "Testar"}
                  </button>

                  {testIdsResults && (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 12 }}>
                      <thead>
                        <tr style={{ textAlign: "left" }}>
                          <th style={th}>ID</th>
                          <th style={th}>Tipo testado</th>
                          <th style={th}>Resultado</th>
                        </tr>
                      </thead>
                      <tbody>
                        {testIdsResults.map((r, i) => (
                          <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                            <td style={td}>{r.id}</td>
                            <td style={td}>{r.tipoTestado || "-"}</td>
                            <td style={{ ...td, color: r.ok ? "var(--green)" : "var(--red)" }}>
                              {r.ok ? (
                                <>
                                  ✅ OK — customerId {r.customerId}, Est {r.summary?.estimado}, Prep {r.summary?.preparado},
                                  Colet {r.summary?.coletado}, {r.rotasEncontradas} rota(s)
                                  {r.usouIdCru && (
                                    <span style={{ color: "var(--orange)", fontWeight: 700 }}>
                                      {" "}⚠️ usou ID cru (normalizado colidia com outro cliente)
                                    </span>
                                  )}
                                  {Array.isArray(r.rotas) && r.rotas.length > 0 && (
                                    <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-secondary)" }}>
                                      {r.rotas.map((rt: any, j: number) => (
                                        <div key={j}>
                                          {rt.rota} · {rt.intervalo} · status traduzido: <b>{rt.status}</b> · status
                                          cru da API: <b>{rt.statusRaw}</b>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </>
                              ) : (
                                `❌ ${r.erro}`
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </details>
            </>
          )}



          {activeTab === "rotas_am" && (
            <>
              <div style={{ ...cardStyle, marginBottom: 16 }}>
                <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-secondary)" }}>
                  Cola aqui os códigos das rotas AM (um por linha, ex: BRRJ02_C09_41) — o app puxa só essas, usando os
                  dados já escaneados ao atualizar as rotas.
                </p>
                <textarea
                  value={rotasAmListaInput}
                  onChange={(e) => setRotasAmListaInput(e.target.value)}
                  placeholder={"BRRJ02_C09_41\nBRRJ02_C18_205\n..."}
                  rows={4}
                  style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid var(--border)", fontFamily: "monospace", fontSize: 12, boxSizing: "border-box" }}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                  <button onClick={salvarRotasAmLista} style={primaryBtn}>
                    Salvar lista
                  </button>
                  {rotasAmListaMsg && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{rotasAmListaMsg}</span>}
                </div>
                {rotasAmLista.length > 0 && (
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 8, marginBottom: 0 }}>
                    Lista atual: {rotasAmLista.length} rota(s)
                    {rotasAmListaUpdatedAt ? ` · salva em ${new Date(rotasAmListaUpdatedAt).toLocaleString("pt-BR")}` : ""}
                  </p>
                )}
                {rotasNaoEncontradas.length > 0 && (
                  <p style={{ fontSize: 12, color: "var(--orange)", marginTop: 4, marginBottom: 0 }}>
                    ⚠️ {rotasNaoEncontradas.length} rota(s) da lista não foram encontradas na varredura ainda: {rotasNaoEncontradas.join(", ")}
                  </p>
                )}
              </div>

              <KpiRow>
                <Kpi label="Rotas AM" value={rotasAmRows.length} />
                <Kpi label="Total pontos" value={sellersVsPlaces.seller.total + sellersVsPlaces.place.total} />
                <Kpi
                  label="Estimado"
                  value={(sellersVsPlaces.seller.estimado + sellersVsPlaces.place.estimado).toLocaleString("pt-BR")}
                />
                {(() => {
                  // Usa a MESMA base deduplicada por ID dos blocos Sellers/Places logo
                  // abaixo (em vez de somar por parada, que contava 2x quem tem 2ª
                  // visita) — assim os números do topo sempre batem com a soma dos
                  // dois blocos, coisa que antes não acontecia.
                  const estimadoTotal = sellersVsPlaces.seller.estimado + sellersVsPlaces.place.estimado;
                  const preparadoTotal = sellersVsPlaces.seller.preparado + sellersVsPlaces.place.preparado;
                  const coletadoTotal = sellersVsPlaces.seller.coletado + sellersVsPlaces.place.coletado;
                  const impactoTotal = estimadoTotal - preparadoTotal;
                  // Pendente de coleta: soma o pendente de CADA grupo (não recalcula
                  // em cima do total combinado), porque a fórmula tem uma ramificação
                  // (pós-coleta) que não é linear — somar os dois blocos é o que
                  // realmente bate com o que aparece embaixo.
                  const pendenteTotal =
                    pendenteColetaSeller(sellersVsPlaces.seller.preparado, sellersVsPlaces.seller.coletado) +
                    pendenteColetaSeller(sellersVsPlaces.place.preparado, sellersVsPlaces.place.coletado);
                  return (
                    <>
                      <Kpi
                        label="Preparado"
                        value={preparadoTotal.toLocaleString("pt-BR")}
                        sub={pct(preparadoTotal, estimadoTotal)}
                      />
                      <Kpi
                        label="Coletado"
                        value={coletadoTotal.toLocaleString("pt-BR")}
                        color="var(--green)"
                        sub={pct(coletadoTotal, preparadoTotal)}
                      />
                      <Kpi
                        label="Impacto (Estimado - Preparado)"
                        value={impactoTotal.toLocaleString("pt-BR")}
                        color="var(--red)"
                        sub={pct(impactoTotal, estimadoTotal)}
                      />
                      <Kpi
                        label="Pendente de coleta (Preparado - Coletado)"
                        value={pendenteTotal.toLocaleString("pt-BR")}
                        color="var(--orange)"
                        sub={pct(pendenteTotal, preparadoTotal)}
                      />
                    </>
                  );
                })()}
              </KpiRow>

              <SectionTitle>Sellers</SectionTitle>
              <KpiRow>
                <Kpi label="Sellers total" value={sellersVsPlaces.seller.total} />
                <Kpi label="Sellers estimado" value={sellersVsPlaces.seller.estimado.toLocaleString("pt-BR")} />
                <Kpi
                  label="Sellers preparado"
                  value={sellersVsPlaces.seller.preparado.toLocaleString("pt-BR")}
                  sub={pct(sellersVsPlaces.seller.preparado, sellersVsPlaces.seller.estimado)}
                />
                <Kpi
                  label="Sellers coletado"
                  value={sellersVsPlaces.seller.coletado.toLocaleString("pt-BR")}
                  color="var(--green)"
                  sub={pct(sellersVsPlaces.seller.coletado, sellersVsPlaces.seller.preparado)}
                />
                <Kpi
                  label="Impacto (Est. - Prep.)"
                  value={(sellersVsPlaces.seller.estimado - sellersVsPlaces.seller.preparado).toLocaleString("pt-BR")}
                  color="var(--red)"
                  sub={pct(sellersVsPlaces.seller.estimado - sellersVsPlaces.seller.preparado, sellersVsPlaces.seller.estimado)}
                />
                <Kpi
                  label="Pendente de coleta (Prep. - Colet.)"
                  value={pendenteColetaSeller(sellersVsPlaces.seller.preparado, sellersVsPlaces.seller.coletado).toLocaleString("pt-BR")}
                  color="var(--orange)"
                  sub={pct(
                    pendenteColetaSeller(sellersVsPlaces.seller.preparado, sellersVsPlaces.seller.coletado),
                    sellersVsPlaces.seller.preparado
                  )}
                />
              </KpiRow>

              <SectionTitle>Places</SectionTitle>
              <KpiRow>
                <Kpi label="Places total" value={sellersVsPlaces.place.total} />
                <Kpi label="Places estimado" value={sellersVsPlaces.place.estimado.toLocaleString("pt-BR")} />
                <Kpi
                  label="Places preparado"
                  value={sellersVsPlaces.place.preparado.toLocaleString("pt-BR")}
                  sub={pct(sellersVsPlaces.place.preparado, sellersVsPlaces.place.estimado)}
                />
                <Kpi
                  label="Places coletado"
                  value={sellersVsPlaces.place.coletado.toLocaleString("pt-BR")}
                  color="var(--green)"
                  sub={pct(sellersVsPlaces.place.coletado, sellersVsPlaces.place.preparado)}
                />
                <Kpi
                  label="Impacto (Est. - Prep.)"
                  value={(sellersVsPlaces.place.estimado - sellersVsPlaces.place.preparado).toLocaleString("pt-BR")}
                  color="var(--red)"
                  sub={pct(sellersVsPlaces.place.estimado - sellersVsPlaces.place.preparado, sellersVsPlaces.place.estimado)}
                />
                <Kpi
                  label="Pendente de coleta (Prep. - Colet.)"
                  value={pendenteColetaSeller(sellersVsPlaces.place.preparado, sellersVsPlaces.place.coletado).toLocaleString("pt-BR")}
                  color="var(--orange)"
                  sub={pct(
                    pendenteColetaSeller(sellersVsPlaces.place.preparado, sellersVsPlaces.place.coletado),
                    sellersVsPlaces.place.preparado
                  )}
                />
              </KpiRow>

              <div style={{ ...cardStyle, marginBottom: 16, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  value={rotasAmSearch}
                  onChange={(e) => setRotasAmSearch(e.target.value)}
                  placeholder="Buscar por rota, nome ou ID de seller..."
                  style={{ flex: 1, minWidth: 200, padding: 9, borderRadius: 8, border: "1px solid var(--border)", boxSizing: "border-box" }}
                />
                <button onClick={toggleExpandirTodasRotasAm} style={secondaryBtn}>
                  {rotasAmRows.length > 0 && rotasAmRows.every((rt) => rotasAmExpanded.has(rt.routeId))
                    ? "Colapsar tudo"
                    : "Expandir tudo"}
                </button>
                <button onClick={exportarRotasAmCsv} style={secondaryBtn}>
                  Exportar CSV
                </button>
              </div>

              <div style={cardStyle}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ textAlign: "left" }}>
                      <th style={th}>Rota</th>
                      <th style={th}>Cluster</th>
                      <th style={th}>Transportadora</th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleRotasAmSort("sellers")}>
                        Sellers{sortArrow(rotasAmSortKey === "sellers", rotasAmSortDir)}
                      </th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleRotasAmSort("estimadoTotal")}>
                        Estimado{sortArrow(rotasAmSortKey === "estimadoTotal", rotasAmSortDir)}
                      </th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleRotasAmSort("preparadoTotal")}>
                        Preparado{sortArrow(rotasAmSortKey === "preparadoTotal", rotasAmSortDir)}
                      </th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleRotasAmSort("coletadoTotal")}>
                        Coletado{sortArrow(rotasAmSortKey === "coletadoTotal", rotasAmSortDir)}
                      </th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleRotasAmSort("impactoEstPrep")}>
                        Est. - Prep.{sortArrow(rotasAmSortKey === "impactoEstPrep", rotasAmSortDir)}
                      </th>
                      <th style={{ ...th, cursor: "pointer", userSelect: "none" }} onClick={() => toggleRotasAmSort("pendenteColeta")}>
                        Prep. - Colet.{sortArrow(rotasAmSortKey === "pendenteColeta", rotasAmSortDir)}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rotasAmRows.length === 0 ? (
                      <tr>
                        <td style={td} colSpan={8}>
                          Nenhuma rota encontrada. Cola a lista de rotas acima e clica em "Salvar lista", e confirma
                          que a varredura completa do botão Atualizar rotas já rodou recentemente.
                        </td>
                      </tr>
                    ) : (
                      rotasAmRows.map((rt) => {
                        const expandido = rotasAmExpanded.has(rt.routeId);
                        return (
                          <Fragment key={rt.routeId}>
                            <tr
                              style={{ borderTop: "1px solid var(--border)", cursor: "pointer" }}
                              onClick={() => toggleRotaAmExpand(rt.routeId)}
                            >
                              <td style={td}>
                                {expandido ? "▾" : "▸"} {rt.routeName}{" "}
                                {rt.finalizada && <span title="Rota finalizada — já descarregou no XD">🚛</span>}
                              </td>
                              <td style={td}>{rt.cluster}</td>
                              <td style={td}>{rt.carrierName}</td>
                              <td style={td}>{rt.sellers.length}</td>
                              <td style={td}>{rt.estimadoTotal.toLocaleString("pt-BR")}</td>
                              <td style={td}>{rt.preparadoTotal.toLocaleString("pt-BR")}</td>
                              <td style={td}>{rt.coletadoTotal.toLocaleString("pt-BR")}</td>
                              <td style={td}>{rt.impactoEstPrep.toLocaleString("pt-BR")}</td>
                              <td style={td}>{rt.pendenteColeta.toLocaleString("pt-BR")}</td>
                            </tr>
                            {expandido && (
                              <tr>
                                <td style={{ ...td, background: "#fafafa" }} colSpan={9}>
                                  <table style={{ width: "100%", fontSize: 13 }}>
                                    <thead>
                                      <tr style={{ textAlign: "left", color: "var(--text-secondary)" }}>
                                        <th style={{ padding: "4px 8px" }}>Seller/Place</th>
                                        <th style={{ padding: "4px 8px" }}>ID</th>
                                        <th style={{ padding: "4px 8px" }}>Estimado</th>
                                        <th style={{ padding: "4px 8px" }}>Preparado</th>
                                        <th style={{ padding: "4px 8px" }}>Coletado</th>
                                        <th style={{ padding: "4px 8px" }}>Status</th>
                                        <th style={{ padding: "4px 8px" }}>Motivo da ocorrência</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {rt.sellers.map((sl: any, i: number) => (
                                        <tr key={i} style={{ background: sl.hasProblem ? "#fef2f2" : "transparent" }}>
                                          <td style={{ padding: "4px 8px" }}>{sl.nome}</td>
                                          <td style={{ padding: "4px 8px" }}>
                                            {sl.id} {sl.isAgent ? "(place)" : ""}
                                          </td>
                                          <td style={{ padding: "4px 8px" }}>{sl.estimado}</td>
                                          <td style={{ padding: "4px 8px" }}>{sl.preparado}</td>
                                          <td style={{ padding: "4px 8px" }}>{sl.coletado}</td>
                                          <td style={{ padding: "4px 8px" }}>{sl.status}</td>
                                          <td style={{ padding: "4px 8px", color: "var(--red)" }}>
                                            {sl.hasProblem ? sl.problemType || "Sim (sem motivo detalhado)" : ""}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}


          {activeTab === "rotas" && (
            <>
              <KpiRow>
                <Kpi label="Rotas" value={routes.length} onClick={() => setFilter("todas")} active={filter === "todas"} />
                <Kpi
                  label="Sem início"
                  value={semInicio}
                  color="var(--red)"
                  onClick={() => setFilter("sem_inicio")}
                  active={filter === "sem_inicio"}
                />
                <Kpi
                  label="Com problema"
                  value={comProblema}
                  color="var(--orange)"
                  onClick={() => setFilter("com_problema")}
                  active={filter === "com_problema"}
                />
              </KpiRow>

              <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                <select value={clusterFilter} onChange={(e) => setClusterFilter(e.target.value)} style={selectStyle}>
                  <option value="todos">Todos os clusters</option>
                  {clusters.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select value={carrierFilter} onChange={(e) => setCarrierFilter(e.target.value)} style={selectStyle}>
                  <option value="todas">Todas as transportadoras</option>
                  {carriers.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                {(clusterFilter !== "todos" || carrierFilter !== "todas") && (
                  <button
                    onClick={() => {
                      setClusterFilter("todos");
                      setCarrierFilter("todas");
                    }}
                    style={secondaryBtn}
                  >
                    Limpar filtros
                  </button>
                )}
                {sortKeys.length > 0 && (
                  <button onClick={clearRouteSort} style={secondaryBtn}>
                    Limpar ordenação
                  </button>
                )}
              </div>
              {sortKeys.length > 1 && (
                <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: -8, marginBottom: 12 }}>
                  Ordenando por {sortKeys.map((s) => (s.key === "pacotes" ? "pendentes" : "progresso")).join(" → ")}{" "}
                  (o primeiro manda, o segundo desempata).
                </p>
              )}

              <div style={cardStyle}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ textAlign: "left" }}>
                      <th style={th}>Rota</th>
                      <th style={th}>Transportadora</th>
                      <th style={th}>Status</th>
                      <th style={th}>Paradas</th>
                      <th
                        style={{ ...th, cursor: "pointer", userSelect: "none" }}
                        onClick={() => toggleRouteSort("pacotes")}
                        title="Ordena pelo que falta coletar (pendente)"
                      >
                        Pacotes (pendente){routeSortBadge("pacotes")}
                      </th>
                      <th
                        style={{ ...th, cursor: "pointer", userSelect: "none" }}
                        onClick={() => toggleRouteSort("progresso")}
                      >
                        Progresso{routeSortBadge("progresso")}
                      </th>
                      <th style={th}>Problemas</th>
                      <th style={th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((r) => {
                      const pct =
                        r.estimatedPackages > 0 ? Math.round((r.collectedPackages / r.estimatedPackages) * 100) : 0;
                      return (
                        <tr key={r.id} style={{ borderTop: "1px solid var(--border)" }}>
                          <td style={td}>{routeLabel(r)}</td>
                          <td style={td}>{r.carrierName || "-"}</td>
                          <td style={td}>{r.status}</td>
                          <td style={td}>
                            {r.successfulStops}/{r.totalStops}
                          </td>
                          <td style={td}>
                            {r.collectedPackages}/{r.estimatedPackages}
                          </td>
                          <td style={td}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 60, height: 8, background: "#eee", borderRadius: 4, overflow: "hidden" }}>
                                <div
                                  style={{
                                    width: `${pct}%`,
                                    height: "100%",
                                    background: progressColor(pct),
                                    borderRadius: 4,
                                  }}
                                />
                              </div>
                              <span style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 32 }}>{pct}%</span>
                              {r.status.toLowerCase() === "close" && (
                                <span title="Rota finalizada — já descarregou no XD">🚛</span>
                              )}
                            </div>
                          </td>
                          <td style={td}>
                            {r.withProblemStops > 0 || r.failedStops > 0 ? (
                              <span style={{ color: "var(--red)", fontWeight: 600 }}>
                                ⚠ {r.withProblemStops + r.failedStops}
                              </span>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td style={td}>
                            <button
                              onClick={() => reescanearRota(r.id)}
                              disabled={reescaneandoRotaId === r.id}
                              title="Forçar re-escanear só essa rota, ignorando a otimização de pular"
                              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14 }}
                            >
                              {reescaneandoRotaId === r.id ? "..." : "🔄"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {activeTab === "clusters" && (
            <>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
                Valores reconciliados por ponto. Uma coleta confirmada em outra rota não é contada novamente como pendência.
              </p>
              <div style={cardStyle}>
                <Table
                  headers={["Cluster", "Pontos", "Rotas", "Preparado", "Coletado", "Pendente real", "% coletado", "Reatribuir"]}
                  rows={operationalClusterRows.map((c) => [
                    c.cluster,
                    c.total,
                    c.rotas,
                    c.preparado.toLocaleString("pt-BR"),
                    c.coletado.toLocaleString("pt-BR"),
                    c.pendente.toLocaleString("pt-BR"),
                    `${c.pctColetado}%`,
                    c.reatribuir,
                  ])}
                  onRowClick={(i) => {
                    setSellerClusterFilter(operationalClusterRows[i].cluster);
                    setActiveTab("sellers");
                  }}
                />
              </div>
            </>
          )}

          {activeTab === "transportadoras" && (
            <>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
                Clica numa transportadora pra ir direto pro painel de Rotas já filtrado por ela.
              </p>
              <div style={cardStyle}>
                <Table
                  headers={["Transportadora", "Rotas", "Sem início", "Com problema", "Estimado", "Coletado"]}
                  rows={byCarrier.map((c) => [
                    c.carrier,
                    c.rotas,
                    c.semInicio,
                    c.comProblema,
                    c.estimado.toLocaleString("pt-BR"),
                    c.coletado.toLocaleString("pt-BR"),
                  ])}
                  onRowClick={(i) => {
                    setCarrierFilter(byCarrier[i].carrier);
                    setClusterFilter("todos");
                    setActiveTab("rotas");
                  }}
                />
              </div>
            </>
          )}
        </div>
        <footer
          className="app-footer"
          style={{
            maxWidth: 1280,
            margin: "0 auto",
            padding: "8px 32px 24px",
            width: "100%",
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            color: "var(--text-secondary)",
            fontSize: 11,
          }}
        >
          <span>PULSE · Pickup Unified Logistics Surveillance &amp; Execution</span>
          <span>dev by Jr Araujo</span>
        </footer>
      </main>

      {/* PAINEL LATERAL — Visão por cluster (Sellers AM). Só existe na tela quando aberto. */}
      {clusterPanelOpen && (
        <>
          <div
            onClick={() => setClusterPanelOpen(false)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 30 }}
          />
          <div
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              height: "100vh",
              width: 360,
              maxWidth: "90vw",
              background: "var(--card-bg)",
              boxShadow: "-4px 0 24px rgba(0,0,0,0.15)",
              zIndex: 31,
              display: "flex",
              flexDirection: "column",
              padding: 20,
              overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Visão por cluster</h3>
              <button
                onClick={() => setClusterPanelOpen(false)}
                style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--text-secondary)" }}
              >
                ✕
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 0, marginBottom: 12 }}>
              Cluster calculado pelas rotas programadas do histórico do ponto. Se a visita atual for avulsa, o último cluster válido é preservado. Clica numa linha pra filtrar a tabela.
            </p>

            {sellersAmClusterFilter.size > 0 && (
              <button
                onClick={() => setSellersAmClusterFilter(new Set())}
                style={{ ...secondaryBtn, marginBottom: 12, alignSelf: "flex-start" }}
              >
                Limpar clusters ({sellersAmClusterFilter.size})
              </button>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {sellersAmPorCluster.map((c) => (
                <div
                  key={c.cluster}
                  onClick={() => toggleSellersAmCluster(c.cluster)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    cursor: "pointer",
                    background: sellersAmClusterFilter.has(c.cluster) ? "#fef9c3" : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <input type="checkbox" checked={sellersAmClusterFilter.has(c.cluster)} readOnly aria-label={`Selecionar ${c.cluster}`} />
                    <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{c.cluster}</div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>{c.total} ponto(s)</div>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: c.pendente > 0 ? "var(--red)" : "var(--green)" }}>
                      {c.pendente.toLocaleString("pt-BR")}
                    </div>
                    {c.reatribuir > 0 && (
                      <div style={{ fontSize: 11, color: "var(--red)" }}>{c.reatribuir} p/ reatribuir</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button onClick={() => setClusterPanelOpen(false)} style={{ ...primaryBtn, marginTop: 14 }}>
              Aplicar seleção ({sellersAmClusterFilter.size || "todos"})
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function KpiRow({ children }: { children: React.ReactNode }) {
  return <div className="kpi-row" style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>{children}</div>;
}


function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 style={{ fontSize: 14, color: "var(--text-secondary)", margin: "24px 0 8px" }}>{children}</h3>;
}

function Kpi({ label, value, color, onClick, active, sub }: any) {
  return (
    <div
      className="kpi-card"
      onClick={onClick}
      style={{
        ...cardStyle,
        flex: 1,
        minWidth: 140,
        cursor: onClick ? "pointer" : "default",
        border: active ? "2px solid #14161a" : "1px solid var(--border)",
        padding: 16,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: color || "var(--text-primary)" }}>
        {value}
        {sub && <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-secondary)", marginLeft: 6 }}>{sub}</span>}
      </div>
    </div>
  );
}

function Table({
  headers,
  rows,
  onRowClick,
  emptyMessage,
}: {
  headers: string[];
  rows: any[][];
  onRowClick?: (i: number) => void;
  emptyMessage?: string;
}) {
  return (
    <table className="responsive-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
      <thead>
        <tr style={{ textAlign: "left" }}>
          {headers.map((h) => (
            <th key={h} style={th}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td style={td} colSpan={headers.length}>
              {emptyMessage || "Sem dados."}
            </td>
          </tr>
        ) : (
          rows.map((row, i) => (
            <tr
              key={i}
              onClick={() => onRowClick?.(i)}
              style={{ borderTop: "1px solid var(--border)", cursor: onRowClick ? "pointer" : "default" }}
            >
              {row.map((cell, j) => (
                <td key={j} style={td}>
                  {cell}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--card-bg)",
  borderRadius: "var(--radius)",
  boxShadow: "var(--shadow)",
  border: "1px solid var(--border)",
  padding: 16,
  overflow: "hidden",
};

const primaryBtn: React.CSSProperties = {
  padding: "9px 16px",
  borderRadius: 10,
  border: "none",
  background: "var(--accent)",
  color: "#14161a",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 13,
};

const secondaryBtn: React.CSSProperties = {
  padding: "9px 16px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "white",
  color: "var(--text-primary)",
  fontWeight: 600,
  cursor: "pointer",
  fontSize: 13,
};

// Versões compactas — usadas na barra de botões da Sellers AM, que tinha
// ficado grande demais com tantas ações de import/sincronização juntas.
const primaryBtnSm: React.CSSProperties = { ...primaryBtn, padding: "5px 10px", fontSize: 12, borderRadius: 8 };
const secondaryBtnSm: React.CSSProperties = { ...secondaryBtn, padding: "5px 10px", fontSize: 12, borderRadius: 8 };

const th: React.CSSProperties = { padding: "10px 12px", fontWeight: 600, color: "var(--text-secondary)", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em" };
const td: React.CSSProperties = { padding: "12px", borderTop: "1px solid var(--border)" };
const selectStyle: React.CSSProperties = { padding: "9px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "white", fontSize: 13 };
const inlineInputStyle: React.CSSProperties = { width: 70, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 13 };
