import { db } from "@/lib/firebaseAdmin";
import type { Route, Stop } from "@/lib/mlApi";
import { reconcileVisitPackages } from "@/lib/pointMetrics";
import { readStopsDocument } from "@/lib/stopsStore";
import { readRadarDocument, writeRadarDocument } from "@/lib/radarStore";
import { resolveClusterFromHistory } from "@/lib/sellerRouteHistory";

export type RadarStatus =
  | "Reatribuir"
  | "2ª Visita"
  | "Coletando"
  | "Coletado"
  | "Revisar"
  | "Perdido"
  | "Ignorado";

export type RadarQuality = "CONFIRMADO" | "ESTIMADO" | "REVISAR";

export type RadarVisit = {
  routeId: number;
  routeName: string;
  cluster: string;
  routeStatus?: string;
  stopStatus?: string;
  timeFrom?: number;
  timeTo?: number;
  timeFrame?: string;
  prepared: number | null;
  collected: number | null;
  remaining: number | null;
  hasProblem: boolean;
  problemType?: string;
  carrierName?: string;
  driverName?: string;
};

export type RadarTrigger = {
  code: "occurrence" | "canceled" | "partial" | "no_collection" | "inconclusive";
  label: string;
  detail?: string;
  route: RadarVisit;
};

export type RadarItem = {
  id: string;
  rawId: string;
  type: "seller" | "place";
  name: string;
  cluster: string;
  originCluster: string;
  currentCluster: string;
  clusters: string[];
  clusterFromHistory?: boolean;
  clusterSourceRouteName?: string | null;

  trigger: RadarTrigger;
  visits: RadarVisit[];
  nextVisit: RadarVisit | null;

  estimated: number | null;
  prepared: number | null;
  collected: number | null;
  collectedCard?: number | null;
  collectedRoutes?: number | null;
  cardLag?: number | null;
  pendingOperational: number | null;

  automaticStatus: RadarStatus;
  statusOverride?: RadarStatus | null;
  status: RadarStatus;
  active: boolean;
  quality: RadarQuality;
  warnings: string[];
  syncError?: string | null;
  source: "routes" | "api";

  firstDetectedAt: number;
  lastDetectedAt: number;
  apiUpdatedAt?: number | null;
  resolvedAt?: number | null;
};

export type RadarDocument = {
  items: Record<string, RadarItem>;
  updatedAt: string | null;
  sourceStopsUpdatedAt?: string | null;
};

type RouteLike = Partial<Route> & { id: number; routeName?: string; status?: string };
type StopLike = Partial<Stop> & { routeId: number; routeName?: string };

function getCluster(routeName?: string | null): string {
  const match = String(routeName || "").match(/_C(\d+)(?:_|$)/i);
  return match ? `C${match[1].padStart(2, "0")}` : "—";
}

function text(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function isCanceledStatus(...values: unknown[]): boolean {
  return values.some((value) => text(value).includes("cancel"));
}

export function isAwaitingStatus(...values: unknown[]): boolean {
  return values.some((value) => {
    const status = text(value);
    return (
      status.includes("pending") ||
      status.includes("sem in") ||
      status.includes("não inic") ||
      status.includes("nao inic") ||
      status.includes("scheduled") ||
      status.includes("assigned") ||
      status.includes("planned") ||
      status.includes("waiting") ||
      status.includes("created") ||
      status.includes("open")
    );
  });
}

export function isFinishedStatus(...values: unknown[]): boolean {
  return values.some((value) => {
    const status = text(value);
    return (
      status === "close" ||
      status.includes("finish") ||
      status.includes("complet") ||
      status.includes("success") ||
      status.includes("coletado") ||
      status.includes("collected")
    );
  });
}


function isFailureStatus(...values: unknown[]): boolean {
  return values.some((value) => {
    const status = text(value);
    return (
      status.includes("fail") ||
      status.includes("error") ||
      status.includes("incident") ||
      status.includes("problem") ||
      status.includes("reject") ||
      status.includes("refus") ||
      status.includes("absent") ||
      status.includes("not_home") ||
      status.includes("no_show") ||
      status.includes("skip") ||
      status.includes("inconclusive") ||
      status.includes("not_collected") ||
      status.includes("nao colet") ||
      status.includes("não colet")
    );
  });
}

function isCollectingStatus(...values: unknown[]): boolean {
  return values.some((value) => {
    const status = text(value);
    return status.includes("progress") || status.includes("collecting") || status.includes("coletando") || status.includes("started");
  });
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function remainingForStop(stop: StopLike): number | null {
  const prepared = toNullableNumber(stop.preparedPackages);
  const estimated = toNullableNumber(stop.estimatedPackages);
  const collected = toNullableNumber(stop.collectedPackages);
  const base = prepared ?? estimated;
  // Ausência de leitura não é zero. Quando não conhecemos a coleta ou a base,
  // o Radar inclui o evento para revisão e deixa a API direta confirmar.
  return base === null || collected === null ? null : Math.max(base - collected, 0);
}

function buildVisit(stop: StopLike, route?: RouteLike): RadarVisit {
  return {
    routeId: stop.routeId,
    routeName: stop.routeName || route?.routeName || `Rota ${stop.routeId}`,
    cluster: getCluster(stop.routeName || route?.routeName),
    routeStatus: route?.status,
    stopStatus: stop.status,
    timeFrom: toNullableNumber(stop.timeFrom) ?? undefined,
    timeTo: toNullableNumber(stop.timeTo) ?? undefined,
    prepared: toNullableNumber(stop.preparedPackages),
    collected: toNullableNumber(stop.collectedPackages),
    remaining: remainingForStop(stop),
    hasProblem: !!stop.hasProblem,
    problemType: stop.problemType || undefined,
    carrierName: route?.carrierName,
    driverName: route?.driverName,
  };
}

function visitOrder(visit: RadarVisit): number {
  return visit.timeFrom || visit.timeTo || visit.routeId || 0;
}

function dedupeStopsByRoute(stops: StopLike[]): StopLike[] {
  const byRoute = new Map<number, StopLike>();
  for (const stop of [...stops].sort((a, b) => (a.timeFrom || 0) - (b.timeFrom || 0))) {
    const current = byRoute.get(stop.routeId);
    if (!current || (stop.timeFrom || 0) >= (current.timeFrom || 0)) byRoute.set(stop.routeId, stop);
  }
  return Array.from(byRoute.values()).sort((a, b) => (a.timeFrom || a.routeId) - (b.timeFrom || b.routeId));
}

function triggerForVisit(visit: RadarVisit): RadarTrigger | null {
  // Se o restante for conhecido e igual a zero, não há impacto a acompanhar.
  // Quando o valor não foi lido, preservamos o evento como Revisar em vez de
  // transformar o desconhecido em zero e esconder um possível problema.
  if (visit.remaining !== null && visit.remaining <= 0) return null;

  if (visit.hasProblem) {
    return {
      code: "occurrence",
      label: visit.problemType || "Ocorrência do motorista",
      detail: visit.problemType,
      route: visit,
    };
  }
  if (isCanceledStatus(visit.routeStatus, visit.stopStatus)) {
    return { code: "canceled", label: "Rota ou parada cancelada", route: visit };
  }
  if (isFailureStatus(visit.routeStatus, visit.stopStatus)) {
    return { code: "inconclusive", label: "Visita não concluída", route: visit };
  }
  if (isFinishedStatus(visit.routeStatus, visit.stopStatus)) {
    const collected = visit.collected ?? 0;
    return collected > 0
      ? { code: "partial", label: "Coleta parcial", route: visit }
      : { code: "no_collection", label: "Rota finalizada sem coleta", route: visit };
  }
  return null;
}

function isValidVisitAfterTrigger(visit: RadarVisit, trigger: RadarVisit): boolean {
  if (visit.routeId === trigger.routeId) return false;
  if (visitOrder(visit) < visitOrder(trigger)) return false;
  if (visit.hasProblem || isCanceledStatus(visit.routeStatus, visit.stopStatus)) return false;
  return (
    isAwaitingStatus(visit.routeStatus, visit.stopStatus) ||
    isCollectingStatus(visit.routeStatus, visit.stopStatus) ||
    isFinishedStatus(visit.routeStatus, visit.stopStatus) ||
    (visit.collected ?? 0) > 0
  );
}

function automaticStatus(pending: number | null, nextVisit: RadarVisit | null, quality: RadarQuality): RadarStatus {
  if (pending === null || quality === "REVISAR") return "Revisar";
  if (pending <= 0) return "Coletado";
  if (nextVisit) {
    if (isAwaitingStatus(nextVisit.routeStatus, nextVisit.stopStatus)) return "2ª Visita";
    if (!isFinishedStatus(nextVisit.routeStatus, nextVisit.stopStatus)) return "Coletando";
    // Uma visita posterior já finalizada não cobre pacotes que continuam
    // preparados depois dela. Se ainda há pendência, volta para reatribuição.
    return "Reatribuir";
  }
  return "Reatribuir";
}

function statusIsActive(status: RadarStatus): boolean {
  return status === "Reatribuir" || status === "2ª Visita" || status === "Coletando" || status === "Revisar";
}

function mergeWarnings(...groups: Array<unknown>): string[] {
  const values = groups.flatMap((group) => (Array.isArray(group) ? group : [])).filter((value): value is string => typeof value === "string" && !!value.trim());
  return Array.from(new Set(values));
}

function analyzePoint(
  id: string,
  pointStops: StopLike[],
  routeMap: Map<number, RouteLike>,
  existing?: RadarItem
): { item: RadarItem; candidate: boolean } | null {
  const deduped = dedupeStopsByRoute(pointStops);
  if (deduped.length === 0) return null;

  const visits = deduped.map((stop) => buildVisit(stop, routeMap.get(stop.routeId))).sort((a, b) => visitOrder(a) - visitOrder(b));
  const triggers = visits.map(triggerForVisit).filter((trigger): trigger is RadarTrigger => !!trigger);
  const trigger = triggers[triggers.length - 1] || existing?.trigger;
  if (!trigger) return null;

  const laterValidVisits = visits.filter((visit) => isValidVisitAfterTrigger(visit, trigger.route));
  // Uma visita concluída não pode esconder uma terceira visita ainda ativa.
  // Priorizamos a próxima cobertura aberta/em andamento; quando só existem
  // visitas finalizadas, usamos a mais recente como evidência de recuperação.
  const nextVisit =
    laterValidVisits.find((visit) => !isFinishedStatus(visit.routeStatus, visit.stopStatus)) ||
    laterValidVisits[laterValidVisits.length - 1] ||
    null;
  const lastVisit = visits[visits.length - 1];
  const reconciled = reconcileVisitPackages(
    visits.map((visit) => ({
      prepared: visit.prepared,
      collected: visit.collected,
      remaining: visit.remaining,
      preserveRemaining:
        isAwaitingStatus(visit.routeStatus, visit.stopStatus) || isCollectingStatus(visit.routeStatus, visit.stopStatus),
    }))
  );
  const collectedObserved = reconciled.collected;
  const pendingObserved = reconciled.pending;
  const preparedObserved = reconciled.prepared;
  const estimated = deduped
    .map((stop) => toNullableNumber(stop.estimatedPackages))
    .find((value): value is number => value !== null) ?? null;

  const warnings: string[] = [];
  if (pendingObserved === null) warnings.push("Não foi possível calcular o pendente pelas paradas.");
  if (collectedObserved === null) warnings.push("Existe visita sem quantidade coletada confirmada.");
  if (estimated === null) warnings.push("O estimado não foi lido nas paradas.");
  if (visits.some((visit) => visit.cluster === "—")) warnings.push("Existe rota sem cluster identificável.");
  if (reconciled.overlapRemoved > 0) {
    warnings.push(`${reconciled.overlapRemoved} pacote(s) sobreposto(s) entre visitas foram reconciliados.`);
  }

  const routeQuality: RadarQuality = pendingObserved === null || collectedObserved === null ? "REVISAR" : "ESTIMADO";
  const effectivePending = existing?.source === "api"
    ? existing.pendingOperational === null
      ? pendingObserved
      : pendingObserved === null
        ? existing.pendingOperational
        : Math.max(existing.pendingOperational, pendingObserved)
    : pendingObserved;
  const effectiveQuality = existing?.source === "api" ? existing.quality : routeQuality;
  const inferredStatus = automaticStatus(effectivePending, nextVisit, effectiveQuality);
  const statusOverride = existing?.statusOverride ?? null;
  const status = statusOverride || inferredStatus;
  const now = Date.now();
  const routesForCluster = visits.map((visit) => ({
    rota: visit.routeName,
    routeId: visit.routeId,
    timeFromRaw: visit.timeFrom,
    intervalo: visit.timeFrame,
  }));
  const preferredVisit = nextVisit || lastVisit;
  const clusterResolution = resolveClusterFromHistory(routesForCluster, preferredVisit ? {
    rota: preferredVisit.routeName,
    routeId: preferredVisit.routeId,
    timeFromRaw: preferredVisit.timeFrom,
    intervalo: preferredVisit.timeFrame,
  } : null);
  const originResolution = resolveClusterFromHistory(routesForCluster, {
    rota: trigger.route.routeName,
    routeId: trigger.route.routeId,
    timeFromRaw: trigger.route.timeFrom,
    intervalo: trigger.route.timeFrame,
  });
  const originCluster = originResolution.cluster;
  const currentCluster = clusterResolution.cluster !== "—" ? clusterResolution.cluster : originCluster;
  if (clusterResolution.fromHistory && clusterResolution.sourceRoute?.rota) {
    warnings.push(`Cluster ${currentCluster} recuperado do histórico da rota ${clusterResolution.sourceRoute.rota}.`);
  }

  const item: RadarItem = {
    id,
    rawId: String(deduped.find((stop) => stop.rawId)?.rawId || existing?.rawId || id),
    type: (deduped.find((stop) => stop.idType)?.idType as "seller" | "place" | undefined) || existing?.type || "seller",
    name: String(deduped.find((stop) => stop.sellerName)?.sellerName || existing?.name || id),
    cluster: currentCluster,
    originCluster,
    currentCluster,
    clusters: Array.from(new Set(visits.map((visit) => visit.cluster))).filter((cluster) => !!cluster && cluster !== "—"),
    clusterFromHistory: clusterResolution.fromHistory,
    clusterSourceRouteName: String(clusterResolution.sourceRoute?.rota || "") || null,
    trigger,
    visits,
    nextVisit,
    estimated: existing?.source === "api" ? existing.estimated : estimated,
    prepared: existing?.source === "api" ? existing.prepared : preparedObserved,
    collected: existing?.source === "api" ? existing.collected : collectedObserved,
    collectedCard: existing?.collectedCard ?? null,
    collectedRoutes: existing?.collectedRoutes ?? null,
    cardLag: existing?.cardLag ?? null,
    pendingOperational: effectivePending,
    automaticStatus: inferredStatus,
    statusOverride,
    status,
    active: statusIsActive(status),
    quality: effectiveQuality,
    warnings: mergeWarnings(existing?.warnings, warnings),
    syncError: existing?.syncError ?? null,
    source: existing?.source === "api" ? "api" : "routes",
    firstDetectedAt: existing?.firstDetectedAt || now,
    lastDetectedAt: now,
    apiUpdatedAt: existing?.apiUpdatedAt ?? null,
    resolvedAt: statusIsActive(status) ? null : existing?.resolvedAt || now,
  };

  // Descobre automaticamente casos sem cobertura ATIVA. Uma visita posterior
  // já concluída entra como histórico recuperado (oculto pelo filtro padrão),
  // permitindo que a atualização via API detecte pacotes preparados depois da
  // última coleta e reabra o caso como Reatribuir.
  const hasActiveCoverage = !!nextVisit && !isFinishedStatus(nextVisit.routeStatus, nextVisit.stopStatus);
  return { item, candidate: !hasActiveCoverage };
}

/**
 * Recalcula o Radar sem apagar o histórico do dia. Novos candidatos entram;
 * registros já existentes permanecem para mostrar reatribuição/recuperação.
 */
export function buildRadarDocument(
  routes: RouteLike[],
  stops: StopLike[],
  existingItems: Record<string, RadarItem> = {},
  sourceStopsUpdatedAt?: string | null
): RadarDocument {
  const routeMap = new Map(routes.map((route) => [route.id, route]));
  const currentRouteIds = new Set(routes.map((route) => route.id));
  const validStops = stops.filter((stop) => currentRouteIds.has(stop.routeId));
  const grouped = new Map<string, StopLike[]>();

  for (const stop of validStops) {
    const id = String(stop.normalizedId || stop.rawId || "").trim();
    if (!id) continue;
    const rows = grouped.get(id) || [];
    rows.push(stop);
    grouped.set(id, rows);
  }

  const items: Record<string, RadarItem> = {};
  for (const [id, pointStops] of grouped) {
    const analyzed = analyzePoint(id, pointStops, routeMap, existingItems[id]);
    if (!analyzed) continue;
    if (analyzed.candidate || existingItems[id]) items[id] = analyzed.item;
  }

  // Um item antigo pode desaparecer temporariamente da lista de rotas durante a
  // atualização. Mantemos o registro e sinalizamos revisão, sem inventar zero.
  for (const [id, oldItem] of Object.entries(existingItems)) {
    if (items[id]) continue;
    const automatic: RadarStatus = oldItem.pendingOperational === 0 ? "Coletado" : "Revisar";
    const status = oldItem.statusOverride || automatic;
    items[id] = {
      ...oldItem,
      automaticStatus: automatic,
      status,
      active: statusIsActive(status),
      quality: automatic === "Revisar" ? "REVISAR" : oldItem.quality,
      warnings: mergeWarnings(oldItem.warnings, ["O ponto não apareceu nas rotas atuais; confirmar manualmente."]),
      resolvedAt: statusIsActive(status) ? null : oldItem.resolvedAt || Date.now(),
    };
  }

  return { items, updatedAt: new Date().toISOString(), sourceStopsUpdatedAt: sourceStopsUpdatedAt || null };
}

export async function rebuildRadarFromFirestore(): Promise<RadarDocument> {
  const routesRef = db().collection("data").doc("routes");
  const [stopsData, routesSnapshot, existingDocument] = await Promise.all([
    readStopsDocument(db()),
    routesRef.get(),
    readRadarDocument(db()),
  ]);
  const routes = (routesSnapshot.data()?.routes || []) as RouteLike[];
  const stops = (stopsData.stops || []) as StopLike[];
  const document = buildRadarDocument(routes, stops, existingDocument.items || {}, stopsData.updatedAt || null);
  await writeRadarDocument(db(), document);
  return document;
}

export function deriveRadarStatusFromApi(params: {
  pendingOperational: number | null;
  nextVisit: RadarVisit | null;
  quality: RadarQuality;
  statusOverride?: RadarStatus | null;
}): { automaticStatus: RadarStatus; status: RadarStatus; active: boolean } {
  const inferred = automaticStatus(params.pendingOperational, params.nextVisit, params.quality);
  const status = params.statusOverride || inferred;
  return { automaticStatus: inferred, status, active: statusIsActive(status) };
}
