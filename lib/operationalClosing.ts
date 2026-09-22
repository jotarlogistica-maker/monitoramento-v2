export type OperationalImpactGroup = {
  nome: string;
  pendente: number;
  preparado: number;
  coletado: number;
  pontos: number;
  taxaColeta: number;
  percentualDaMeta: number;
  faltaParaMeta: number;
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
