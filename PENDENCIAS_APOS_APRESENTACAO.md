# Pendências após a apresentação do PULSE

1. [Concluído] Corrigir o Diagnóstico no mobile: o bloco PU LIVE está largo demais, provoca overflow e deixa a página desproporcional.
2. [Concluído] Criar estado de atualização compartilhado entre dispositivos e usuários:
   - mostrar que uma varredura está em andamento;
   - identificar início e término da atualização;
   - atualizar automaticamente todas as telas abertas quando os dados mudarem;
   - impedir ações concorrentes e conflitos de gravação.

## Entrega aplicada

- O PU LIVE agora usa grade responsiva, ocupa a largura disponível e não força rolagem horizontal.
- A atualização completa possui um bloqueio compartilhado no Firestore, além do bloqueio técnico por lote.
- Todas as sessões consultam o estado global a cada 3 segundos e quando a aba volta ao primeiro plano.
- Durante a execução, desktop e mobile exibem dispositivo, etapa e progresso.
- Ao concluir, as outras sessões recarregam rotas, paradas, Radar, Sellers AM e PU LIVE automaticamente.
- Uma segunda atualização fica bloqueada enquanto a primeira estiver ativa; operações abandonadas expiram automaticamente.
