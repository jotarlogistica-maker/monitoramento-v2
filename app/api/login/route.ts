import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_COOKIE_NAME,
  authCookieOptions,
  createAuthToken,
  isAppPasswordConfigured,
  matchesAppPassword,
} from "@/lib/auth";

export async function POST(req: NextRequest) {
  if (!isAppPasswordConfigured()) {
    return NextResponse.json({ error: "APP_PASSWORD não está configurada no ambiente." }, { status: 500 });
  }

  const { password } = await req.json().catch(() => ({}));
  if (!matchesAppPassword(password)) {
    return NextResponse.json({ error: "Senha incorreta." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE_NAME, await createAuthToken(), authCookieOptions());
  return response;
}
