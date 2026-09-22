const fs = require("fs");
const ts = require("typescript");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = fs.readFileSync("lib/stopsStore.ts", "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleObject = { exports: {} };
new Function("module", "exports", "Buffer", output)(moduleObject, moduleObject.exports, Buffer);
const { compactStop, splitStops } = moduleObject.exports;

const compacted = compactStop({
  routeId: 42,
  routeName: "BRRJ02_C32_42",
  status: "finished",
  problemType: null,
  carrierName: "",
  hasProblem: false,
  isAgent: false,
  collectedPackages: 1945,
});
assert(compacted.routeId === 42 && compacted.collectedPackages === 1945, "campos operacionais precisam ser preservados");
assert(!("problemType" in compacted), "null não deve ocupar espaço no Firestore");
assert(!("carrierName" in compacted), "texto vazio não deve ocupar espaço no Firestore");
assert(!("hasProblem" in compacted) && !("isAgent" in compacted), "flags falsas opcionais devem ser inferidas por ausência");

const chunks = splitStops(Array.from({ length: 801 }, (_, index) => ({ routeId: index })), 350);
assert(chunks.length === 3, "801 paradas devem ser divididas em três documentos");
assert(chunks[0].length === 350 && chunks[2].length === 101, "nenhuma parada pode ser perdida ao dividir");

console.log("Armazenamento fragmentado de paradas: 8 cenários aprovados.");
