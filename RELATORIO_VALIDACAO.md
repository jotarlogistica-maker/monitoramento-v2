# Relatório de validação — Painel de Monitoramento V2

Data da preparação: 21/09/2026

## Escopo entregue neste pacote

Esta entrega é uma V2 funcional construída sobre o projeto existente, preservando compatibilidade com os documentos atuais do Firestore e com o fluxo de deploy GitHub → Vercel.

Inclui:

- substituição da aba Ocorrências pelo Radar Operacional;
- geração automática da base do Radar ao concluir a varredura de rotas;
- detecção de ocorrência, cancelamento, coleta parcial, finalização sem coleta e visita inconclusiva;
- acompanhamento de Reatribuir, 2ª Visita, Coletando, Coletado, Revisar, Perdido e Ignorado;
- atualização de IDs via API com a mesma normalização/fallback regional da Sellers AM;
- filtros, cards, seleção, ações em massa, histórico, evidências e reconciliação;
- visão Sellers / Places por cluster com KPIs recalculados;
- correções de cursor, rotas antigas, leitura final de rota fechada e concorrência da varredura;
- autenticação por token assinado e criptografia do cookie operacional;
- CI para typecheck, testes e build.

## Validações executadas

### Checagem estática TypeScript

Aprovada usando o compilador TypeScript disponível no ambiente e declarações locais mínimas para React, Next.js e Firebase Admin.

Essa checagem valida sintaxe, imports internos, tipos do código da aplicação e consistência estrutural. Ela não substitui o typecheck definitivo com as dependências reais instaladas.

### Testes automatizados

Aprovados:

- motor do Radar: 11 cenários;
- monitoramento compartilhado/fallback regional: 6 cenários;
- token HMAC e criptografia AES-GCM: aprovados.

Cenários cobertos incluem:

- ocorrência sem cobertura;
- cancelamento;
- falha/inconclusivo;
- coleta parcial;
- segunda visita;
- recuperação concluída;
- pacote preparado após visita concluída;
- visita concluída seguida por outra cobertura ativa;
- métrica desconhecida preservada como `null`/Revisar;
- descarte de parada de rota antiga;
- preservação de override manual;
- descarte de rota de outra regional;
- fallback de ID normalizado para ID cru;
- rota atribuída ainda sem nome;
- rejeição de token alterado ou expirado;
- rejeição de chave de criptografia incorreta.

## Validação que depende do GitHub/Vercel

O registro npm não estava acessível neste ambiente (`EAI_AGAIN registry.npmjs.org`). Por isso não foi possível executar aqui:

- `npm install`;
- o typecheck com os pacotes reais;
- `next build`.

O workflow `.github/workflows/ci.yml` executará essas três validações ao subir o projeto. O Vercel também fará o build real no deployment de Preview/Production.

O pacote não contém `node_modules`, `.next` nem arquivos gerados. Também não contém `package-lock.json`, pois ele não pôde ser gerado sem acesso ao registro. Depois do primeiro `npm install` em um ambiente conectado, é recomendável versionar o lockfile gerado.

## Dependências principais definidas

- Next.js `15.5.24`;
- React e React DOM `19.2.4`;
- Firebase Admin `12.3.1`;
- TypeScript `5.5.4`;
- Node.js `>=20.9.0`.

## Variáveis obrigatórias no Vercel

- `FIREBASE_PROJECT_ID`;
- `FIREBASE_CLIENT_EMAIL`;
- `FIREBASE_PRIVATE_KEY`;
- `APP_PASSWORD`.

Também deve ser configurada uma `SESSION_ENCRYPTION_KEY` longa, exclusiva e estável. Se ela for alterada, o cookie operacional do Mercado Livre deverá ser salvo novamente.

## Roteiro de smoke test após o primeiro deployment

1. Abrir o deployment e fazer login novamente.
2. Salvar um cookie válido do Mercado Livre.
3. Clicar em **Atualizar rotas** e aguardar a varredura chegar ao final.
4. Abrir **Radar operacional** e conferir rota de origem, motivo, status e pendência.
5. Executar **Atualizar todos via API**.
6. Comparar manualmente alguns IDs com o Logistics.
7. Validar os estados Reatribuir, 2ª Visita e Coletado em exemplos conhecidos.
8. Abrir **Sellers / Places**, selecionar um cluster e confirmar que KPIs, Top 5 e tabela mudam juntos.
9. Testar um override e depois usar **Voltar ao automático**.
10. Executar o reset somente em ambiente de teste ou no início real de um novo dia.

## Limites conscientes desta primeira entrega

- A estrutura legada de grandes documentos no Firestore foi mantida para evitar migração destrutiva no primeiro teste.
- `app/page.tsx` ainda concentra parte importante do painel legado. O Radar foi isolado em componente e serviços próprios, mas a modularização completa permanece como evolução posterior.
- Esta entrega implementa o núcleo operacional solicitado. Não representa ainda toda a reescrita greenfield descrita no plano de longo prazo.
- O primeiro deployment deve ser feito como Preview antes de promover para produção.
