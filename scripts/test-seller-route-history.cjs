const fs = require("fs");
const ts = require("typescript");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = fs.readFileSync("lib/sellerRouteHistory.ts", "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleObject = { exports: {} };
new Function("module", "exports", output)(moduleObject, moduleObject.exports);
const { mergeSellerRouteHistory, chooseOperationalRoute, clusterFromRoute } = moduleObject.exports;

const scanned = [
  {
    routeId: 42,
    rota: "BRRJ02_C32_DED_42",
    status: "Coletado",
    preparadosRota: 1946,
    coletadosRota: 1945,
    restantesRota: 1,
    timeFromRaw: 100,
  },
];

const retained = mergeSellerRouteHistory([], scanned, []);
assert(retained.length === 1, "rota finalizada da varredura deve permanecer quando a API a omitir");
assert(retained[0].rota === "BRRJ02_C32_DED_42", "nome histórico da rota deve ser preservado");
assert(retained[0].coletadosRota === 1945, "coleta confirmada não pode voltar a zero");
assert(clusterFromRoute(chooseOperationalRoute(retained)) === "C32", "cluster deve vir da rota preservada");

const refreshed = mergeSellerRouteHistory(retained, [], [
  { routeId: 42, status: "Coletado", coletadosRota: 1946, restantesRota: 0 },
]);
assert(refreshed.length === 1, "mesma rota não pode ser duplicada ao reaparecer na API");
assert(refreshed[0].rota === "BRRJ02_C32_DED_42", "API sem nome não pode apagar nome da varredura");
assert(refreshed[0].coletadosRota === 1946, "API atual deve atualizar métricas da mesma rota");

const withSecondVisit = mergeSellerRouteHistory(retained, [], [
  { routeId: 49, rota: "BRRJ02_C32_DED_49", status: "Sem Início", preparadosRota: 1, coletadosRota: 0, restantesRota: 1, intervalo: "17:00" },
]);
assert(withSecondVisit.length === 2, "uma segunda visita deve ser acrescentada ao histórico");
assert(chooseOperationalRoute(withSecondVisit).routeId === 49, "rota operacional aberta deve ser mostrada como última rota");

console.log("Histórico de rotas do Sellers AM: 11 cenários aprovados.");
