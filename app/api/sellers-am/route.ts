import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { db } from "@/lib/firebaseAdmin";

// A partir do schema monitoramento-seller-import-v2: os campos de resumo
// (estimado/preparado/coletado/restante/impacto) vêm PRONTOS do extrator e
// nunca são recalculados aqui somando linhas de rota — um seller pode ter a
// mesma rota em mais de uma parada, então somar rotas geraria número errado.
// null é um valor válido (campo não lido) e nunca é convertido pra 0.
type SellerAm = {
  id: string;
  name: string;
  horario?: string;
  tipo?: string;
  estimado: number | null;
  preparado: number | null;
  coletado: number | null;
  restante?: number | null;
  impacto?: number | null;
  impactoNaoCalculado?: boolean;
  // Coleção consolidada por identidade de rota. Cada item pode trazer, além
  // dos campos antigos, um array "ocorrenciasDetalhadas" com cada passagem
  // real daquela rota — guardado como veio, sem colapsar em uma linha só.
  rotas: any[];
  resumoFonte?: string;
  resumoBruto?: string;
  cardsInvestigados?: number;
  cardsComDados?: number;
  cardsDetalhe?: number;
  falhaFechamento?: boolean;
  qualidade?: string;
  avisos?: string[];
  temConflitos?: boolean;
  statusOverride?: string;
  updatedAt: number;
};

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const doc = await db().collection("data").doc("sellers-am").get();
  const data = doc.data() || { sellers: {}, updatedAt: null };
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticatedRequest(req))) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { action, payload } = body;

  const ref = db().collection("data").doc("sellers-am");
  const current = (await ref.get()).data() || { sellers: {} };
  const sellers: Record<string, SellerAm> = current.sellers || {};

  if (action === "reset") {
    await ref.set({ sellers: {}, updatedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true });
  }

  if (action === "import-base") {
    const rows: Array<{ id: string; name: string; horario?: string; tipo?: string; estimado: number }> = payload || [];
    for (const row of rows) {
      if (!row.id) continue;
      if (sellers[row.id]) {
        sellers[row.id].name = row.name || sellers[row.id].name;
        sellers[row.id].horario = row.horario ?? sellers[row.id].horario;
        sellers[row.id].tipo = row.tipo ?? sellers[row.id].tipo;
        sellers[row.id].estimado = row.estimado ?? sellers[row.id].estimado;
      } else {
        sellers[row.id] = {
          id: row.id,
          name: row.name || row.id,
          horario: row.horario || "",
          tipo: row.tipo || "",
          estimado: row.estimado || 0,
          preparado: 0,
          coletado: 0,
          rotas: [],
          updatedAt: Date.now(),
        };
      }
    }
    await ref.set({ sellers, updatedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true, count: rows.length });
  }

  if (action === "import-json") {
    // Schema v2: arquivo pode vir como array direto (formato atual) ou dentro
    // de { resultados: [...], totais: {...} } (formato com metadados de lote).
    const raw = payload;
    const rows: Array<any> = Array.isArray(raw) ? raw : raw?.resultados || [];
    const totaisDeclarados = Array.isArray(raw) ? null : raw?.totais || null;

    let matched = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!row.id || !sellers[row.id]) {
        skipped++;
        continue;
      }
      matched++;
      const s = sellers[row.id];

      // Campos de resumo: usa exatamente o que veio do extrator, sem derivar
      // de soma de rotas. Preserva null (campo não lido) — nunca vira 0.
      if (row.estimado !== undefined) s.estimado = row.estimado;
      if (row.preparado !== undefined) s.preparado = row.preparado;
      if (row.coletado !== undefined) s.coletado = row.coletado;
      if (row.restante !== undefined) s.restante = row.restante;
      // NÃO usa row.nome pra sobrescrever o nome — esse campo vem com lixo do
      // script (texto do card, não o nome do lugar). Mas se o nome atual (de
      // uma importação antiga, antes desse ajuste) também tiver cara de lixo,
      // recupera o nome de verdade escondido na 2ª linha do resumoBruto.
      const nomeAtualPareceLixo =
        !s.name || /pacotes\s*coletados|EDPU\s*hoy|paquetes\s*(estimados|preparados)|Backlog/i.test(s.name);
      if (nomeAtualPareceLixo && typeof row.resumoBruto === "string") {
        const linhas = row.resumoBruto.split("\n").map((l: string) => l.trim());
        if (linhas[0] === row.id && linhas[1]) s.name = linhas[1];
      }
      if (row.tipo) s.tipo = row.tipo;

      // Impacto: usa o valor já calculado pelo extrator (regra: preparado -
      // coletado). Se preparado ou coletado vier null, marca como não
      // calculado em vez de fabricar um impacto falso a partir de 0.
      const preparadoNulo = row.preparado === null;
      const coletadoNulo = row.coletado === null;
      if (preparadoNulo || coletadoNulo) {
        s.impacto = null;
        s.impactoNaoCalculado = true;
      } else if (row.impacto !== undefined && row.impacto !== null) {
        s.impacto = row.impacto;
        s.impactoNaoCalculado = false;
      } else if (typeof row.preparado === "number" && typeof row.coletado === "number") {
        s.impacto = row.preparado - row.coletado;
        s.impactoNaoCalculado = false;
      }

      // Rotas: guarda a coleção consolidada como veio — 1 entrada por
      // identidade de rota, cada uma podendo trazer ocorrenciasDetalhadas
      // (cada passagem real) sem colapsar em uma linha só. Zero é válido,
      // null significa "não lido" — nada disso é reescrito aqui.
      if (Array.isArray(row.rotas)) s.rotas = row.rotas;

      // Metadados extras — aceitos sem rejeitar o registro.
      if (row.resumoFonte !== undefined) s.resumoFonte = row.resumoFonte;
      if (row.resumoBruto !== undefined) s.resumoBruto = row.resumoBruto;
      if (row.cardsInvestigados !== undefined) s.cardsInvestigados = row.cardsInvestigados;
      if (row.cardsComDados !== undefined) s.cardsComDados = row.cardsComDados;
      if (row.cardsDetalhe !== undefined) s.cardsDetalhe = row.cardsDetalhe;
      // falhaFechamento:true NÃO significa ausência de dado — só que o
      // fechamento visual do card não foi confirmado. Não exclui o seller.
      if (row.falhaFechamento !== undefined) s.falhaFechamento = row.falhaFechamento;
      if (row.qualidade !== undefined) s.qualidade = row.qualidade;
      if (row.avisos !== undefined) s.avisos = row.avisos;
      s.temConflitos = (s.rotas || []).some((rt: any) => Array.isArray(rt.conflitos) && rt.conflitos.length > 0);

      s.updatedAt = Date.now();
    }

    // Validação: sellers importados + falhas + não processados deve fechar
    // com a quantidade de IDs únicos recebidos, quando o lote informa totais.
    let validacao: any = null;
    if (totaisDeclarados) {
      const somaEsperada =
        (totaisDeclarados.importados || 0) + (totaisDeclarados.falhas || 0) + (totaisDeclarados.naoProcessados || 0);
      validacao = {
        idsRecebidos: totaisDeclarados.idsRecebidos,
        somaCalculada: somaEsperada,
        bate: somaEsperada === totaisDeclarados.idsRecebidos,
      };
    }

    await ref.set({ sellers, updatedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true, matched, skipped, totalLinhas: rows.length, validacao });
  }

  if (action === "update") {
    const { id, field, value } = payload || {};
    if (!id || !sellers[id]) return NextResponse.json({ error: "Seller não encontrado." }, { status: 404 });
    const s = sellers[id];
    if (field === "status") {
      s.statusOverride = value;
    } else if (field === "estimado" || field === "preparado" || field === "coletado") {
      (s as any)[field] = Number(value) || 0;
    }
    s.updatedAt = Date.now();
    await ref.set({ sellers, updatedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true });
  }

  if (action === "delete") {
    const { id, ids } = payload || {};
    if (id) delete sellers[id];
    if (Array.isArray(ids)) {
      for (const i of ids) delete sellers[i];
    }
    await ref.set({ sellers, updatedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true, count: (Array.isArray(ids) ? ids.length : 0) + (id ? 1 : 0) });
  }

  return NextResponse.json({ error: "Ação desconhecida." }, { status: 400 });
}
