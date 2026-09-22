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
