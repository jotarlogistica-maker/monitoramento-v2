import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";
import { readStopsDocument } from "@/lib/stopsStore";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const data = await readStopsDocument(db());
  return NextResponse.json({ stops: data.stops, updatedAt: data.updatedAt });
}
