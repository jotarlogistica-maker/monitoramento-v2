import { db } from "@/lib/firebaseAdmin";

export type EncryptedValue = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  data: string;
};

export type SessionDocument = {
  cookie?: string;
  cookieEncryptedV2?: EncryptedValue;
  encryptedCookie?: EncryptedValue;
  savedAt?: string;
  storageVersion?: number;
  metadata?: {
    storageVersion?: number;
    savedAt?: string;
    owner?: string;
  };
};

export const ML_SESSION_LEGACY_DOCUMENT = "session";
export const ML_SESSION_V2_DOCUMENT = "session-v2";

function encryptionSecret(): string {
  const secret = process.env.SESSION_ENCRYPTION_KEY || process.env.APP_PASSWORD;
  if (!secret) {
    throw new Error("Defina APP_PASSWORD ou SESSION_ENCRYPTION_KEY para proteger a sessão do Mercado Livre.");
  }
  return secret;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function encryptionKey(): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(encryptionSecret()));
  return globalThis.crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptMlCookieValue(value: string): Promise<EncryptedValue> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(value);
  const ciphertext = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), encoded);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptMlCookieValue(value: EncryptedValue): Promise<string> {
  if (value.version !== 1 || value.algorithm !== "aes-256-gcm") {
    throw new Error("Formato de sessão criptografada não suportado.");
  }
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(value.iv) },
    await encryptionKey(),
    base64ToBytes(value.data)
  );
  return new TextDecoder().decode(plaintext);
}

export async function readMlCookieFromDocument(data: SessionDocument | undefined): Promise<string | null> {
  if (!data) return null;

  // `cookieEncryptedV2` é o nome definitivo. `encryptedCookie` mantém leitura
  // compatível com os primeiros deploys da V2, que gravavam no documento
  // legado antes de a convivência com a V1 ser isolada.
  const encrypted = data.cookieEncryptedV2 || data.encryptedCookie;
  if (encrypted) {
    try {
      return await decryptMlCookieValue(encrypted);
    } catch (error) {
      // Se V1 e um deploy V2 antigo deixaram campos lado a lado no mesmo
      // documento, a sessão legada ainda pode ser válida após uma troca da
      // chave V2. Só propagamos a falha se não houver fallback em texto puro.
      if (!(typeof data.cookie === "string" && data.cookie.trim())) throw error;
    }
  }

  // A V1 continua podendo manter o cookie em texto puro em config/session.
  // A V2 apenas lê esse campo; nunca o remove nem regrava esse documento.
  return typeof data.cookie === "string" && data.cookie.trim() ? data.cookie.trim() : null;
}

export async function saveMlCookie(cookie: string): Promise<void> {
  const savedAt = new Date().toISOString();
  await db().collection("config").doc(ML_SESSION_V2_DOCUMENT).set({
    cookieEncryptedV2: await encryptMlCookieValue(cookie),
    storageVersion: 2,
    savedAt,
    metadata: {
      storageVersion: 2,
      savedAt,
      owner: "monitoramento-v2",
    },
  });
}

export async function getMlCookie(): Promise<string | null> {
  const config = db().collection("config");
  const [v2Snapshot, legacySnapshot] = await Promise.all([
    config.doc(ML_SESSION_V2_DOCUMENT).get(),
    config.doc(ML_SESSION_LEGACY_DOCUMENT).get(),
  ]);

  let decryptionError: unknown = null;
  for (const snapshot of [v2Snapshot, legacySnapshot]) {
    try {
      const cookie = await readMlCookieFromDocument((snapshot.data() || {}) as SessionDocument);
      if (cookie) return cookie;
    } catch (error) {
      decryptionError = error;
    }
  }

  if (decryptionError) {
    throw new Error("Não foi possível abrir a sessão V2 salva. Salve novamente o cookie do Mercado Livre.");
  }
  return null;
}
