import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const doc = await db().collection("data").doc("sellers-meta").get();
  const data = doc.data() || { estimado: {}, overrides: {}, occStatus: {}, updatedAt: null };
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { estimado, overrides, occStatus } = body as {
    estimado?: Record<string, number>;
    overrides?: Record<string, string>;
    occStatus?: Record<string, string>;
  };

  const ref = db().collection("data").doc("sellers-meta");
  const current = (await ref.get()).data() || { estimado: {}, overrides: {}, occStatus: {} };

  const merged = {
    estimado: estimado ? { ...current.estimado, ...estimado } : current.estimado || {},
    overrides: overrides ? { ...current.overrides, ...overrides } : current.overrides || {},
    occStatus: occStatus ? { ...current.occStatus, ...occStatus } : current.occStatus || {},
    updatedAt: new Date().toISOString(),
  };

  await ref.set(merged);
  return NextResponse.json({ ok: true });
}
