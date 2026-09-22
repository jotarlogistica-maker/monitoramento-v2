export type VisitPackageValues = {
  prepared: number | null | undefined;
  collected: number | null | undefined;
  remaining?: number | null | undefined;
  preserveRemaining?: boolean;
};

export type ReconciledPointMetrics = {
  prepared: number | null;
  collected: number | null;
  pending: number | null;
  rawRemaining: number | null;
  overlapRemoved: number;
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Reconcilia várias atribuições do mesmo seller/place.
 *
 * O mesmo conjunto de pacotes pode aparecer em duas rotas quando há
 * cancelamento ou reatribuição. Somar o restante de cada rota duplica o
 * impacto. O maior preparado observado representa o conjunto conhecido e as
 * coletas confirmadas em qualquer visita cobrem esse conjunto uma única vez.
 */
export function reconcileVisitPackages(visits: VisitPackageValues[]): ReconciledPointMetrics {
  if (visits.length === 0) {
    return { prepared: 0, collected: 0, pending: 0, rawRemaining: 0, overlapRemoved: 0 };
  }

  const allCollectedKnown = visits.every((visit) => finiteNumber(visit.collected));
  const collected = allCollectedKnown
    ? visits.reduce((sum, visit) => sum + Math.max(visit.collected as number, 0), 0)
    : null;

  const preparedCandidates = visits
    .map((visit) => {
      if (finiteNumber(visit.prepared)) return Math.max(visit.prepared, 0);
      if (finiteNumber(visit.remaining) && finiteNumber(visit.collected)) {
        return Math.max(visit.remaining, 0) + Math.max(visit.collected, 0);
      }
      return null;
    })
    .filter((value): value is number => value !== null);

  const rawRemainingKnown = visits.every(
    (visit) => finiteNumber(visit.remaining) || (finiteNumber(visit.prepared) && finiteNumber(visit.collected))
  );
  const rawRemaining = rawRemainingKnown
    ? visits.reduce((sum, visit) => {
        if (finiteNumber(visit.remaining)) return sum + Math.max(visit.remaining, 0);
        return sum + Math.max((visit.prepared as number) - (visit.collected as number), 0);
      }, 0)
    : null;

  if (collected === null || preparedCandidates.length === 0) {
    return { prepared: null, collected, pending: null, rawRemaining, overlapRemoved: 0 };
  }

  const preparedObserved = Math.max(...preparedCandidates);
  // Uma visita ainda aberta pode representar pacotes preparados depois de uma
  // coleta anterior. Nesse caso seu restante não deve ser consumido pelo
  // histórico. Visitas canceladas/finalizadas continuam reconciliadas como o
  // mesmo conjunto, evitando a duplicação observada nas reatribuições.
  const protectedRemaining = visits
    .filter((visit) => visit.preserveRemaining && finiteNumber(visit.remaining))
    .reduce((largest, visit) => Math.max(largest, Math.max(visit.remaining as number, 0)), 0);
  const pending = Math.max(preparedObserved - collected, protectedRemaining, 0);
  const prepared = collected + pending;
  const overlapRemoved = rawRemaining === null ? 0 : Math.max(rawRemaining - pending, 0);
  return { prepared, collected, pending, rawRemaining, overlapRemoved };
}
