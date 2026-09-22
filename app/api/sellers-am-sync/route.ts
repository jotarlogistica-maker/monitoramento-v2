import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";
import { fetchSellerMonitoring } from "@/lib/sellerMonitoring";
import { normalizeId } from "@/lib/mlApi";
import { getMlCookie } from "@/lib/sessionStore";
import {
  chooseOperationalRoute,
  clusterFromRoute,
  mergeSellerRouteHistory,
  SellerRouteHistory,
} from "@/lib/sellerRouteHistory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Lotes pequenos para respeitar o rate limit da API do Logistics. O navegador
// chama o endpoint novamente usando o cursor devolvido.
const BATCH_SIZE = 8;
const CONCURRENCY = 3;

function formatStopTime(value: unknown): string {
  let timestamp = Number(value || 0);
  if (!timestamp) return "";
  if (timestamp < 1_000_000_000_000) timestamp *= 1000;
  return new Date(timestamp).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function readableStopStatus(status: unknown): string {
  const value = String(status || "").toLowerCase();
  if (value.includes("cancel")) return "Cancelado";
  if (value.includes("finish") || value.includes("success") || value.includes("collect")) return "Coletado";
  if (value.includes("progress") || value.includes("start")) return "Em andamento";
  if (value.includes("pending") || value.includes("planned") || value.includes("assign")) return "Sem Início";
  return String(status || "");
}

function routeFromStop(stop: any, routeMetadata?: any): SellerRouteHistory {
  const from = formatStopTime(stop.timeFrom);
  const to = formatStopTime(stop.timeTo);
  return {
    rota: stop.routeName || undefined,
    routeId: Number(stop.routeId || 0) || undefined,
    intervalo: from && to ? `${from} a ${to}` : from || to || undefined,
    status: readableStopStatus(stop.status),
    statusRaw: stop.status || undefined,
    preparadosRota: stop.preparedPackages ?? null,
    coletadosRota: stop.collectedPackages ?? null,
    restantesRota:
      typeof stop.preparedPackages === "number" && typeof stop.collectedPackages === "number"
        ? Math.max(stop.preparedPackages - stop.collectedPackages, 0)
        : null,
    timeFromRaw: stop.timeFrom ?? null,
    timeToRaw: stop.timeTo ?? null,
    carrierName: stop.carrierName || routeMetadata?.carrierName || undefined,
    driverName: stop.driverName || routeMetadata?.driverName || undefined,
  };
}

async function fetchWithLimitedConcurrency<T>(items: any[], fn: (item: any) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const chunk = items.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(chunk.map(fn))));
  }
  return results;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const { cursor = 0, testIds, onlyIds } = await req.json().catch(() => ({ cursor: 0 }));
  let cookie: string | null;
  try {
    cookie = await getMlCookie();
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Não foi possível abrir a sessão salva." }, { status: 500 });
  }
  if (!cookie) return NextResponse.json({ error: "Nenhuma sessão salva ainda." }, { status: 400 });

  // Pesquisa livre: usa o mesmo motor compartilhado por Sellers AM e Radar.
  if (Array.isArray(testIds) && testIds.length > 0) {

    const results = await Promise.all(
      testIds.map(async (rawId: string) => {
        const id = String(rawId).trim();
        const normalized = normalizeId(id);
        try {
          const result = await fetchSellerMonitoring(id, normalized.type, cookie);
          if (!result.summary) {
            return {
              id,
              normalizado: result.normalizedId,
              tipoTestado: result.referenceType,
              ok: false,
              erro: "get-packages-summary voltou sem 'details' (não achou esse ID).",
            };
          }
          return {
            id,
            normalizado: result.normalizedId,
            tipoTestado: result.referenceType,
            ok: true,
            customerId: result.summary.customerId,
            summary: result.summary,
            rotasEncontradas: result.orders.length,
            usouIdCru: result.usedRawId,
            rotas: result.facilityOrders.map((order) => ({
              rota: order.routeName && order.routeName.trim() ? order.routeName : `Rota ID: ${order.routeId}`,
              status: order.status,
              statusRaw: order.statusRaw,
              intervalo: order.timeFrame,
            })),
          };
        } catch (error: any) {
          return { id, normalizado: normalized.normalized, tipoTestado: normalized.type, ok: false, erro: error?.message || String(error) };
        }
      })
    );
    return NextResponse.json({ ok: true, results });
  }

  const [sellersDoc, stopsDoc, routesDoc] = await Promise.all([
    db().collection("data").doc("sellers-am").get(),
    db().collection("data").doc("stops").get(),
    db().collection("data").doc("routes").get(),
  ]);

  const sellers: Record<string, any> = sellersDoc.data()?.sellers || {};
  const stops: any[] = stopsDoc.data()?.stops || [];
  const routeMetadataById = new Map(
    ((routesDoc.data()?.routes || []) as any[]).map((route) => [Number(route.id), route])
  );
  const scannedRoutesBySeller = new Map<string, SellerRouteHistory[]>();
  stops.forEach((stop) => {
    const candidates = new Set(
      [stop.normalizedId, stop.rawId]
        .filter(Boolean)
        .flatMap((value) => {
          const raw = String(value);
          return [raw, normalizeId(raw).normalized];
        })
    );
    candidates.forEach((candidate) => {
      const routes = scannedRoutesBySeller.get(candidate) || [];
      routes.push(routeFromStop(stop, routeMetadataById.get(Number(stop.routeId))));
      scannedRoutesBySeller.set(candidate, routes);
    });
  });
  const idsValidos = Object.keys(sellers);
  const allIds = Array.isArray(onlyIds) && onlyIds.length > 0 ? onlyIds.filter((id: string) => idsValidos.includes(id)) : idsValidos;

  if (allIds.length === 0) {
    return NextResponse.json(
      { error: "Nenhum seller na base ainda (ou nenhum dos IDs informados está na base). Gera a base primeiro." },
      { status: 400 }
    );
  }

  const batchIds = allIds.slice(cursor, cursor + BATCH_SIZE);
  let matched = 0;
  let notFound = 0;
  let errors = 0;
  let lastError = "";
  const resultados: Array<{ id: string; status: "ok" | "not_found" | "error"; erro?: string }> = [];

  await fetchWithLimitedConcurrency(batchIds, async (id) => {
    const seller = sellers[id];
    const referenceType: "seller" | "place" = seller.tipo === "place" ? "place" : "seller";
    try {
      const result = await fetchSellerMonitoring(id, referenceType, cookie);
      if (!result.summary) {
        notFound++;
        resultados.push({ id, status: "not_found" });
        return;
      }

      const apiRoutes: SellerRouteHistory[] = result.facilityOrders.map((order) => ({
        // Se a API só devolver o ID, o merge mantém o nome já confirmado pela
        // varredura em vez de trocar por um rótulo genérico.
        rota: order.routeName && order.routeName.trim() ? order.routeName : undefined,
        routeId: order.routeId,
        intervalo: order.timeFrame,
        status: order.status,
        statusRaw: order.statusRaw,
        preparadosRota: order.prepared,
        coletadosRota: order.collected,
        restantesRota: order.remaining,
        carrierName: order.carrierName,
        driverName: order.driverName,
      }));
      const scannedRoutes = scannedRoutesBySeller.get(id) || [];
      const mergedRoutes = mergeSellerRouteHistory(seller.rotas || [], scannedRoutes, apiRoutes);
      const coletadoDasRotas = mergedRoutes.reduce((acc, route) => acc + Number(route.coletadosRota || 0), 0);
      const operationalRoute = chooseOperationalRoute(mergedRoutes);
      seller.estimado = result.summary.estimado;
      seller.preparado = result.summary.preparado;
      seller.coletado = coletadoDasRotas;
      seller.coletadoCard = result.summary.coletado;
      seller.impacto = seller.preparado - seller.coletado;
      seller.impactoNaoCalculado = false;
      seller.rotas = mergedRoutes;
      seller.ultimaRota = operationalRoute || undefined;
      seller.cluster = clusterFromRoute(operationalRoute);

      const warnings = new Set(Array.isArray(seller.avisos) ? seller.avisos : []);
      if (result.discardedOtherFacilityRoutes) warnings.add("Rota(s) de outra regional foram descartadas — confere esse ID manualmente.");
      if (result.usedRawId) warnings.add("Encontrado via ID cru (o normalizado batia com outro cliente/regional).");
      seller.avisos = Array.from(warnings);
      seller.historicoPreservado = result.facilityOrders.length === 0 && mergedRoutes.length > 0;
      seller.qualidade = mergedRoutes.length === 0 && result.orders.length > 0 ? "REVISAR" : "OK";
      seller.resumoFonte = mergedRoutes.some((route) => route.fonteHistorico === "varredura") ? "api-direta+varredura" : "api-direta";
      seller.syncError = undefined;
      seller.updatedAt = Date.now();
      matched++;
      resultados.push({ id, status: "ok" });
    } catch (error: any) {
      errors++;
      const message = error?.message || String(error);
      lastError = message;
      seller.syncError = message;
      resultados.push({ id, status: "error", erro: message });
    }
  });

  await db().collection("data").doc("sellers-am").set({ sellers, updatedAt: new Date().toISOString() });

  const nextCursor = cursor + BATCH_SIZE;
  const done = nextCursor >= allIds.length;
  return NextResponse.json({
    ok: true,
    processed: Math.min(nextCursor, allIds.length),
    total: allIds.length,
    matched,
    notFound,
    errors,
    lastError: errors > 0 ? lastError : undefined,
    resultados,
    nextCursor: done ? null : nextCursor,
    done,
  });
}
