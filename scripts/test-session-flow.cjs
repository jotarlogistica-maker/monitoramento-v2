const fs = require("fs");

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sessionStore = read("lib/sessionStore.ts");
const saveRoute = read("app/api/save-session/route.ts");
const page = read("app/page.tsx");
const refreshStops = read("app/api/refresh-stops/route.ts");
const radarSync = read("app/api/radar-sync/route.ts");
const resetDay = read("app/api/reset-day/route.ts");

assert(sessionStore.includes('ML_SESSION_LEGACY_DOCUMENT = "session"'), "documento legado deve continuar declarado");
assert(sessionStore.includes('ML_SESSION_V2_DOCUMENT = "session-v2"'), "sessão V2 deve usar documento próprio");
assert(sessionStore.includes("cookieEncryptedV2"), "sessão V2 deve usar campo criptografado versionado");
assert(
  !sessionStore.includes("doc(ML_SESSION_LEGACY_DOCUMENT).set"),
  "a V2 não pode sobrescrever config/session"
);

const validateAt = saveRoute.indexOf("fetchEstimatedDataSummary");
const saveAt = saveRoute.indexOf("saveMlCookie(normalizedCookie)");
assert(validateAt >= 0 && saveAt > validateAt, "a sessão deve ser validada antes de ser salva");
assert(!saveRoute.includes('fetch("/api/refresh"'), "salvar sessão não pode atualizar rotas");

const saveFunction = page.slice(page.indexOf("async function saveSession()"), page.indexOf("const [puLive"));
assert(saveFunction.includes("setSavingSession(true)"), "salvar sessão deve ter estado visual próprio");
assert(!saveFunction.includes("setRefreshingRoutes"), "salvar sessão não pode ativar o estado de atualização de rotas");
assert(!saveFunction.includes("/api/refresh"), "salvar sessão não pode chamar a API de atualização");
assert(
  (page.match(/\brefresh\(\)/g) || []).length === 1 && page.includes("onClick={refresh}"),
  "a atualização de rotas deve ser iniciada somente pelo clique explícito"
);

for (const [name, source] of [
  ["refresh-stops", refreshStops],
  ["radar-sync", radarSync],
  ["reset-day", resetDay],
]) {
  assert(source.includes('doc("scan-lock-v2")'), `${name} deve usar o lock específico da V2`);
  assert(!source.includes('doc("scan-lock")'), `${name} não pode usar o lock legado da V1`);
}

assert(!refreshStops.includes("rebuildRadarFromFirestore"), "o lote final não pode reconstruir o Radar dentro da varredura");
assert(page.includes('body: JSON.stringify({ action: "rebuild" })'), "a interface deve consolidar o Radar após concluir os lotes");
assert(page.includes("if (lastCursor > 0)"), "a varredura interrompida deve retomar do cursor salvo");
assert(page.includes('"Varrendo paradas..."'), "a interface deve distinguir varredura de busca de rotas");

console.log("Fluxo de sessão, acionamento explícito e lock V2 aprovados.");
