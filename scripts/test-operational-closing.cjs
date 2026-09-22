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
const { buildLargestImpactGroup } = moduleObject.exports;

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

console.log("Fechamento operacional: 7 cenários aprovados.");
