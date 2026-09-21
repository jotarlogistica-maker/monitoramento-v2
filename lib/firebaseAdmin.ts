import { getApps, initializeApp, cert, App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Estas 3 variáveis vêm do Vercel (Settings > Environment Variables),
// nunca ficam escritas aqui no código.
function getAdminApp(): App {
  if (getApps().length) return getApps()[0];

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Faltam variáveis de ambiente do Firebase (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)."
    );
  }

  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

export function db() {
  const firestore = getFirestore(getAdminApp());
  try {
    firestore.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings() só pode ser chamado uma vez; ignora se já foi configurado antes.
  }
  return firestore;
}
