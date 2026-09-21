import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const doc = await db().collection("data").doc("routes").get();
  const data = doc.data() || { routes: [], updatedAt: null };
  return NextResponse.json(data);
}
