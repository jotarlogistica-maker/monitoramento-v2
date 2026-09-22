import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";
import { fetchRouteDetail } from "@/lib/mlApi";
import { getMlCookie } from "@/lib/sessionStore";
import { readStopsDocument, writeStopsDocument } from "@/lib/stopsStore";
import { touchUpdate } from "@/lib/updateStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_SIZE = 10;
const CONCURRENCY = 3;
const LEASE_MS = 65_000;

async function fetchWithLimitedConcurrency<T>(items: any[], fn: (item: any) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  for (let index = 0; index < items.length; index += CONCURRENCY) {
    results.push(...(await Promise.all(items.slice(index, index + CONCURRENCY).map(fn))));
  }
  return results;
}

function routeSignature(route: any): string {
  return [
    route.totalStops,
    route.estimatedPackages,
    route.collectedPackages,
    route.preparedPackages,
    route.status,
    route.successfulStops,
    route.failedStops,
    route.withProblemStops,
    route.pendingStops,
  ].join("|");
}

async function acquireLease(): Promise<{ token: string | null; retryAfterMs: number }> {
  const token = randomUUID();
  const ref = db().collection("config").doc("scan-lock-v2");
  const now = Date.now();

  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const expiresAt = Number(snapshot.data()?.expiresAt || 0);
    if (expiresAt > now) return { token: null, retryAfterMs: expiresAt - now };
    transaction.set(ref, { token, acquiredAt: now, expiresAt: now + LEASE_MS });
    return { token, retryAfterMs: 0 };
  });
}

async function releaseLease(token: string): Promise<void> {
  const ref = db().collection("config").doc("scan-lock-v2");
  await db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.data()?.token === token) transaction.set(ref, { token: null, acquiredAt: 0, expiresAt: 0 });
  });
}

function shouldScanRoute(route: any, routeIdsWithData: Set<number>, snapshots: Record<string, string>): boolean {
  if (!routeIdsWithData.has(route.id)) return true;

  // Uma rota que acabou de mudar para "close" ainda precisa de uma última
  // leitura: é justamente nessa transição que a coleta final, cancelamentos ou
  // ocorrências podem aparecer no detalhe. Depois que a assinatura final for
  // salva, as próximas atualizações serão puladas normalmente.
  return snapshots[String(route.id)] !== routeSignature(route);
}

async function persistStopsAndSnapshots(params: {
  allRoutes: any[];
  routesProcessed: any[];
  newStops: any[];
  snapshots: Record<string, string>;
}) {
  const { allRoutes, routesProcessed, newStops } = params;
  const currentRouteIds = new Set(allRoutes.map((route) => route.id));
  const processedRouteIds = new Set(routesProcessed.map((route) => route.id));
  const snapshotsRef = db().collection("data").doc("route-snapshots");

  const [stopsDocument, currentSnapshotsSnapshot] = await Promise.all([
    readStopsDocument(db()),
    snapshotsRef.get(),
  ]);
  const existingStops: any[] = stopsDocument.stops;

  // Remove rotas que não existem mais na lista atual e substitui as que foram
  // reescaneadas. Isso impede visitas antigas de parecerem uma cobertura válida.
  const keptStops = existingStops.filter(
    (stop) => currentRouteIds.has(stop.routeId) && !processedRouteIds.has(stop.routeId)
  );
  const routeById = new Map(allRoutes.map((route) => [Number(route.id), route]));
  const enrichedStops = [...keptStops, ...newStops].map((stop) => {
    const route = routeById.get(Number(stop.routeId));
    return {
      ...stop,
      carrierName: route?.carrierName ?? stop.carrierName ?? null,
      driverName: route?.driverName ?? stop.driverName ?? null,
    };
  });
  const updatedAt = new Date().toISOString();
  await writeStopsDocument(db(), enrichedStops, updatedAt);

  const currentSnapshots: Record<string, string> = currentSnapshotsSnapshot.data()?.snapshots || {};
  const validSnapshots: Record<string, string> = {};
  for (const route of allRoutes) {
    const previous = currentSnapshots[String(route.id)] ?? params.snapshots[String(route.id)];
    if (previous) validSnapshots[String(route.id)] = previous;
  }
  for (const route of routesProcessed) validSnapshots[String(route.id)] = routeSignature(route);
  await snapshotsRef.set({ snapshots: validSnapshots, updatedAt });

  return updatedAt;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const cursor = Math.max(0, Number(body.cursor || 0));
  const forceRouteIds = Array.isArray(body.forceRouteIds) ? body.forceRouteIds.map(Number) : [];
  const operationId = typeof body.operationId === "string" ? body.operationId : "";

  let initialData;
  try {
    initialData = await Promise.all([
      getMlCookie(),
      db().collection("data").doc("routes").get(),
      readStopsDocument(db()),
      db().collection("data").doc("route-snapshots").get(),
    ]);
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Não foi possível carregar os dados da varredura." }, { status: 500 });
  }
  const [cookie, routesSnapshot, stopsDocument, snapshotsSnapshot] = initialData;

  const allRoutes: any[] = routesSnapshot.data()?.routes || [];
  const existingStops: any[] = stopsDocument.stops || [];
  const snapshots: Record<string, string> = snapshotsSnapshot.data()?.snapshots || {};

  if (!cookie) return NextResponse.json({ error: "Nenhuma sessão salva ainda." }, { status: 400 });
  if (allRoutes.length === 0) {
    return NextResponse.json({ error: "Nenhuma rota carregada ainda. Clica em 'Atualizar rotas' primeiro." }, { status: 400 });
  }

  if (operationId) {
    const activeOperation = await touchUpdate(operationId, {
      stage: "stops",
      processed: cursor,
      total: allRoutes.length,
      message: "Buscando paradas das rotas.",
    });
    if (!activeOperation) {
      return NextResponse.json({ error: "Esta atualização não está mais ativa. Recarregue o painel antes de tentar novamente." }, { status: 409 });
    }
  }

  const lease = await acquireLease();
  if (!lease.token) {
    return NextResponse.json(
      {
        error: "Já existe uma varredura em andamento. A tentativa será liberada automaticamente se a outra execução parar.",
        retryAfterMs: lease.retryAfterMs,
      },
      { status: 409 }
    );
  }
  const leaseToken = lease.token;

  try {
    if (forceRouteIds.length > 0) {
      const wanted = new Set(forceRouteIds);
      const routesToForce = allRoutes.filter((route) => wanted.has(route.id));
      if (routesToForce.length === 0) {
        return NextResponse.json({ error: "Nenhuma dessas rotas foi encontrada na lista atual." }, { status: 400 });
      }
      const results = await fetchWithLimitedConcurrency(routesToForce, (route) => fetchRouteDetail(route.id, cookie));
      await persistStopsAndSnapshots({
        allRoutes,
        routesProcessed: routesToForce,
        newStops: results.flatMap((result) => result.stops),
        snapshots,
      });
      return NextResponse.json({ ok: true, processed: routesToForce.length, total: routesToForce.length, done: true });
    }

    // O cursor percorre a lista estável de TODAS as rotas. A implementação
    // anterior percorria uma lista que encolhia a cada lote e podia pular rotas.
    const windowRoutes = allRoutes.slice(cursor, cursor + BATCH_SIZE);
    const routeIdsWithData = new Set(existingStops.map((stop: any) => stop.routeId));
    const routesToScan = windowRoutes.filter((route) => shouldScanRoute(route, routeIdsWithData, snapshots));
    const results = await fetchWithLimitedConcurrency(routesToScan, (route) => fetchRouteDetail(route.id, cookie));
    const nextCursor = cursor + BATCH_SIZE;
    const done = nextCursor >= allRoutes.length;

    await persistStopsAndSnapshots({
      allRoutes,
      routesProcessed: routesToScan,
      newStops: results.flatMap((result) => result.stops),
      snapshots,
    });

    if (operationId) {
      await touchUpdate(operationId, {
        stage: done ? "radar" : "stops",
        processed: Math.min(nextCursor, allRoutes.length),
        total: allRoutes.length,
        message: done ? "Consolidando o Radar." : "Buscando paradas das rotas.",
      });
    }

    return NextResponse.json({
      ok: true,
      processed: Math.min(nextCursor, allRoutes.length),
      scanned: routesToScan.length,
      skipped: windowRoutes.length - routesToScan.length,
      total: allRoutes.length,
      nextCursor: done ? null : nextCursor,
      done,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Erro ao buscar paradas." }, { status: 502 });
  } finally {
    await releaseLease(leaseToken).catch(() => undefined);
  }
}
