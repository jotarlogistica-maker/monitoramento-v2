const fs = require("fs");
const ts = require("typescript");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = fs.readFileSync("lib/operationalClosing.ts", "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleObject = { exports: {} };
new Function("module", "exports", output)(moduleObject, moduleObject.exports);
const { buildLargestImpactGroup, buildHighestProportionalImpactGroup, isScheduledCancelledRoute } = moduleObject.exports;

const rows = [
  { cluster: "C32", carrier: "A", preparado: 1946, coletado: 1945, pendente: 1 },
  { cluster: "C29", carrier: "B", preparado: 1000, coletado: 800, pendente: 200 },
  { cluster: "C29", carrier: "B", preparado: 100, coletado: 50, pendente: 50 },
  { cluster: "C28", carrier: "A", preparado: 200, coletado: 100, pendente: 100 },
];
const metrics = (row) => row;

const cluster = buildLargestImpactGroup(rows, (row) => row.cluster, metrics);
assert(cluster.nome === "C29", "deve escolher o cluster pela maior pendência reconciliada");
assert(cluster.pendente === 250, "deve somar somente a pendência real dos pontos do cluster");
assert(cluster.pontos === 2, "deve contar os pontos atribuídos ao grupo");
assert(cluster.faltaParaMeta === 173, "deve calcular os pacotes necessários para chegar a 93%");

const carrier = buildLargestImpactGroup(rows, (row) => row.carrier, metrics);
assert(carrier.nome === "B" && carrier.pendente === 250, "deve escolher a transportadora de maior impacto");
assert(Math.round(carrier.taxaColeta * 10) / 10 === 77.3, "deve calcular a taxa de coleta do grupo");
assert(Math.round(carrier.percentualDaMeta * 10) / 10 === 83.1, "deve calcular quanto da meta de 93% foi alcançado");

const proportionalRows = [
  { carrier: "Kangu", preparado: 100000, coletado: 96000, pendente: 4000 },
  { carrier: "DHL", preparado: 10000, coletado: 7000, pendente: 3000 },
  { carrier: "Operação mínima", preparado: 10, coletado: 0, pendente: 10 },
];
const proportional = buildHighestProportionalImpactGroup(proportionalRows, (row) => row.carrier, metrics);
assert(proportional.nome === "DHL", "ranking proporcional não deve premiar o maior volume absoluto");
assert(proportional.taxaImpacto === 30, "impacto proporcional deve usar pendente dividido pelo preparado");
assert(proportional.nome !== "Operação mínima", "volume irrelevante não deve distorcer o fechamento");
const gross = buildLargestImpactGroup(proportionalRows, (row) => row.carrier, metrics);
assert(gross.nome === "Kangu" && gross.pendente === 4000, "ranking bruto deve destacar o maior volume pendente absoluto");

assert(
  isScheduledCancelledRoute({
    routeName: "BRRJ02_C32_DED_49",
    totalStops: 12,
    successfulStops: 0,
    failedStops: 12,
    collectedPackages: 0,
  }),
  "deve contar rota programada sem coleta e com todas as paradas em insucesso"
);
assert(
  !isScheduledCancelledRoute({
    routeName: "Rota não planejada (123)",
    totalStops: 12,
    successfulStops: 0,
    failedStops: 12,
    collectedPackages: 0,
  }),
  "não deve contar rota avulsa"
);
assert(
  !isScheduledCancelledRoute({
    routeName: "BRRJ02_C32_DED_50",
    totalStops: 12,
    successfulStops: 1,
    failedStops: 11,
    collectedPackages: 1,
  }),
  "não deve contar rota que teve qualquer coleta ou parada bem-sucedida"
);

console.log("Fechamento operacional: 14 cenários aprovados.");
