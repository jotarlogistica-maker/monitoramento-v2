import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { failUpdate, finishUpdate, getUpdateStatus, startUpdate } from "@/lib/updateStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  return NextResponse.json(await getUpdateStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (body.action === "start") {
    const operationId = randomUUID();
    const result = await startUpdate({
      operationId,
      clientId: body.clientId,
      deviceLabel: body.deviceLabel,
      stage: body.stage === "stops" ? "stops" : "routes",
      total: Number(body.total || 0),
    });
    if (!result.acquired) return NextResponse.json({ error: "Já existe uma atualização em andamento.", state: result.state }, { status: 409 });
    return NextResponse.json({ ok: true, operationId, state: result.state });
  }
  if (!body.operationId) return NextResponse.json({ error: "Operação não informada." }, { status: 400 });
  if (body.action === "finish") return NextResponse.json(await finishUpdate(body.operationId, body.message));
  if (body.action === "fail") return NextResponse.json(await failUpdate(body.operationId, body.message || "A atualização foi interrompida."));
  return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
}
