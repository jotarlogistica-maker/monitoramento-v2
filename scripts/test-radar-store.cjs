const fs = require("fs");
const ts = require("typescript");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const source = fs.readFileSync("lib/radarStore.ts", "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleObject = { exports: {} };
new Function("module", "exports", "Buffer", output)(moduleObject, moduleObject.exports, Buffer);
const { splitRadarItems } = moduleObject.exports;

const items = Object.fromEntries(
  Array.from({ length: 205 }, (_, index) => [`seller-${index}`, { id: `seller-${index}`, pendingOperational: index }])
);
const chunks = splitRadarItems(items, 80);
assert(chunks.length === 3, "205 itens devem ser divididos em três documentos");
assert(Object.keys(chunks[0]).length === 80, "primeiro bloco deve respeitar o limite configurado");
assert(Object.keys(chunks[2]).length === 45, "último bloco deve conter todos os itens restantes");
assert(Object.values(chunks).reduce((sum, chunk) => sum + Object.keys(chunk).length, 0) === 205, "nenhum item pode ser perdido");
assert(chunks[2]["seller-204"].pendingOperational === 204, "conteúdo do item deve ser preservado");

console.log("Armazenamento fragmentado do Radar: 5 cenários aprovados.");
