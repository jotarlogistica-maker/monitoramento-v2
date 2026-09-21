import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
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

  await saveMlCookie(cookie.trim());
  return NextResponse.json({ ok: true });
}
