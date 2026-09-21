# Correção para Firestore compartilhado entre V1 e V2

Esta versão foi preparada para V1 e V2 usarem o mesmo projeto Firebase/Firestore sem alterar as credenciais e sem separar os dados operacionais compartilhados.

## Sessão do Mercado Livre

- A V1 mantém `config/session` sob seu controle.
- A V2 grava sua sessão criptografada somente em `config/session-v2`, no campo `cookieEncryptedV2`.
- A leitura da V2 aceita, nesta ordem: `config/session-v2.cookieEncryptedV2`, os campos criptografados usados pelos primeiros deploys V2 e `config/session.cookie` em texto puro.
- Salvar uma sessão faz uma validação leve na API do Mercado Livre antes da gravação.
- Essa ação não escreve em `data/routes`, `data/stops`, `data/radar-operacional` ou qualquer outro documento de negócio.

## Atualização de rotas

- A atualização continua compartilhando `data/routes`, `data/stops` e os demais documentos operacionais.
- Ela só começa pelo clique explícito no botão **Atualizar rotas**.
- O lock da V2 é `config/scan-lock-v2`; `config/scan-lock` permanece livre para a V1.

## Estado da interface

Salvar sessão, atualizar rotas e zerar o painel agora possuem estados independentes. Por isso, salvar uma sessão mostra **Validando e salvando...** no botão correto e nunca troca o botão de atualização para **Buscando rotas...**.

## Validação

- TypeScript sem erros.
- 11 cenários do Radar aprovados.
- 6 cenários do monitoramento compartilhado aprovados.
- Testes de criptografia e compatibilidade de sessão aprovados.
- Teste estrutural de acionamento explícito e lock V2 aprovado.
- Build de produção do Next.js aprovado.
