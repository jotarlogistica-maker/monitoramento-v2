import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";
import { fetchSellerMonitoring } from "@/lib/sellerMonitoring";
import { normalizeId } from "@/lib/mlApi";
import { getMlCookie } from "@/lib/sessionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Lotes pequenos para respeitar o rate limit da API do Logistics. O navegador
// chama o endpoint novamente usando o cursor devolvido.
const BATCH_SIZE = 8;
const CONCURRENCY = 3;

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

  const sellersDoc = await db().collection("data").doc("sellers-am").get();

  const sellers: Record<string, any> = sellersDoc.data()?.sellers || {};
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

      const coletadoDasRotas = result.facilityOrders.reduce((acc, order) => acc + (order.collected || 0), 0);
      seller.estimado = result.summary.estimado;
      seller.preparado = result.summary.preparado;
      seller.coletado = coletadoDasRotas;
      seller.coletadoCard = result.summary.coletado;
      seller.impacto = seller.preparado - seller.coletado;
      seller.impactoNaoCalculado = false;
      seller.rotas = result.facilityOrders.map((order) => ({
        rota: order.routeName && order.routeName.trim() ? order.routeName : `Rota ID: ${order.routeId}`,
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

      const warnings = new Set(Array.isArray(seller.avisos) ? seller.avisos : []);
      if (result.discardedOtherFacilityRoutes) warnings.add("Rota(s) de outra regional foram descartadas — confere esse ID manualmente.");
      if (result.usedRawId) warnings.add("Encontrado via ID cru (o normalizado batia com outro cliente/regional).");
      seller.avisos = Array.from(warnings);
      seller.qualidade = result.facilityOrders.length === 0 && result.orders.length > 0 ? "REVISAR" : "OK";
      seller.resumoFonte = "api-direta";
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
