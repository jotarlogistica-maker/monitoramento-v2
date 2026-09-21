# Alterações implementadas na V2

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
- Lease transacional no Firestore para impedir duas varreduras simultâneas.
- Reescaneamento individual também reconstrói o Radar.
- Reset diário limpa Radar e lease.
- Funções pesadas configuradas para runtime Node e duração máxima de 60 segundos no Vercel.
- Pipeline de CI incluído em `.github/workflows/ci.yml`.
- Next.js atualizado da linha 14 antiga para `15.5.24`, com React `19.2.4`, mantendo o projeto em uma linha corrigida e suportada.
- Autenticação migrada para token HMAC assinado; a senha não fica mais no cookie do navegador.
- Cookie operacional do Mercado Livre criptografado no Firestore, com leitura compatível do formato legado.
- Rotas que acabaram de mudar para `close` recebem uma última leitura antes de serem ignoradas.
- Métricas ausentes permanecem `null` e entram como `Revisar`, em vez de serem convertidas silenciosamente em zero.
- Sellers AM passa a usar `coletadoCard` separado da coleta confirmada pelas rotas ao corrigir atraso do card.

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

- Checagem TypeScript com declarações locais de validação: aprovada.
- Testes do motor do Radar: 11 cenários aprovados.
- Testes do monitoramento compartilhado e fallback regional: 6 cenários aprovados.
- Testes de segurança do token assinado e da criptografia: aprovados.
- O `npm install` não concluiu neste ambiente por indisponibilidade de acesso ao registro npm; por isso o build real do Next.js deverá ser confirmado pelo GitHub Actions/Vercel após o upload.
