import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const doc = await db().collection("data").doc("rotas-am-lista").get();
  const data = doc.data() || { rotas: [], updatedAt: null };
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const rotas: string[] = Array.isArray(body.rotas) ? body.rotas : [];

  await db()
    .collection("data")
    .doc("rotas-am-lista")
    .set({ rotas, updatedAt: new Date().toISOString() });

  return NextResponse.json({ ok: true, count: rotas.length });
}
