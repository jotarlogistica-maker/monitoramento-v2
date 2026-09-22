export type SellerRouteHistory = {
  rota?: string;
  routeId?: number;
  intervalo?: string;
  status?: string;
  statusRaw?: string;
  preparadosRota?: number | null;
  coletadosRota?: number | null;
  restantesRota?: number | null;
  carrierName?: string;
  driverName?: string;
  timeFromRaw?: number | null;
  timeToRaw?: number | null;
  seenInLatestApi?: boolean;
  fonteHistorico?: "varredura" | "api" | "salvo";
  [key: string]: unknown;
};

function normalizedRouteName(route: SellerRouteHistory): string {
  return String(route.rota || "").trim().toUpperCase();
}

function isUsefulRouteName(name: string): boolean {
  return !!name && !/^ROTA ID:/i.test(name);
}

function mergeDefined(base: SellerRouteHistory, incoming: SellerRouteHistory): SellerRouteHistory {
  const merged = { ...base };
  Object.entries(incoming).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") merged[key] = value;
  });
  return merged;
}

function findSameRouteIndex(routes: SellerRouteHistory[], incoming: SellerRouteHistory): number {
  const routeId = Number(incoming.routeId || 0);
  if (routeId > 0) {
    const byId = routes.findIndex((route) => Number(route.routeId || 0) === routeId);
    if (byId >= 0) return byId;
  }

  const name = normalizedRouteName(incoming);
  if (isUsefulRouteName(name)) {
    return routes.findIndex((route) => normalizedRouteName(route) === name);
  }
  return -1;
}

/**
 * Une o histórico salvo, a evidência da última varredura e a resposta atual da
 * API. A API pode parar de devolver uma rota quando ela é finalizada; por isso
 * ela atualiza os campos conhecidos, mas nunca apaga uma passagem confirmada.
 */
export function mergeSellerRouteHistory(
  saved: SellerRouteHistory[] = [],
  scanned: SellerRouteHistory[] = [],
  api: SellerRouteHistory[] = []
): SellerRouteHistory[] {
  const routes: SellerRouteHistory[] = [];

  const upsert = (incoming: SellerRouteHistory) => {
    if (!incoming || (!incoming.rota && !incoming.routeId)) return;
    const index = findSameRouteIndex(routes, incoming);
    if (index >= 0) routes[index] = mergeDefined(routes[index], incoming);
    else routes.push({ ...incoming });
  };

  saved.forEach((route) => upsert({ ...route, seenInLatestApi: false, fonteHistorico: route.fonteHistorico || "salvo" }));
  scanned.forEach((route) => upsert({ ...route, seenInLatestApi: false, fonteHistorico: "varredura" }));
  api.forEach((route) => upsert({ ...route, seenInLatestApi: true, fonteHistorico: "api" }));

  return routes;
}

function routeOrderValue(route: SellerRouteHistory, index: number): number {
  const timestamp = Number(route.timeFromRaw || 0);
  if (timestamp > 0) {
    const date = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
    return date.getHours() * 60 + date.getMinutes() + index / 10_000;
  }
  const hour = String(route.intervalo || "").match(/(\d{1,2}):(\d{2})/);
  if (hour) return Number(hour[1]) * 60 + Number(hour[2]) + index / 10_000;
  return index;
}

export function isOperationallyOpenRoute(route: SellerRouteHistory): boolean {
  const status = `${route.status || ""} ${route.statusRaw || ""}`.toLowerCase();
  return (
    status.includes("sem in") ||
    status.includes("não inic") ||
    status.includes("nao inic") ||
    status.includes("aguard") ||
    status.includes("pending") ||
    status.includes("planned") ||
    status.includes("assigned") ||
    status.includes("progress") ||
    status.includes("started")
  );
}

export function chooseOperationalRoute(routes: SellerRouteHistory[] = []): SellerRouteHistory | null {
  const named = routes
    .map((route, index) => ({ route, order: routeOrderValue(route, index) }))
    .filter(({ route }) => isUsefulRouteName(normalizedRouteName(route)));
  if (named.length === 0) return routes[routes.length - 1] || null;

  const open = named.filter(({ route }) => isOperationallyOpenRoute(route));
  return [...(open.length > 0 ? open : named)].sort((a, b) => a.order - b.order).at(-1)?.route || null;
}

export function clusterFromRoute(route: SellerRouteHistory | null | undefined): string {
  const match = String(route?.rota || "").match(/_C(\d+)(?:_|$)/i);
  return match ? `C${match[1].padStart(2, "0")}` : "—";
}
