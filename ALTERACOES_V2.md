# Alterações implementadas na V2

O produto passa a se chamar **PULSE — Pickup Unified Logistics Surveillance & Execution**, com nova identidade visual, favicon e assinatura `dev by Jr Araujo`.

## Funcionalidades

- A aba **Ocorrências** foi substituída por **Radar operacional**.
- A base do Radar é recalculada automaticamente ao concluir a varredura de rotas e também no reescaneamento individual.
- Entram automaticamente pontos com pendência maior que zero e sem cobertura posterior após:
  - ocorrência;
  - cancelamento;
  - coleta parcial;
  - finalização sem coleta;
  - status de falha/inconclusivo.
- O Radar mantém registros resolvidos durante o dia e apresenta:
  - Reatribuir;
  - 2ª Visita;
  - Coletando;
  - Coletado;
  - Revisar;
  - Perdido;
  - Ignorado.
- O status automático é preservado quando existe override manual.
- Ações em massa: atualização via API, marcar perdido, ignorar e voltar ao automático.
- Filtros por status, cluster, motivo, tipo e busca por nome/ID.
- Seleção, cópia de IDs e atualização apenas dos selecionados.
- Detalhamento com evidências, reconciliação do card, visitas e alertas.
- Mesma consulta e fallback de ID para Sellers AM e Radar.
- Sellers / Places agora possui cards e filtro por cluster, com KPIs recalculados pelo recorte.
- A tabela de Sellers / Places mostra cluster atual e histórico de clusters.

## Correções técnicas

- Corrigido o cursor da varredura, que podia pular rotas porque a lista filtrada diminuía entre lotes.
- Remoção de paradas de rotas que não existem mais na lista atual.
- Lease transacional em `config/scan-lock-v2` para impedir duas varreduras V2 simultâneas sem bloquear a V1.
- Reescaneamento individual também reconstrói o Radar.
- Reset diário limpa Radar e lease.
- Funções pesadas configuradas para runtime Node e duração máxima de 60 segundos no Vercel.
- Pipeline de CI incluído em `.github/workflows/ci.yml`.
- Next.js atualizado da linha 14 antiga para `15.5.24`, com React `19.2.4`, mantendo o projeto em uma linha corrigida e suportada.
- Autenticação migrada para token HMAC assinado; a senha não fica mais no cookie do navegador.
- Cookie operacional do Mercado Livre criptografado em `config/session-v2`, com leitura compatível do `config/session` legado sem sobrescrevê-lo.
- **Salvar sessão** agora valida e grava somente a sessão; a atualização de rotas depende exclusivamente do clique em **Atualizar rotas**.
- Estados visuais separados para salvar sessão, atualizar rotas e zerar o painel, eliminando o falso “Buscando rotas...” durante o salvamento.
- Rotas que acabaram de mudar para `close` recebem uma última leitura antes de serem ignoradas.
- Métricas ausentes permanecem `null` e entram como `Revisar`, em vez de serem convertidas silenciosamente em zero.
- Sellers AM passa a usar `coletadoCard` separado da coleta confirmada pelas rotas ao corrigir atraso do card.
- Sellers AM preserva o histórico da varredura quando a API deixa de devolver uma rota finalizada, mantendo cluster, última rota e coleta confirmada.
- Diagnóstico explica coletas confirmadas em outra rota e a pendência real depois de remover sobreposições entre visitas.
- Diagnóstico reúne oito cards de fechamento em uma única visão: cluster de maior impacto, transportadoras de maior impacto proporcional e bruto, ponto de maior impacto, rotas no-show/canceladas, pontos sem cobertura, pacotes recuperados em outra rota e clusters abaixo da meta.
- Paradas da V2 passam a ser armazenadas em blocos para não ultrapassar o limite de 1 MiB por documento do Firestore, mantendo compatibilidade legada sempre que o documento compartilhado couber.
- Radar operacional também passa a usar armazenamento fragmentado e respostas pequenas no recálculo, eliminando falhas por documento ou resposta excessiva.
- Sellers / Places ganha seletor explícito para ordenar o impacto do maior para o menor ou do menor para o maior.
- O ranking de transportadoras do fechamento passa a usar impacto proporcional entre operações com volume relevante, mantendo o total absoluto como contexto.
- Sellers AM remove indicadores técnicos da tabela e apresenta identificação, atualização e rotas de forma mais limpa.
- Visão Geral e Clusters passam a exibir métricas reconciliadas por ponto, evitando que atribuições duplicadas reapareçam nessas telas.
- Clusters e Transportadoras deixam de ocupar itens separados no menu e passam a ser dois detalhamentos dentro de Visão Geral.
- Radar ganha filtro mínimo de impacto (10, 20, 50, 100, 200 ou 500 pacotes) e a atualização via API passa a consultar somente o recorte visível.

## Novos arquivos principais

```text
components/RadarTab.tsx
lib/radar.ts
lib/sellerMonitoring.ts
lib/auth.ts
lib/sessionStore.ts
app/api/radar/route.ts
app/api/radar-sync/route.ts
scripts/test-radar.cjs
scripts/test-security.cjs
.github/workflows/ci.yml
```

## Validações executadas neste pacote

### Correção de reconciliação e varredura

- Sellers / Places e Radar reconciliam pacotes repetidos entre rotas do mesmo ponto.
- Coleta confirmada em uma visita abate a atribuição duplicada de uma rota cancelada.
- Visitas ainda abertas preservam pacotes preparados depois de uma coleta anterior.
- O Radar é consolidado depois do lote final, evitando repetição na posição 370/375.
- A retomada usa o cursor atual sem buscar novamente a lista de rotas.

- Checagem TypeScript com declarações locais de validação: aprovada.
- Testes do motor do Radar: 11 cenários aprovados.
- Testes do monitoramento compartilhado e fallback regional: 6 cenários aprovados.
- Testes de segurança do token assinado e da criptografia: aprovados.
- O `npm install` não concluiu neste ambiente por indisponibilidade de acesso ao registro npm; por isso o build real do Next.js deverá ser confirmado pelo GitHub Actions/Vercel após o upload.
