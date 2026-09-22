import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";
import { RadarItem, RadarStatus, rebuildRadarFromFirestore } from "@/lib/radar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ALLOWED_STATUSES: RadarStatus[] = [
  "Reatribuir",
  "2ª Visita",
  "Coletando",
  "Coletado",
  "Revisar",
  "Perdido",
  "Ignorado",
];

function isActiveStatus(status: RadarStatus): boolean {
  return ["Reatribuir", "2ª Visita", "Coletando", "Revisar"].includes(status);
}

function applyOverride(item: RadarItem, value: RadarStatus | null): RadarItem {
  const status = value || item.automaticStatus;
  return {
    ...item,
    statusOverride: value,
    status,
    active: isActiveStatus(status),
    resolvedAt: isActiveStatus(status) ? null : item.resolvedAt || Date.now(),
  };
}

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const snapshot = await db().collection("data").doc("radar-operacional").get();
  const data = snapshot.data() || { items: {}, updatedAt: null, sourceStopsUpdatedAt: null };
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action || "rebuild";

  if (action === "rebuild") {
    const document = await rebuildRadarFromFirestore();
    return NextResponse.json({ ok: true, ...document });
  }

  if (!["bulk_override", "set_override", "clear_sync_error"].includes(action)) {
    return NextResponse.json({ error: "Ação desconhecida." }, { status: 400 });
  }

  const value = body.status == null || body.status === "" ? null : (body.status as RadarStatus);
  if ((action === "bulk_override" || action === "set_override") && value !== null && !ALLOWED_STATUSES.includes(value)) {
    return NextResponse.json({ error: "Status inválido." }, { status: 400 });
  }

  const ref = db().collection("data").doc("radar-operacional");
  const result = await db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() || { items: {}, updatedAt: null };
    const items = (data.items || {}) as Record<string, RadarItem>;

    if (action === "bulk_override") {
      const ids: string[] = Array.isArray(body.ids)
        ? Array.from(new Set<string>(body.ids.map((id: unknown) => String(id).trim()).filter(Boolean)))
        : [];
      let updated = 0;
      for (const id of ids) {
        if (!items[id]) continue;
        items[id] = applyOverride(items[id], value);
        updated++;
      }
      transaction.set(ref, { ...data, items, updatedAt: new Date().toISOString() });
      return { ok: true as const, updated, items };
    }

    const id = String(body.id || "").trim();
    if (!id || !items[id]) return { ok: false as const, status: 404, error: "Item do Radar não encontrado." };

    if (action === "set_override") items[id] = applyOverride(items[id], value);
    else items[id] = { ...items[id], syncError: null };

    transaction.set(ref, { ...data, items, updatedAt: new Date().toISOString() });
    return { ok: true as const, item: items[id] };
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
