import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";
import { clearStopsDocument } from "@/lib/stopsStore";

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  // Zera rotas, paradas e as assinaturas de rota salvas (usadas pra pular
  // rota sem alteração na varredura) — precisa zerar junto, senão uma
  // assinatura de ontem poderia, em tese, "bater" com uma rota de hoje que
  // reaproveitasse o mesmo ID e fazer a gente pular ela por engano. Não mexe
  // na sessão do ML (cookie continua valendo).
  await Promise.all([
    db().collection("data").doc("routes").set({ routes: [], updatedAt: null }),
    clearStopsDocument(db()),
    db().collection("data").doc("route-snapshots").set({ snapshots: {} }),
    db().collection("data").doc("radar-operacional").set({ items: {}, updatedAt: null, sourceStopsUpdatedAt: null }),
    db().collection("config").doc("scan-lock-v2").set({ token: null, acquiredAt: 0, expiresAt: 0 }),
  ]);

  return NextResponse.json({ ok: true });
}
