const fs = require("fs");
const ts = require("typescript");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = fs.readFileSync("lib/pointMetrics.ts", "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleObject = { exports: {} };
new Function("module", "exports", "require", js)(moduleObject, moduleObject.exports, require);
const { reconcileVisitPackages } = moduleObject.exports;

const c32 = reconcileVisitPackages([
  { prepared: 1946, collected: 1945, remaining: 1 },
  { prepared: 1828, collected: 0, remaining: 1828 },
]);
assert(c32.prepared === 1946, "C32 não deve somar o preparado duplicado da rota cancelada");
assert(c32.collected === 1945, "C32 deve preservar a coleta confirmada na outra rota");
assert(c32.pending === 1, "C32 deve manter somente o pacote realmente pendente");
assert(c32.overlapRemoved === 1828, "C32 deve informar a sobreposição removida");

const single = reconcileVisitPackages([{ prepared: 100, collected: 70, remaining: 30 }]);
assert(single.pending === 30 && single.overlapRemoved === 0, "uma única visita deve manter o cálculo normal");

const recovered = reconcileVisitPackages([
  { prepared: 100, collected: 20, remaining: 80 },
  { prepared: 80, collected: 80, remaining: 0 },
]);
assert(recovered.pending === 0, "coleta em outra rota deve cobrir o restante reatribuído");

const newActiveVisit = reconcileVisitPackages([
  { prepared: 100, collected: 100, remaining: 0 },
  { prepared: 15, collected: 0, remaining: 15, preserveRemaining: true },
]);
assert(newActiveVisit.pending === 15, "visita ainda aberta deve preservar pacotes preparados após coleta anterior");

const unknown = reconcileVisitPackages([{ prepared: null, collected: null, remaining: null }]);
assert(unknown.pending === null, "métrica desconhecida não pode virar zero");

console.log("Reconciliação Sellers/Places: 5 cenários aprovados.");
