export type OperationalImpactGroup = {
  nome: string;
  pendente: number;
  preparado: number;
  coletado: number;
  pontos: number;
  taxaColeta: number;
  percentualDaMeta: number;
  faltaParaMeta: number;
  taxaImpacto?: number;
  volumeMinimoComparacao?: number;
};

export type RouteClosingSummary = {
  routeName?: string | null;
  totalStops?: number | null;
  successfulStops?: number | null;
  failedStops?: number | null;
  collectedPackages?: number | null;
};

/**
 * Uma rota cancelada/no-show operacional é uma rota programada, nunca uma
 * avulsa, que terminou sem coletar pacote algum e com todas as paradas em
 * insucesso. O cluster no nome identifica a programação regular da rota.
 */
export function isScheduledCancelledRoute(route: RouteClosingSummary): boolean {
  const routeName = String(route.routeName || "").trim();
  const isAdHoc = /avulsa|spot|não planejada|nao planejada/i.test(routeName);
  const isScheduled = routeName.split("_").some((part) => /^C\d+$/i.test(part));
  const totalStops = Number(route.totalStops || 0);
  const successfulStops = Number(route.successfulStops || 0);
  const failedStops = Number(route.failedStops || 0);
  const collectedPackages = Number(route.collectedPackages || 0);

  return (
    isScheduled &&
    !isAdHoc &&
    totalStops > 0 &&
    collectedPackages === 0 &&
    successfulStops === 0 &&
    failedStops >= totalStops
  );
}

/** Consolida pontos já reconciliados e devolve o grupo com mais pacotes pendentes. */
export function buildLargestImpactGroup<T>(
  rows: T[],
  keyOf: (row: T) => string,
  getMetrics: (row: T) => { pendente?: number; preparado?: number; coletado?: number },
  metaOperacional = 0.93
): OperationalImpactGroup | null {
  const groups = new Map<string, Omit<OperationalImpactGroup, "taxaColeta" | "percentualDaMeta" | "faltaParaMeta">>();
  rows.forEach((row) => {
    const nome = keyOf(row) || "Sem identificação";
    const metrics = getMetrics(row);
    const current = groups.get(nome) || { nome, pendente: 0, preparado: 0, coletado: 0, pontos: 0 };
    current.pendente += metrics.pendente || 0;
    current.preparado += metrics.preparado || 0;
    current.coletado += metrics.coletado || 0;
    current.pontos += 1;
    groups.set(nome, current);
  });

  const result = [...groups.values()].sort((a, b) => b.pendente - a.pendente)[0] || null;
  if (!result) return null;
  const taxaColeta = result.preparado > 0 ? (result.coletado / result.preparado) * 100 : 0;
  return {
    ...result,
    taxaColeta,
    percentualDaMeta: metaOperacional > 0 ? taxaColeta / (metaOperacional * 100) * 100 : 0,
    faltaParaMeta: Math.max(Math.ceil(result.preparado * metaOperacional) - result.coletado, 0),
  };
}

/**
 * Compara proporcionalmente apenas grupos com volume relevante. Isso impede
 * tanto o maior operador de ganhar só pelo tamanho quanto uma operação mínima
 * de ganhar por ter poucos pacotes e uma taxa ruim.
 */
export function buildHighestProportionalImpactGroup<T>(
  rows: T[],
  keyOf: (row: T) => string,
  getMetrics: (row: T) => { pendente?: number; preparado?: number; coletado?: number },
  metaOperacional = 0.93
): OperationalImpactGroup | null {
  const groups = new Map<string, { nome: string; pendente: number; preparado: number; coletado: number; pontos: number }>();
  rows.forEach((row) => {
    const nome = keyOf(row) || "Sem identificação";
    const metrics = getMetrics(row);
    const current = groups.get(nome) || { nome, pendente: 0, preparado: 0, coletado: 0, pontos: 0 };
    current.pendente += metrics.pendente || 0;
    current.preparado += metrics.preparado || 0;
    current.coletado += metrics.coletado || 0;
    current.pontos += 1;
    groups.set(nome, current);
  });

  const all = [...groups.values()];
  const totalPrepared = all.reduce((sum, group) => sum + group.preparado, 0);
  const volumeMinimoComparacao = Math.max(500, Math.ceil(totalPrepared * 0.01));
  const relevant = all.filter((group) => group.preparado >= volumeMinimoComparacao);
  const candidates = relevant.length > 0 ? relevant : all;
  const result = candidates.sort((a, b) => {
    const rateA = a.preparado > 0 ? a.pendente / a.preparado : 0;
    const rateB = b.preparado > 0 ? b.pendente / b.preparado : 0;
    return rateB - rateA || b.pendente - a.pendente;
  })[0];
  if (!result) return null;

  const taxaColeta = result.preparado > 0 ? (result.coletado / result.preparado) * 100 : 0;
  const taxaImpacto = result.preparado > 0 ? (result.pendente / result.preparado) * 100 : 0;
  return {
    ...result,
    taxaColeta,
    taxaImpacto,
    volumeMinimoComparacao,
    percentualDaMeta: metaOperacional > 0 ? taxaColeta / (metaOperacional * 100) * 100 : 0,
    faltaParaMeta: Math.max(Math.ceil(result.preparado * metaOperacional) - result.coletado, 0),
  };
}
