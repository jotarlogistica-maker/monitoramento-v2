const fs = require("fs");
const ts = require("typescript");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadService(mocks) {
  const source = fs.readFileSync("lib/sellerMonitoring.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleObject = { exports: {} };
  const localRequire = (id) => (id === "@/lib/mlApi" ? mocks : require(id));
  new Function("module", "exports", "require", output)(moduleObject, moduleObject.exports, localRequire);
  return moduleObject.exports;
}

(async () => {
  const calls = [];
  const summaries = {
    "123": { customerId: 1, customerName: "Conta de outra regional", estimado: 10, preparado: 8, coletado: 1 },
    "BRP1239": { customerId: 2, customerName: "Seller correto", estimado: 20, preparado: 15, coletado: 5 },
    "555": { customerId: 3, customerName: "Seller local", estimado: 30, preparado: 25, coletado: 10 },
  };
  const orders = {
    1: [{ routeId: 11, routeName: "BRSP01_C01_11", status: "Sem Início", statusRaw: "pending", prepared: 8, collected: 0, remaining: 8, timeFrame: "09:00" }],
    2: [{ routeId: 22, routeName: "BRRJ02_C12_22", status: "Sem Início", statusRaw: "pending", prepared: 15, collected: 0, remaining: 15, timeFrame: "10:00" }],
    3: [{ routeId: 33, routeName: "", status: "Sem Início", statusRaw: "pending", prepared: 25, collected: 0, remaining: 25, timeFrame: "11:00" }],
  };
  const service = loadService({
    normalizeId(rawId) {
      if (rawId === "BRP1239") return { normalized: "123", type: "seller" };
      return { normalized: rawId, type: rawId.includes("_") ? "place" : "seller" };
    },
    async fetchSellerSummary(id, type) {
      calls.push(["summary", id, type]);
      return summaries[id] || null;
    },
    async fetchCustomerOrders(customerId) {
      calls.push(["orders", customerId]);
      return orders[customerId] || [];
    },
  });

  assert(service.belongsToMonitoredFacility({ routeName: "BRRJ02_C12_1" }), "rota BRRJ02 deveria ser aceita");
  assert(service.belongsToMonitoredFacility({ routeName: "" }), "rota ainda sem nome deve permanecer como cobertura atribuída");
  assert(!service.belongsToMonitoredFacility({ routeName: "BRSP01_C01_1" }), "rota de outra regional deveria ser descartada");

  const fallback = await service.fetchSellerMonitoring("BRP1239", "seller", "cookie");
  assert(fallback.usedRawId, "colisão regional deveria usar o ID cru");
  assert(fallback.summary?.customerId === 2, "fallback deveria retornar o customer correto");
  assert(fallback.facilityOrders.length === 1 && fallback.facilityOrders[0].routeId === 22, "fallback deveria preservar só a rota BRRJ02");
  assert(fallback.discardedOtherFacilityRoutes === false, "o resultado final correto não deveria herdar descarte da tentativa errada");

  const local = await service.fetchSellerMonitoring("555", "seller", "cookie");
  assert(!local.usedRawId, "ID já normalizado não deve usar fallback");
  assert(local.facilityOrders.length === 1, "rota atribuída ainda sem nome deve ser mantida");
  assert(calls.some((call) => call[0] === "summary" && call[1] === "BRP1239"), "o ID cru deveria ter sido consultado");

  console.log("Monitoramento compartilhado: 6 cenários aprovados.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
