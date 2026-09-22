# Correção de impacto por ponto e conclusão da varredura

## Sellers / Places

O cálculo agora reconcilia todas as visitas do mesmo seller/place antes de determinar preparado, coletado e pendente.

Quando o mesmo conjunto de pacotes aparece em uma rota cancelada e em outra rota que realizou a coleta, o restante não é contado duas vezes. No caso validado do C32:

- rota coletada: 1.946 preparados, 1.945 coletados e 1 restante;
- rota cancelada: 1.828 preparados repetidos;
- resultado consolidado: 1 pacote pendente, com 1.828 sobrepostos reconciliados.

Uma visita ainda aberta continua preservando seu próprio restante, para que pacotes preparados depois de uma coleta anterior não sejam escondidos.

O mesmo reconciliador foi aplicado ao Radar operacional.

## Histórico preservado no Sellers AM

- A atualização direta pela API mescla a resposta atual com as rotas confirmadas em `data/stops` e com o histórico já salvo.
- Uma rota finalizada que deixou de aparecer na API não apaga cluster, última rota, horário nem coleta confirmada.
- Se a mesma rota reaparecer, seus valores são atualizados sem duplicação.
- O Diagnóstico informa a coleta real e a pendência real depois de conciliar visitas sobrepostas.
- O fechamento operacional mostra o cluster e a transportadora com maior impacto real, pacotes não coletados, percentual coletado, percentual da meta de 93% e falta em pacotes para atingir a meta.

## Varredura 370/375

A consolidação do Radar foi retirada do último lote de rotas e agora acontece em uma chamada separada depois que a varredura chega a 375/375. Assim, um timeout na consolidação não faz o lote 370–375 ser processado repetidamente.

Também foram adicionados:

- espera orientada pelo tempo restante do lock V2;
- mensagem e retomada explícita na posição salva;
- continuação sem buscar novamente a lista de rotas;
- tratamento de falha de conexão com liberação do estado visual;
- texto **Varrendo paradas...** durante a etapa correta;
- reconstrução separada do Radar após reescaneamento individual.

## Limite de 1 MiB do Firestore

- As paradas da V2 são persistidas em documentos de até 350 registros, com um manifesto em `data/stops-v2`.
- A leitura migra automaticamente do documento legado `data/stops` para os blocos V2, sem exigir limpeza ou troca de Firebase.
- Campos opcionais vazios são removidos para reduzir o tamanho.
- `data/stops` continua sendo atualizado no formato legado enquanto couber com margem segura; se atingir o limite, a V2 continua pelos blocos sem interromper a varredura e o último documento válido da V1 é preservado.

## Testes

- cenário real do C32;
- visita única sem sobreposição;
- coleta recuperada em outra rota;
- nova visita aberta com pacotes posteriores;
- métricas desconhecidas preservadas como `null`;
- testes existentes do Radar, monitoramento, sessão e segurança.
- preservação de rota finalizada, cluster e coleta quando a API omite o histórico.
