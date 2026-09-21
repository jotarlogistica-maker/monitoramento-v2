import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { fetchEstimatedDataSummary } from "@/lib/mlApi";
import { getMlCookie } from "@/lib/sessionStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FACILITY_ID = "BRRJ02";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  try {
    const cookie = await getMlCookie();
    if (!cookie) {
      return NextResponse.json({ error: "Nenhuma sessão salva ainda." }, { status: 400 });
    }

    const resumo = await fetchEstimatedDataSummary(FACILITY_ID, cookie);
    return NextResponse.json({ ok: true, resumo, updatedAt: new Date().toISOString() });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Erro ao buscar o PU LIVE." }, { status: 502 });
  }
}
