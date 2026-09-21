import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { fetchEstimatedDataSummary } from "@/lib/mlApi";
import { saveMlCookie } from "@/lib/sessionStore";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { cookie } = await req.json().catch(() => ({}));
  if (typeof cookie !== "string" || cookie.trim().length < 20) {
    return NextResponse.json({ error: "Cookie inválido ou vazio." }, { status: 400 });
  }

  const normalizedCookie = cookie.trim();
  try {
    // Validação leve e sem efeitos colaterais: consulta somente o resumo da
    // facility. Não atualiza routes, stops, Radar nem inicia uma varredura.
    await fetchEstimatedDataSummary("BRRJ02", normalizedCookie);
    await saveMlCookie(normalizedCookie);
    return NextResponse.json({ ok: true, validated: true });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Não foi possível validar a sessão do Mercado Livre." },
      { status: 400 }
    );
  }
}
