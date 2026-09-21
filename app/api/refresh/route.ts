import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";
import { getMlCookie } from "@/lib/sessionStore";
import { fetchAllRoutes } from "@/lib/mlApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Facilities monitoradas. Depois a gente pode deixar isso editável na tela.
const FACILITIES = ["BRRJ02"];

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  try {
    const cookie = await getMlCookie();
    if (!cookie) {
      return NextResponse.json(
        { error: "Nenhuma sessão salva ainda. Cole o cookie na tela de login primeiro." },
        { status: 400 }
      );
    }

    const allRoutes = [];
    for (const facilityId of FACILITIES) {
      const routes = await fetchAllRoutes(facilityId, cookie);
      allRoutes.push(...routes);
    }

    await db().collection("data").doc("routes").set({
      routes: allRoutes,
      updatedAt: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true, count: allRoutes.length });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Erro ao buscar dados. Sessão pode ter expirado." },
      { status: 502 }
    );
  }
}
