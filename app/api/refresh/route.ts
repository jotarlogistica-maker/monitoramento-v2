import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";
import { getMlCookie } from "@/lib/sessionStore";
import { fetchAllRoutes } from "@/lib/mlApi";
import { failUpdate, startUpdate, touchUpdate } from "@/lib/updateStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Facilities monitoradas. Depois a gente pode deixar isso editável na tela.
const FACILITIES = ["BRRJ02"];

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const cookie = await getMlCookie().catch(() => null);
  if (!cookie) {
    return NextResponse.json(
      { error: "Nenhuma sessão salva ainda. Cole o cookie na tela de login primeiro." },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const operationId = randomUUID();
  const started = await startUpdate({
    operationId,
    clientId: body.clientId,
    deviceLabel: body.deviceLabel,
    stage: "routes",
  });
  if (!started.acquired) {
    return NextResponse.json({ error: "Já existe uma atualização em andamento.", state: started.state }, { status: 409 });
  }

  try {
    const allRoutes = [];
    for (const facilityId of FACILITIES) {
      const routes = await fetchAllRoutes(facilityId, cookie);
      allRoutes.push(...routes);
    }

    await db().collection("data").doc("routes").set({
      routes: allRoutes,
      updatedAt: new Date().toISOString(),
    });

    await touchUpdate(operationId, {
      stage: "stops",
      processed: 0,
      total: allRoutes.length,
      message: "Rotas atualizadas. Buscando paradas.",
    });

    return NextResponse.json({ ok: true, count: allRoutes.length, operationId });
  } catch (err: any) {
    await failUpdate(operationId, err.message || "Não foi possível atualizar as rotas.").catch(() => undefined);
    return NextResponse.json(
      { error: err.message || "Erro ao buscar dados. Sessão pode ter expirado." },
      { status: 502 }
    );
  }
}
