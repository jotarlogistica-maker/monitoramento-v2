# PULSE — First Mile Operations · BRRJ02

**Pickup Unified Logistics Surveillance & Execution.** Aplicação Next.js para monitoramento de rotas, sellers e places de First Mile. Esta versão substitui a antiga aba de ocorrências por um **Radar Operacional** e acrescenta uma visão de impacto por cluster em **Sellers / Places**.

## Instalação no celular

O PULSE funciona como PWA e usa o mesmo endereço publicado no Vercel.

- Android/Chrome: abra o endereço, use **Instalar PULSE** quando aparecer ou escolha **Adicionar à tela inicial** no menu do navegador.
- iPhone/Safari: abra o endereço, toque em **Compartilhar** e escolha **Adicionar à Tela de Início**.
- Os dados operacionais não são armazenados para uso offline: ao abrir, o app consulta a base atual para evitar exibir números antigos.
- A sessão do Mercado Livre permanece salva no servidor; o celular precisa somente do login do PULSE.

## Principais mudanças

### Radar Operacional

O Radar é alimentado automaticamente ao clicar em **Atualizar rotas**. Um seller/place entra quando há pacotes pendentes após uma situação como:

- ocorrência do motorista;
- rota ou parada cancelada;
- coleta parcial;
- rota finalizada sem coleta;
- visita com status de falha;
- ausência de outra rota válida atribuída.

O Radar preserva o histórico do dia e acompanha os estados:

`Reatribuir → 2ª Visita → Coletando → Coletado`

Também oferece `Revisar`, `Perdido` e `Ignorado`, com distinção entre status automático e override manual.

O botão **Atualizar filtrados via API** usa o mesmo mecanismo da Sellers AM:

- identifica seller ou place;
- normaliza IDs BRP;
- tenta o ID cru quando houver colisão;
- descarta rotas de outras regionais;
- reconcilia o card com a coleta confirmada pelas rotas;
- preserva `null`/dado não calculável;
- atualiza em lotes para respeitar rate limit.

### Sellers / Places por cluster

A aba possui cards clicáveis de cluster mostrando:

- quantidade de pontos;
- pendente;
- percentual coletado;
- quantidade para reatribuir.

Ao selecionar um cluster, os KPIs, alertas, Top 5, busca, cópia de IDs e tabela são recalculados para aquele recorte. A tabela também mostra o cluster operacional e o histórico de mudança de cluster.

### Varredura mais segura

- O cursor agora percorre uma lista estável e não pula rotas após cada lote.
- Paradas de rotas que não existem mais na lista atual são removidas da consolidação.
- A trava simples foi substituída por um lease transacional com expiração.
- Reescaneamento individual também atualiza o Radar.
- O reset do dia zera Radar, rotas, paradas, snapshots e lease, sem apagar a sessão do Mercado Livre.

## Variáveis de ambiente

Copie `.env.example` e configure no Vercel:

| Variável | Descrição |
|---|---|
| `FIREBASE_PROJECT_ID` | `project_id` da conta de serviço Firebase |
| `FIREBASE_CLIENT_EMAIL` | `client_email` da conta de serviço |
| `FIREBASE_PRIVATE_KEY` | `private_key` completa, mantendo `\n` |
| `APP_PASSWORD` | Senha de acesso ao painel e chave padrão de proteção da sessão |
| `SESSION_ENCRYPTION_KEY` | Recomendada: chave exclusiva e estável para criptografar o cookie do Mercado Livre; se vazia, usa `APP_PASSWORD` |

## Publicação no GitHub e Vercel

1. Suba **todo o conteúdo desta pasta** para o repositório GitHub, mantendo a estrutura.
2. No Vercel, importe o repositório.
3. Cadastre as quatro variáveis obrigatórias e também uma `SESSION_ENCRYPTION_KEY` estável para Preview e Production.
4. Framework Preset: **Next.js**.
5. Build Command: `npm run build`.
6. Faça o deploy.

Nenhuma migração manual do Firestore é necessária. Os documentos novos são criados na primeira atualização:

```text
data/radar-operacional
config/scan-lock-v2
config/session-v2
```

Os documentos legados continuam compatíveis.


### Segurança da sessão

- O login grava um token assinado e com validade de 30 dias; a senha não fica mais armazenada no cookie do navegador.
- O cookie do Mercado Livre da V2 é salvo criptografado em `config/session-v2`.
- A V2 continua lendo `config/session.cookie` em texto puro e o antigo campo criptografado `config/session.encryptedCookie`.
- O botão **Salvar sessão** valida o cookie com uma consulta leve antes de gravá-lo; ele não atualiza rotas, paradas ou Radar.
- A V2 nunca grava em `config/session`, preservando o formato esperado pela V1.
- O lease de varredura usa `config/scan-lock-v2`, sem disputar `config/scan-lock` com a V1.
- Depois do primeiro deploy desta versão, faça login novamente porque o cookie de autenticação antigo não é reutilizado.
- Mantenha `SESSION_ENCRYPTION_KEY` estável. Se ela mudar — ou se você usa `APP_PASSWORD` como chave e alterar a senha — salve novamente o cookie do Mercado Livre.

## Primeira validação após o deploy

1. Entre com `APP_PASSWORD`.
2. Salve um cookie válido do Mercado Livre.
3. Clique em **Atualizar rotas** e aguarde a varredura terminar.
4. Abra **Radar operacional**.
5. Confirme se os candidatos detectados possuem rota de origem, motivo e pendência.
6. Clique em **Atualizar todos via API**.
7. Compare alguns IDs manualmente no Logistics.
8. Abra **Sellers / Places** e filtre um cluster pelos cards.
9. Verifique se KPIs e tabela mudam juntos.

## Comandos locais

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

`npm run check` executa typecheck, testes do motor do Radar e build.

## Observações operacionais

- A base do Radar não é importada por CSV: ela nasce da varredura.
- Qualquer pendência maior que zero pode ser acompanhada; não existe corte mínimo de 100 pacotes no Radar.
- Um item não desaparece ao receber nova rota. Ele permanece no histórico do dia para mostrar recuperação.
- `Ignorado` deve ser usado para falso positivo; excluir não seria efetivo porque o item voltaria na próxima varredura.
- O reset do dia remove o histórico operacional daquele dia.
