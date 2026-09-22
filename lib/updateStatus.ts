import { db } from "@/lib/firebaseAdmin";

export type SharedUpdateStatus = {
  status: "idle" | "running" | "completed" | "failed";
  operationId: string | null;
  clientId: string | null;
  deviceLabel: string | null;
  stage: "routes" | "stops" | "radar" | null;
  processed: number;
  total: number;
  startedAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  expiresAt: number;
  revision: number;
  message: string | null;
};

const DOC_PATH = "update-status-v2";
const LEASE_MS = 4 * 60_000;

function ref() {
  return db().collection("config").doc(DOC_PATH);
}

export function normalizeUpdateStatus(data: any = {}): SharedUpdateStatus {
  const now = Date.now();
  const expired = data.status === "running" && Number(data.expiresAt || 0) <= now;
  return {
    status: expired ? "failed" : data.status || "idle",
    operationId: expired ? null : data.operationId || null,
    clientId: expired ? null : data.clientId || null,
    deviceLabel: expired ? null : data.deviceLabel || null,
    stage: expired ? null : data.stage || null,
    processed: Number(data.processed || 0),
    total: Number(data.total || 0),
    startedAt: data.startedAt ? Number(data.startedAt) : null,
    updatedAt: data.updatedAt ? Number(data.updatedAt) : null,
    completedAt: data.completedAt ? Number(data.completedAt) : null,
    expiresAt: expired ? 0 : Number(data.expiresAt || 0),
    revision: Number(data.revision || 0),
    message: expired ? "A atualização anterior perdeu conexão e foi liberada." : data.message || null,
  };
}

export async function getUpdateStatus(): Promise<SharedUpdateStatus> {
  const snapshot = await ref().get();
  return normalizeUpdateStatus(snapshot.data());
}

export async function startUpdate(params: {
  operationId: string;
  clientId?: string;
  deviceLabel?: string;
  stage?: "routes" | "stops" | "radar";
  total?: number;
}): Promise<{ acquired: boolean; state: SharedUpdateStatus }> {
  const now = Date.now();
  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref());
    const current = normalizeUpdateStatus(snapshot.data());
    if (current.status === "running" && current.expiresAt > now) {
      return { acquired: false, state: current };
    }
    const next: SharedUpdateStatus = {
      status: "running",
      operationId: params.operationId,
      clientId: params.clientId || null,
      deviceLabel: params.deviceLabel || "outro dispositivo",
      stage: params.stage || "routes",
      processed: 0,
      total: Number(params.total || 0),
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      expiresAt: now + LEASE_MS,
      revision: current.revision,
      message: "Atualização iniciada.",
    };
    transaction.set(ref(), next);
    return { acquired: true, state: next };
  });
}

export async function touchUpdate(
  operationId: string,
  patch: Partial<Pick<SharedUpdateStatus, "stage" | "processed" | "total" | "message">>
): Promise<SharedUpdateStatus | null> {
  const now = Date.now();
  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref());
    const current = normalizeUpdateStatus(snapshot.data());
    if (current.status !== "running" || current.operationId !== operationId) return null;
    const next = { ...current, ...patch, updatedAt: now, expiresAt: now + LEASE_MS };
    transaction.set(ref(), next);
    return next;
  });
}

export async function finishUpdate(operationId: string, message = "Atualização concluída.") {
  const now = Date.now();
  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref());
    const current = normalizeUpdateStatus(snapshot.data());
    if (current.operationId !== operationId) return current;
    const next: SharedUpdateStatus = {
      ...current,
      status: "completed",
      operationId: null,
      stage: null,
      processed: current.total || current.processed,
      updatedAt: now,
      completedAt: now,
      expiresAt: 0,
      revision: current.revision + 1,
      message,
    };
    transaction.set(ref(), next);
    return next;
  });
}

export async function failUpdate(operationId: string, message: string) {
  const now = Date.now();
  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref());
    const current = normalizeUpdateStatus(snapshot.data());
    if (current.operationId !== operationId) return current;
    const next: SharedUpdateStatus = {
      ...current,
      status: "failed",
      operationId: null,
      stage: null,
      updatedAt: now,
      completedAt: now,
      expiresAt: 0,
      message,
    };
    transaction.set(ref(), next);
    return next;
  });
}
