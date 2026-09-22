import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";
import { deriveRadarStatusFromApi, isAwaitingStatus, isCanceledStatus, isFinishedStatus, RadarItem, RadarQuality, RadarVisit } from "@/lib/radar";
import { fetchSellerMonitoring } from "@/lib/sellerMonitoring";
import { getMlCookie } from "@/lib/sessionStore";
import { readRadarDocument, writeRadarDocument } from "@/lib/radarStore";
import { resolveClusterFromHistory } from "@/lib/sellerRouteHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_SIZE = 4;
const CONCURRENCY = 2;

async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += CONCURRENCY) {
    results.push(...(await Promise.all(items.slice(index, index + CONCURRENCY).map(fn))));
  }
  return results;
}

function clusterOf(routeName?: string): string {
  const match = String(routeName || "").match(/_C(\d+)(?:_|$)/i);
  return match ? `C${match[1].padStart(2, "0")}` : "—";
}

function orderToVisit(order: any): RadarVisit {
  return {
    routeId: order.routeId,
    routeName: order.routeName && order.routeName.trim() ? order.routeName : `Rota ID: ${order.routeId}`,
    cluster: clusterOf(order.routeName),
    routeStatus: order.statusRaw,
    stopStatus: order.status,
    timeFrame: typeof order.timeFrame === "string" ? order.timeFrame : undefined,
    prepared: typeof order.prepared === "number" ? order.prepared : null,
    collected: typeof order.collected === "number" ? order.collected : null,
    remaining: typeof order.remaining === "number" ? order.remaining : null,
    hasProblem: false,
    carrierName: order.carrierName,
    driverName: order.driverName,
  };
}

function resolveVisitCluster(visits: RadarVisit[], preferred: RadarVisit | null | undefined, fallback = "—") {
  const resolution = resolveClusterFromHistory(
    visits.map((visit) => ({
      rota: visit.routeName,
      routeId: visit.routeId,
      timeFromRaw: visit.timeFrom,
      intervalo: visit.timeFrame,
    })),
    preferred
      ? { rota: preferred.routeName, routeId: preferred.routeId, timeFromRaw: preferred.timeFrom, intervalo: preferred.timeFrame }
      : null
  );
  return { ...resolution, cluster: resolution.cluster !== "—" ? resolution.cluster : fallback };
}

const saoPauloTime = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function visitStartMinutes(visit: RadarVisit): number | null {
  if (typeof visit.timeFrom === "number" && Number.isFinite(visit.timeFrom)) {
    const parts = saoPauloTime.formatToParts(new Date(visit.timeFrom * 1000));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute;
  }

  const match = String(visit.timeFrame || "").match(/(?:^|\D)(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null;
}

function chooseNextVisit(item: RadarItem, apiVisits: RadarVisit[]): RadarVisit | null {
  const visits = apiVisits.map((visit) => {
    const scanned = item.visits.find((candidate) => candidate.routeId === visit.routeId);
    return {
      ...visit,
      timeFrom: visit.timeFrom ?? scanned?.timeFrom,
      timeTo: visit.timeTo ?? scanned?.timeTo,
    };
  });

  const originMinute = visitStartMinutes(item.trigger.route);
  const alternatives = visits
    .filter((visit) => visit.routeId !== item.trigger.route.routeId)
    .filter((visit) => !isCanceledStatus(visit.routeStatus, visit.stopStatus))
    .filter((visit) => {
      const minute = visitStartMinutes(visit);
      if (originMinute !== null && minute !== null) return minute >= originMinute;

      // Uma rota concluída sem horário conhecido pode ser uma visita anterior.
      // Só a tratamos como recuperação quando já havia evidência dela na
      // varredura; rotas ativas continuam válidas mesmo antes do próximo scan.
      if (isFinishedStatus(visit.routeStatus, visit.stopStatus)) {
        return item.visits.some((candidate) => candidate.routeId === visit.routeId) || item.nextVisit?.routeId === visit.routeId;
      }
      return true;
    })
    .sort((a, b) => (visitStartMinutes(a) ?? Number.MAX_SAFE_INTEGER) - (visitStartMinutes(b) ?? Number.MAX_SAFE_INTEGER));

  const collecting = alternatives.find(
    (visit) => !isAwaitingStatus(visit.routeStatus, visit.stopStatus) && !isFinishedStatus(visit.routeStatus, visit.stopStatus)
  );
  if (collecting) return collecting;
  const awaiting = alternatives.find((visit) => isAwaitingStatus(visit.routeStatus, visit.stopStatus));
  if (awaiting) return awaiting;
  const completed = alternatives.find((visit) => (visit.collected || 0) > 0 || isFinishedStatus(visit.routeStatus, visit.stopStatus));
  return completed || null;
}

async function handlePost(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const parsedCursor = Number(body.cursor || 0);
  const cursor = Number.isFinite(parsedCursor) ? Math.max(0, parsedCursor) : 0;
  const onlyIds: string[] | null = Array.isArray(body.onlyIds)
    ? Array.from(new Set(body.onlyIds.map((id: unknown) => String(id).trim()).filter(Boolean)))
    : null;

  let initialData;
  try {
    initialData = await Promise.all([
      getMlCookie(),
      readRadarDocument(db()),
      db().collection("config").doc("scan-lock-v2").get(),
    ]);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Não foi possível carregar o Radar." }, { status: 500 });
  }
  const [cookie, radarDocument, scanLockSnapshot] = initialData;

  if (!cookie) return NextResponse.json({ error: "Nenhuma sessão salva ainda." }, { status: 400 });
  if (Number(scanLockSnapshot.data()?.expiresAt || 0) > Date.now()) {
    return NextResponse.json({ error: "A varredura de rotas ainda está em andamento. Aguarde terminar antes de atualizar o Radar via API." }, { status: 409 });
  }

  const data = radarDocument;
  const items = (data.items || {}) as Record<string, RadarItem>;
  const knownIds = Object.keys(items);
  const ids: string[] = onlyIds && onlyIds.length > 0 ? onlyIds.filter((id) => knownIds.includes(id)) : knownIds;
  if (ids.length === 0) return NextResponse.json({ error: "O Radar ainda não possui IDs para atualizar." }, { status: 400 });

  const batch = ids.slice(cursor, cursor + BATCH_SIZE);
  let matched = 0;
  let notFound = 0;
  let errors = 0;
  const updates: Record<string, RadarItem> = {};

  const resultados = await mapLimited<string, { id: string; status: "ok" | "not_found" | "error"; erro?: string }>(batch, async (id) => {
    const item = items[id];
    try {
      const result = await fetchSellerMonitoring(item.rawId || id, item.type, cookie);
      if (!result.summary) {
        item.syncError = "A API não encontrou esse seller/place.";
        item.quality = "REVISAR";
        const statusState = deriveRadarStatusFromApi({
          pendingOperational: item.pendingOperational,
          nextVisit: item.nextVisit,
          quality: item.quality,
          statusOverride: item.statusOverride,
        });
        Object.assign(item, statusState);
        item.resolvedAt = statusState.active ? null : item.resolvedAt || Date.now();
        updates[id] = { ...item };
        notFound++;
        return { id, status: "not_found" as const };
      }

      const visits = result.facilityOrders.map(orderToVisit);
      const collectedRoutes = result.facilityOrders
        .filter((order) => !isAwaitingStatus(order.status, order.statusRaw))
        .reduce((sum, order) => sum + (order.collected || 0), 0);
      const collectedCard = result.summary.coletado;
      const cardLag = Math.max(0, collectedRoutes - collectedCard);
      const pendingOperational = Math.max(result.summary.preparado - cardLag, 0);
      const nextVisit = chooseNextVisit(item, visits);
      const warnings = new Set(item.warnings || []);
      if (result.discardedOtherFacilityRoutes) warnings.add("Rota(s) de outra regional foram descartadas.");
      if (result.usedRawId) warnings.add("Consulta resolvida pelo ID cru; o normalizado colidia com outro cliente.");
      if (result.facilityOrders.length === 0) warnings.add("A API não retornou rota da BRRJ02 para esse ponto.");

      const quality: RadarQuality = result.facilityOrders.length === 0 && result.orders.length > 0 ? "REVISAR" : "CONFIRMADO";
      const statusState = deriveRadarStatusFromApi({
        pendingOperational,
        nextVisit,
        quality,
        statusOverride: item.statusOverride,
      });

      const now = Date.now();
      const effectiveVisits = visits.length > 0 ? visits : item.visits;
      const clusterResolution = resolveVisitCluster(effectiveVisits, nextVisit, item.originCluster || item.cluster);
      const updatedItem: RadarItem = {
        ...item,
        name: result.summary.customerName || item.name,
        estimated: result.summary.estimado,
        prepared: result.summary.preparado,
        collected: collectedRoutes,
        collectedCard,
        collectedRoutes,
        cardLag,
        pendingOperational,
        visits: effectiveVisits,
        nextVisit,
        cluster: clusterResolution.cluster,
        currentCluster: clusterResolution.cluster,
        clusterFromHistory: clusterResolution.fromHistory,
        clusterSourceRouteName: String(clusterResolution.sourceRoute?.rota || "") || null,
        clusters: Array.from(new Set([...(item.clusters || []), ...visits.map((visit) => visit.cluster)])).filter((cluster) => !!cluster && cluster !== "—"),
        quality,
        warnings: Array.from(warnings),
        source: "api",
        syncError: null,
        apiUpdatedAt: now,
        resolvedAt: statusState.active ? null : item.resolvedAt || now,
        ...statusState,
      };
      items[id] = updatedItem;
      updates[id] = updatedItem;
      matched++;
      return { id, status: "ok" as const };
    } catch (error: any) {
      const message = error?.message || String(error);
      item.syncError = message;
      item.quality = "REVISAR";
      const errorStatus = deriveRadarStatusFromApi({
        pendingOperational: item.pendingOperational,
        nextVisit: item.nextVisit,
        quality: item.quality,
        statusOverride: item.statusOverride,
      });
      Object.assign(item, errorStatus);
      item.resolvedAt = errorStatus.active ? null : item.resolvedAt || Date.now();
      updates[id] = { ...item };
      errors++;
      return { id, status: "error" as const, erro: message };
    }
  });

  const latestData = await readRadarDocument(db());
  const latestItems = (latestData.items || {}) as Record<string, RadarItem>;

  for (const [id, update] of Object.entries(updates)) {
    const latest = latestItems[id];
      // Um reset executado durante a sincronização não deve ser desfeito por
      // uma resposta atrasada da API.
    if (!latest) continue;

    const statusOverride = latest.statusOverride ?? null;
    const statusState = deriveRadarStatusFromApi({
        pendingOperational: update.pendingOperational,
        nextVisit: update.nextVisit,
        quality: update.quality,
        statusOverride,
      });
    const mergedVisits = update.visits?.length ? update.visits : latest.visits;
    const mergedCluster = resolveVisitCluster(mergedVisits, update.nextVisit, latest.originCluster || latest.cluster);
    latestItems[id] = {
        ...latest,
        ...update,
        // Evidências recém-detectadas pela varredura têm precedência sobre a
        // fotografia antiga usada no início deste lote.
        trigger: latest.trigger,
        originCluster: latest.originCluster,
        currentCluster: mergedCluster.cluster,
        cluster: mergedCluster.cluster,
        clusterFromHistory: mergedCluster.fromHistory,
        clusterSourceRouteName: String(mergedCluster.sourceRoute?.rota || "") || null,
        firstDetectedAt: latest.firstDetectedAt,
        statusOverride,
        warnings: Array.from(new Set([...(latest.warnings || []), ...(update.warnings || [])])),
        clusters: Array.from(new Set([...(latest.clusters || []), ...(update.clusters || [])])),
        resolvedAt: statusState.active ? null : latest.resolvedAt || update.resolvedAt || Date.now(),
        ...statusState,
    };
  }

  await writeRadarDocument(db(), { ...latestData, items: latestItems, updatedAt: new Date().toISOString() });

  const nextCursor = cursor + BATCH_SIZE;
  const done = nextCursor >= ids.length;
  return NextResponse.json({
    ok: true,
    processed: Math.min(nextCursor, ids.length),
    total: ids.length,
    matched,
    notFound,
    errors,
    resultados,
    nextCursor: done ? null : nextCursor,
    done,
  });
}

export async function POST(req: NextRequest) {
  try {
    return await handlePost(req);
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Erro interno ao consultar o Radar pela API. O lote pode ser retomado." },
      { status: 500 }
    );
  }
}
