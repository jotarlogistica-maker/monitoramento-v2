const fs = require('fs');
const ts = require('typescript');
let source = fs.readFileSync('lib/radar.ts', 'utf8');
source = source.replace('import { db } from "@/lib/firebaseAdmin";\n', '');
const metricsSource = fs.readFileSync('lib/pointMetrics.ts', 'utf8');
const metricsJs = ts.transpileModule(metricsSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const metricsModule = { exports: {} };
new Function('module', 'exports', 'require', metricsJs)(metricsModule, metricsModule.exports, require);
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const moduleObj = { exports: {} };
new Function('module', 'exports', 'require', js)(moduleObj, moduleObj.exports, (id) => {
  if (id === '@/lib/pointMetrics') return metricsModule.exports;
  if (id === '@/lib/stopsStore') return { readStopsDocument: async () => ({ stops: [], updatedAt: null }) };
  if (id === '@/lib/radarStore') return { readRadarDocument: async () => ({ items: {} }), writeRadarDocument: async () => undefined };
  return require(id);
});
const { buildRadarDocument } = moduleObj.exports;
function assert(condition, message) { if (!condition) throw new Error(message); }
const routes = [
  { id: 1, routeName: 'BRRJ02_C12_01', status: 'close', carrierName: 'T1' },
  { id: 2, routeName: 'BRRJ02_C12_02', status: 'pending', carrierName: 'T2' },
  { id: 3, routeName: 'BRRJ02_C15_03', status: 'close', carrierName: 'T3' },
];
const failed = [{ routeId: 1, routeName: 'BRRJ02_C12_01', normalizedId: '100', rawId: 'BRP1001', idType: 'seller', sellerName: 'Seller X', preparedPackages: 100, collectedPackages: 20, estimatedPackages: 100, status: 'finished', hasProblem: true, problemType: 'Sem espaço', timeFrom: 100 }];
let doc = buildRadarDocument(routes, failed, {});
assert(doc.items['100'], 'ocorrência sem cobertura deveria entrar');
assert(doc.items['100'].status === 'Reatribuir', 'status deveria ser Reatribuir');
assert(doc.items['100'].pendingOperational === 80, 'pendente deveria ser 80');
assert(doc.items['100'].estimated === 100, 'estimado deve vir do campo estimado, não do preparado');
const existing = doc.items;
const withNext = failed.concat([{ routeId: 2, routeName: 'BRRJ02_C12_02', normalizedId: '100', rawId: 'BRP1001', idType: 'seller', sellerName: 'Seller X', preparedPackages: 80, collectedPackages: 0, estimatedPackages: 80, status: 'pending', hasProblem: false, timeFrom: 200 }]);
doc = buildRadarDocument(routes, withNext, existing);
assert(doc.items['100'].status === '2ª Visita', 'nova rota pendente deveria virar 2ª Visita');
const completed = failed.concat([{ routeId: 3, routeName: 'BRRJ02_C15_03', normalizedId: '100', rawId: 'BRP1001', idType: 'seller', sellerName: 'Seller X', preparedPackages: 80, collectedPackages: 80, estimatedPackages: 80, status: 'finished', hasProblem: false, timeFrom: 300 }]);
doc = buildRadarDocument(routes, completed, doc.items);
assert(doc.items['100'].status === 'Coletado', 'segunda rota concluída sem pendente deveria virar Coletado');
const recoveredFromScratch = buildRadarDocument(routes, completed, {});
assert(recoveredFromScratch.items['100']?.status === 'Coletado', 'recuperado deve entrar como histórico para permitir reabertura via API');
const completedThenPending = completed.concat([{ routeId: 4, routeName: 'BRRJ02_C18_04', normalizedId: '100', rawId: 'BRP1001', idType: 'seller', sellerName: 'Seller X', preparedPackages: 15, collectedPackages: 0, estimatedPackages: 15, status: 'pending', hasProblem: false, timeFrom: 400 }]);
const completedThenPendingRoutes = routes.concat([{ id: 4, routeName: 'BRRJ02_C18_04', status: 'pending', carrierName: 'T4' }]);
doc = buildRadarDocument(completedThenPendingRoutes, completedThenPending, recoveredFromScratch.items);
assert(doc.items['100'].status === '2ª Visita', 'uma visita concluída não pode esconder outra visita posterior ainda ativa');
assert(doc.items['100'].nextVisit?.routeId === 4, 'o Radar deve apontar a cobertura ativa mais recente');
const apiExisting = { ...doc.items['100'], source: 'api', pendingOperational: 15, quality: 'CONFIRMADO', automaticStatus: 'Reatribuir', status: 'Reatribuir', statusOverride: null };
doc = buildRadarDocument(routes, completed, { '100': apiExisting });
assert(doc.items['100'].status === 'Reatribuir', 'pendente de API após visita concluída deve voltar para Reatribuir');

const canceled = [{ routeId: 1, routeName: 'BRRJ02_C12_01', normalizedId: '200', rawId: '200', idType: 'seller', sellerName: 'Seller Cancelado', preparedPackages: 25, collectedPackages: 0, estimatedPackages: 25, status: 'canceled', hasProblem: false, timeFrom: 100 }];
doc = buildRadarDocument([{ id: 1, routeName: 'BRRJ02_C12_01', status: 'canceled' }], canceled, {});
assert(doc.items['200']?.trigger.code === 'canceled', 'cancelamento com pendência deveria entrar no Radar');
const failedStatus = [{ routeId: 1, routeName: 'BRRJ02_C12_01', normalizedId: '300', rawId: '300', idType: 'place', sellerName: 'Place Falha', preparedPackages: 10, collectedPackages: 0, estimatedPackages: 10, status: 'failed', hasProblem: false, timeFrom: 100 }];
doc = buildRadarDocument([{ id: 1, routeName: 'BRRJ02_C12_01', status: 'open' }], failedStatus, {});
assert(doc.items['300']?.trigger.code === 'inconclusive', 'status de falha deveria entrar como visita inconclusiva');


const unknownMetrics = [{ routeId: 1, routeName: 'BRRJ02_C12_01', normalizedId: '400', rawId: '400', idType: 'seller', sellerName: 'Seller Sem Leitura', preparedPackages: null, collectedPackages: null, estimatedPackages: null, status: 'failed', hasProblem: true, problemType: 'Ocorrência sem métricas', timeFrom: 100 }];
doc = buildRadarDocument([{ id: 1, routeName: 'BRRJ02_C12_01', status: 'close' }], unknownMetrics, {});
assert(doc.items['400'], 'ocorrência sem métricas deve permanecer no Radar para revisão');
assert(doc.items['400'].status === 'Revisar', 'métrica ausente não pode ser tratada como zero');
assert(doc.items['400'].pendingOperational === null, 'pendente desconhecido deve continuar null');

const notCandidate = buildRadarDocument(routes, withNext, {});
assert(!notCandidate.items['100'], 'ponto que já nasceu com nova cobertura não deve entrar no Radar');
const staleOnly = buildRadarDocument([], failed, {});
assert(Object.keys(staleOnly.items).length === 0, 'parada de rota ausente na lista atual deve ser descartada');
const overridden = buildRadarDocument(routes, failed, { '100': { ...existing['100'], statusOverride: 'Perdido', status: 'Perdido', automaticStatus: 'Reatribuir', active: false } });
assert(overridden.items['100'].status === 'Perdido', 'override manual deve sobreviver ao recálculo automático');
console.log('Radar engine: 11 cenários aprovados.');
