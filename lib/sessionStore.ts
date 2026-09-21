import { db } from "@/lib/firebaseAdmin";

type EncryptedValue = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  data: string;
};

type SessionDocument = {
  cookie?: string;
  encryptedCookie?: EncryptedValue;
  savedAt?: string;
  storageVersion?: number;
};

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

export async function saveMlCookie(cookie: string): Promise<void> {
  await db().collection("config").doc("session").set({
    encryptedCookie: await encryptMlCookieValue(cookie),
    storageVersion: 2,
    savedAt: new Date().toISOString(),
  });
}

export async function getMlCookie(): Promise<string | null> {
  const snapshot = await db().collection("config").doc("session").get();
  const data = (snapshot.data() || {}) as SessionDocument;

  if (data.encryptedCookie) {
    try {
      return await decryptMlCookieValue(data.encryptedCookie);
    } catch {
      throw new Error("Não foi possível abrir a sessão salva. Salve novamente o cookie do Mercado Livre.");
    }
  }

  // Compatibilidade com instalações existentes. O próximo salvamento converte
  // automaticamente o documento antigo em armazenamento criptografado.
  return typeof data.cookie === "string" && data.cookie.trim() ? data.cookie : null;
}
