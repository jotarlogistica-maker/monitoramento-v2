const fs = require("fs");
const ts = require("typescript");

function loadTypeScriptModule(path, transforms = []) {
  let source = fs.readFileSync(path, "utf8");
  for (const transform of transforms) source = transform(source);
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleObject = { exports: {} };
  new Function("module", "exports", "require", "process", output)(moduleObject, moduleObject.exports, require, process);
  return moduleObject.exports;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  process.env.APP_PASSWORD = "senha-de-teste-segura";
  delete process.env.SESSION_ENCRYPTION_KEY;

  const auth = loadTypeScriptModule("lib/auth.ts");
  const token = await auth.createAuthToken(1_000_000);
  assert(await auth.verifyAuthToken(token, 1_000_001), "token recém-criado deveria ser válido");
  assert(!(await auth.verifyAuthToken(`${token}x`, 1_000_001)), "assinatura alterada deveria ser rejeitada");
  assert(!(await auth.verifyAuthToken(token, 1_000_000 + auth.AUTH_MAX_AGE_SECONDS * 1000 + 1)), "token expirado deveria ser rejeitado");
  assert(auth.matchesAppPassword("senha-de-teste-segura"), "senha correta deveria ser aceita");
  assert(!auth.matchesAppPassword("senha-errada"), "senha errada deveria ser rejeitada");

  const session = loadTypeScriptModule("lib/sessionStore.ts", [
    (source) => source.replace('import { db } from "@/lib/firebaseAdmin";\n', ""),
  ]);
  const original = "ssid=abc123; session=valor-sensivel";
  const encrypted = await session.encryptMlCookieValue(original);
  assert(encrypted.data !== original, "cookie não pode permanecer em texto puro");
  assert(await session.decryptMlCookieValue(encrypted) === original, "cookie criptografado deveria ser recuperado");
  assert(
    (await session.readMlCookieFromDocument({ cookieEncryptedV2: encrypted })) === original,
    "formato definitivo V2 deveria ser lido"
  );
  assert(
    (await session.readMlCookieFromDocument({ encryptedCookie: encrypted })) === original,
    "formato criptografado dos primeiros deploys V2 deveria continuar legível"
  );
  assert(
    (await session.readMlCookieFromDocument({ cookie: "  cookie-legado=ok  " })) === "cookie-legado=ok",
    "cookie legado em texto puro deveria continuar legível"
  );

  process.env.SESSION_ENCRYPTION_KEY = "outra-chave";
  let wrongKeyRejected = false;
  try {
    await session.decryptMlCookieValue(encrypted);
  } catch {
    wrongKeyRejected = true;
  }
  assert(wrongKeyRejected, "chave diferente deveria rejeitar a sessão criptografada");
  assert(
    (await session.readMlCookieFromDocument({ encryptedCookie: encrypted, cookie: "cookie-legado=atual" })) ===
      "cookie-legado=atual",
    "texto puro legado deveria servir de fallback se uma chave V2 antiga não puder ser aberta"
  );

  console.log("Segurança: sessão assinada, formatos legados e cookie V2 criptografado aprovados.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
