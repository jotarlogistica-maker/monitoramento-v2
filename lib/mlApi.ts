const BASE_FM = "https://envios.adminml.com/logistics/first-mile/api/monitoring";

export type Route = {
  id: number;
  routeName: string;
  facilityId: string;
  facilityName: string;
  totalStops: number;
  pendingStops: number;
  successfulStops: number;
  failedStops: number;
  withProblemStops: number;
  estimatedPackages: number;
  collectedPackages: number;
  preparedPackages: number;
  status: string;
  vehicleType?: string;
  vehicleLicensePlate?: string;
  driverName?: string;
  carrierName?: string;
};

export type Stop = {
  routeId: number;
  routeName: string;
  address?: string;
  neighborhood?: string;
  city?: string;
  sellerName?: string;
  rawId?: string;
  normalizedId?: string;
  idType?: "seller" | "place";
  isAgent?: boolean;
  estimatedPackages?: number;
  preparedPackages?: number;
  collectedPackages?: number;
  status?: string;
  hasProblem?: boolean;
  problemType?: string;
  timeFrom?: number;
  timeTo?: number;
  lat?: number;
  lng?: number;
};

// IDs de place vêm como "849817033_100787776" (com underline) — usamos como estão.
// IDs de seller vêm em 3 formatos diferentes; aqui a gente normaliza pra sempre
// conseguir buscar pelo número "puro" que a tela de consulta espera.
export function normalizeId(rawId: string): { normalized: string; type: "seller" | "place" } {
  if (rawId.includes("_")) {
    return { normalized: rawId, type: "place" };
  }
  if (rawId.startsWith("BRP")) {
    const rest = rawId.slice(3);
    const isAllDigits = /^\d+$/.test(rest);
    // Regra geral (não depende do tamanho exato): BRP + só números -> tira o
    // último dígito. BRP + números com letra no final -> tira os últimos 4
    // caracteres. O código antigo só cobria 2 tamanhos específicos (13 e 9) e
    // mandava qualquer outro tamanho SEM cortar nada — isso causava buscas
    // erradas (achando conta de outra regional) pra IDs fora desses 2 casos.
    if (isAllDigits) return { normalized: rest.slice(0, -1), type: "seller" };
    return { normalized: rest.slice(0, -4), type: "seller" };
  }
  return { normalized: rawId, type: "seller" }; // formato 3: já vem "puro"
}

async function mlFetch(url: string, cookie: string, attempt = 1): Promise<any> {
  const res = await fetch(url, {
    headers: {
      Cookie: cookie,
      Accept: "application/json, text/plain, */*",
    },
    cache: "no-store",
  });

  if (res.status === 429 && attempt <= 4) {
    // Rate limit do ML: espera um pouco mais a cada tentativa e tenta de novo.
    const waitMs = attempt * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return mlFetch(url, cookie, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`ML respondeu ${res.status} para ${url} — a sessão pode ter expirado.`);
  }
  return res.json();
}

const BASE_ROUTE = "https://envios.adminml.com/logistics/first-mile/api/monitoring-route";

// Busca o detalhe de UMA rota (paradas com endereço, seller/place ID, pacotes).
export async function fetchRouteDetail(routeId: number, cookie: string) {
  const url = `${BASE_ROUTE}/route-detail?routeId=${routeId}`;
  const data = await mlFetch(url, cookie);

  const rawStops: any[] = (data.stops || []).filter((s: any) => s.type === "operational");

  // O ML às vezes manda um nome genérico ("Rota não planejada") em vez de vazio —
  // detecta isso e inclui o ID junto, senão fica impossível diferenciar as rotas.
  const rawName = data.displayRouteName || data.routeName || "";
  const isGenericName = !rawName || /não planejada/i.test(rawName);
  const routeName = isGenericName ? `${rawName || "Rota não planejada"} (${routeId})` : rawName;

  const stops: Stop[] = rawStops.map((s: any) => {
    const rawId = String(s.sellerId || "");
    const { normalized, type } = rawId ? normalizeId(rawId) : { normalized: "", type: "seller" as const };
    return {
      routeId,
      routeName,
      address: s.address?.address_line ?? null,
      neighborhood: s.address?.neighborhood ?? null,
      city: s.address?.city ?? null,
      sellerName: s.sellerNickname ?? null,
      rawId,
      normalizedId: normalized,
      idType: type,
      isAgent: !!s.isAgent,
      estimatedPackages: s.estimatedPackages ?? null,
      preparedPackages: s.preparedPackages ?? null,
      collectedPackages: s.collectedPackages ?? null,
      status: s.status ?? null,
      hasProblem: !!s.stopWithProblems,
      problemType:
        (typeof s.stopWithProblems === "string" && s.stopWithProblems) ||
        (typeof s.incidentType === "string" && s.incidentType) ||
        (s.stopWithProblems ? "Sem motivo detalhado" : null),
      timeFrom: s.timeFrom ?? null,
      timeTo: s.timeTo ?? null,
      lat: s.location?.lat ?? s.address?.geolocation?.latitude ?? null,
      lng: s.location?.lng ?? s.address?.geolocation?.longitude ?? null,
    };
  });

  return { stops, raw: data };
}

// Busca TODAS as rotas de uma facility, passando por todas as páginas.
// Deduplica por ID, porque a lista é ordenada por um valor que muda em tempo real
// (pacotes estimados) — sem isso, uma mesma rota pode aparecer 2x em páginas diferentes.
export async function fetchAllRoutes(facilityId: string, cookie: string): Promise<Route[]> {
  const byId = new Map<number, Route>();
  let page = 1;
  const maxPages = 40; // trava de segurança

  while (page <= maxPages) {
    const url = `${BASE_FM}/get-routes-and-stats?facility_id=${encodeURIComponent(
      facilityId
    )}&order_by=estimated_packages_asc&page=${page}`;
    const data = await mlFetch(url, cookie);
    const routes: Route[] = data.routes || [];
    for (const r of routes) byId.set(r.id, r);

    const total = data?.pagination?.totalDocuments ?? byId.size;
    if (byId.size >= total || routes.length === 0) break;
    page++;
  }

  return Array.from(byId.values());
}

// ===================== MONITORAMENTO POR SELLER (integração direta, sem script) =====================

const BASE_SELLER = "https://envios.adminml.com/logistics/first-mile/api/monitoring-seller";

export type SellerSummary = {
  customerId: number;
  customerName: string;
  estimado: number;
  preparado: number;
  coletado: number;
};

export type SellerOrder = {
  routeId: number;
  routeName: string;
  status: string;
  statusRaw: string;
  prepared: number;
  collected: number;
  remaining: number;
  timeFrame: string;
  carrierName?: string;
  driverName?: string;
};

// O status vem em inglês da API ("pending", "finished"...) — traduz pro mesmo
// vocabulário que o resto do app já usa (isAwaitingStatus/isCanceledStatus no
// front esperam "Sem Início"/"Coletado"/"Cancelado" em português). Ampliado
// pra cobrir mais variações prováveis de "ainda não começou/agendada" — a
// gente só confirmou "pending" numa captura real, pode ter mais valores.
function mapOrderStatus(raw?: string): string {
  const s = (raw || "").toLowerCase();
  if (s.includes("cancel")) return "Cancelado";
  if (s.includes("pending") || s.includes("scheduled") || s.includes("assigned") || s.includes("planned") || s.includes("not_started") || s.includes("waiting") || s.includes("created")) {
    return "Sem Início";
  }
  if (s.includes("finish") || s.includes("complet") || s.includes("success") || s.includes("collected")) return "Coletado";
  return raw || "";
}

// Busca o resumo (Estimado/Preparado/Coletado) de um seller/place pelo ID
// normalizado — mesma tela que o script (bookmarklet) usava manualmente, só
// que direto via API, sem precisar abrir card nem clicar em nada.
export async function fetchSellerSummary(
  referenceId: string,
  referenceType: "seller" | "place",
  cookie: string
): Promise<SellerSummary | null> {
  // A API espera "user" pra sellers e "place" pra places — não "seller" como a
  // gente esperava por simetria. Confirmado com captura real de uma busca de
  // seller no site (reference_type=user). O resto do app continua usando
  // "seller"/"place" como vocabulário interno; só aqui traduz pro valor certo.
  const apiReferenceType = referenceType === "seller" ? "user" : "place";
  const url = `${BASE_SELLER}/get-packages-summary/customers?size=50&order_by=estimated,desc&reference_id=${encodeURIComponent(
    referenceId
  )}&reference_type=${apiReferenceType}`;
  const data = await mlFetch(url, cookie);
  const detail = data?.details?.[0];
  if (!detail) return null;
  return {
    customerId: detail.customer_id,
    customerName: detail.customer_name,
    estimado: (detail.estimated_edpu_today || 0) + (detail.estimated_backlog || 0) + (detail.estimated_early || 0),
    preparado: (detail.prepared_edpu_today || 0) + (detail.prepared_backlog || 0) + (detail.prepared_early || 0),
    coletado: (detail.collected_edpu_today || 0) + (detail.collected_backlog || 0) + (detail.collected_early || 0),
  };
}

// Busca o detalhe por rota (pedidos) de um customer_id, pro dia de hoje —
// equivalente a "expandir o card" no site, mas via API.
export async function fetchCustomerOrders(customerId: number, cookie: string): Promise<SellerOrder[]> {
  const today = new Date().toISOString().slice(0, 10);
  const url = `${BASE_SELLER}/get-customer-orders/v2?customerId=${customerId}&date=${today}&includedPrepared=true`;
  const data = await mlFetch(url, cookie);
  const list: any[] = Array.isArray(data) ? data : [];
  return list.map((o) => ({
    routeId: o.routeId,
    routeName: o.routeName,
    status: mapOrderStatus(o.status),
    statusRaw: o.status || "",
    prepared: o.prepared ?? 0,
    collected: o.collected ?? 0,
    remaining: o.remaining ?? 0,
    timeFrame: o.timeFrame || "",
    carrierName: o.carrierName,
    driverName: o.driverName,
  }));
}

export type FacilityPackagesSummary = {
  totalSellers: number;
  totalPlaces: number;
  estimatedEdpuToday: number;
  estimatedBacklog: number;
  estimatedEarly: number;
  preparedEdpuToday: number;
  preparedBacklog: number;
  preparedEarly: number;
  collectedEdpuToday: number;
  collectedBacklog: number;
  collectedEarly: number;
};

// Resumo OFICIAL da facility inteira, com o breakdown EDPU hoje / Backlog /
// Early — chamada única, sem paginação (é o mesmo número que aparece no topo
// da tela monitoring-seller quando filtra só pela facility, sem buscar ID
// nenhum). Serve pra conferir/enriquecer a aba Diagnóstico.
export async function fetchFacilityPackagesSummary(facilityId: string, cookie: string): Promise<FacilityPackagesSummary> {
  const url = `${BASE_SELLER}/get-packages-summary?facility_ids=${encodeURIComponent(facilityId)}&order_by=estimated,desc`;
  const data = await mlFetch(url, cookie);
  return {
    totalSellers: data.totalSellers || 0,
    totalPlaces: data.totalPlaces || 0,
    estimatedEdpuToday: data.estimatedEdpuToday || 0,
    estimatedBacklog: data.estimatedBacklog || 0,
    estimatedEarly: data.estimatedEarly || 0,
    preparedEdpuToday: data.preparedEdpuToday || 0,
    preparedBacklog: data.preparedBacklog || 0,
    preparedEarly: data.preparedEarly || 0,
    collectedEdpuToday: data.collectedEdpuToday || 0,
    collectedBacklog: data.collectedBacklog || 0,
    collectedEarly: data.collectedEarly || 0,
  };
}

export type FacilityCustomer = {
  customerId: number;
  customerName: string;
  relatedEntityId: string;
  relatedEntityType: string;
  estimado: number;
  preparado: number;
  coletado: number;
  estimatedEdpuToday: number;
  estimatedBacklog: number;
  estimatedEarly: number;
  preparedEdpuToday: number;
  preparedBacklog: number;
  preparedEarly: number;
  collectedEdpuToday: number;
  collectedBacklog: number;
  collectedEarly: number;
};

// Lista os clientes (sellers/places/nodes) de uma facility em lotes de 50, com
// paginação por cursor — descoberto hoje, é o mesmo endpoint de resumo por
// seller, só que sem "reference_id" (busca todo mundo da facility, em vez de
// 1 ID só). Usado pra montar o resumo oficial "limpo" (excluindo cliente de
// outra regional que bate errado com essa facility).
export async function fetchFacilityCustomersPage(
  facilityId: string,
  cookie: string,
  cursor?: string
): Promise<{ customers: FacilityCustomer[]; nextCursor: string | null }> {
  const url = `${BASE_SELLER}/get-packages-summary/customers?size=50&facility_ids=${encodeURIComponent(
    facilityId
  )}&order_by=estimated,desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const data = await mlFetch(url, cookie);
  const details: any[] = data?.details || [];
  const customers: FacilityCustomer[] = details.map((d) => ({
    customerId: d.customer_id,
    customerName: d.customer_name,
    relatedEntityId: d.related_entity_id,
    relatedEntityType: d.customer_related_entity_type,
    estimado: (d.estimated_edpu_today || 0) + (d.estimated_backlog || 0) + (d.estimated_early || 0),
    preparado: (d.prepared_edpu_today || 0) + (d.prepared_backlog || 0) + (d.prepared_early || 0),
    coletado: (d.collected_edpu_today || 0) + (d.collected_backlog || 0) + (d.collected_early || 0),
    estimatedEdpuToday: d.estimated_edpu_today || 0,
    estimatedBacklog: d.estimated_backlog || 0,
    estimatedEarly: d.estimated_early || 0,
    preparedEdpuToday: d.prepared_edpu_today || 0,
    preparedBacklog: d.prepared_backlog || 0,
    preparedEarly: d.prepared_early || 0,
    collectedEdpuToday: d.collected_edpu_today || 0,
    collectedBacklog: d.collected_backlog || 0,
    collectedEarly: d.collected_early || 0,
  }));
  const nextCursor = data?.pagination?.next_cursor || null;
  return { customers, nextCursor: details.length === 50 ? nextCursor : null };
}

export type EstimatedDataSummary = {
  estimatedPackages: number;
  collectedPackages: number;
};

// "PU LIVE" — o mesmo card do Logistics (Pacotes estimados/Coletados, com %
// calculado na hora). Chamada única e simples, sem paginação.
export async function fetchEstimatedDataSummary(facilityId: string, cookie: string): Promise<EstimatedDataSummary> {
  const url = `https://envios.adminml.com/logistics/first-mile/api/monitoring/estimated-data-summary?facility_id=${encodeURIComponent(
    facilityId
  )}&order_by=estimated_packages_desc`;
  const data = await mlFetch(url, cookie);
  return {
    estimatedPackages: data.estimatedPackages || 0,
    collectedPackages: data.collectedPackages || 0,
  };
}
