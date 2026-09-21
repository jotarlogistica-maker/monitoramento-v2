import { fetchCustomerOrders, fetchSellerSummary, normalizeId, SellerOrder, SellerSummary } from "@/lib/mlApi";

export const MONITORED_FACILITY_PREFIX = "BRRJ02";

export type SellerMonitoringResult = {
  rawId: string;
  normalizedId: string;
  referenceType: "seller" | "place";
  summary: SellerSummary | null;
  orders: SellerOrder[];
  facilityOrders: SellerOrder[];
  usedRawId: boolean;
  discardedOtherFacilityRoutes: boolean;
};

export function belongsToMonitoredFacility(order: Pick<SellerOrder, "routeName">): boolean {
  const name = (order.routeName || "").trim().toUpperCase();
  // Uma rota ainda sem nome normalmente está criada, mas ainda sem veículo.
  // Mantemos esse registro para não ocultar uma segunda visita já atribuída.
  if (!name) return true;
  return name.startsWith(MONITORED_FACILITY_PREFIX);
}

export function filterFacilityOrders(orders: SellerOrder[]): SellerOrder[] {
  return orders.filter(belongsToMonitoredFacility);
}

/**
 * Consulta um seller/place usando exatamente o mesmo fallback operacional em
 * todas as telas: ID normalizado primeiro e ID cru quando a normalização colide
 * com um cliente de outra regional.
 */
export async function fetchSellerMonitoring(
  rawIdInput: string,
  explicitType: "seller" | "place" | undefined,
  cookie: string
): Promise<SellerMonitoringResult> {
  const rawId = String(rawIdInput || "").trim();
  const normalized = normalizeId(rawId);
  const referenceType = explicitType || normalized.type;

  let summary = await fetchSellerSummary(normalized.normalized, referenceType, cookie);
  let summaryUsedRawId = false;
  if (!summary && rawId !== normalized.normalized) {
    try {
      summary = await fetchSellerSummary(rawId, referenceType, cookie);
      summaryUsedRawId = !!summary;
    } catch {
      summary = null;
    }
  }
  if (!summary) {
    return {
      rawId,
      normalizedId: normalized.normalized,
      referenceType,
      summary: null,
      orders: [],
      facilityOrders: [],
      usedRawId: false,
      discardedOtherFacilityRoutes: false,
    };
  }

  const orders = await fetchCustomerOrders(summary.customerId, cookie);
  const facilityOrders = filterFacilityOrders(orders);
  if (facilityOrders.length > 0 || rawId === normalized.normalized || summaryUsedRawId) {
    return {
      rawId,
      normalizedId: normalized.normalized,
      referenceType,
      summary,
      orders,
      facilityOrders,
      usedRawId: summaryUsedRawId,
      discardedOtherFacilityRoutes: orders.length > facilityOrders.length,
    };
  }

  // O ID normalizado não trouxe nenhuma rota da BRRJ02. Tenta o ID cru; isso
  // resolve colisões em que o número normalizado pertence a outro cliente.
  try {
    const rawSummary = await fetchSellerSummary(rawId, referenceType, cookie);
    if (rawSummary) {
      const rawOrders = await fetchCustomerOrders(rawSummary.customerId, cookie);
      const rawFacilityOrders = filterFacilityOrders(rawOrders);
      if (rawFacilityOrders.length > 0) {
        return {
          rawId,
          normalizedId: normalized.normalized,
          referenceType,
          summary: rawSummary,
          orders: rawOrders,
          facilityOrders: rawFacilityOrders,
          usedRawId: true,
          discardedOtherFacilityRoutes: rawOrders.length > rawFacilityOrders.length,
        };
      }
    }
  } catch {
    // A API pode rejeitar o ID cru. O resultado normalizado continua útil para
    // diagnóstico, mas será marcado para revisão quando não houver rota local.
  }

  return {
    rawId,
    normalizedId: normalized.normalized,
    referenceType,
    summary,
    orders,
    facilityOrders,
    usedRawId: false,
    discardedOtherFacilityRoutes: orders.length > facilityOrders.length,
  };
}
