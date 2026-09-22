import type { RadarDocument, RadarItem } from "@/lib/radar";

const DATA_COLLECTION = "data";
const LEGACY_DOCUMENT = "radar-operacional";
const MANIFEST_DOCUMENT = "radar-operacional-v2";
const CHUNK_PREFIX = "radar-operacional-v2-chunk-";
const ITEMS_PER_CHUNK = 80;
const LEGACY_SAFE_JSON_BYTES = 850_000;

function chunkDocument(index: number): string {
  return `${CHUNK_PREFIX}${String(index).padStart(4, "0")}`;
}

export function splitRadarItems(items: Record<string, RadarItem>, size = ITEMS_PER_CHUNK): Array<Record<string, RadarItem>> {
  const entries = Object.entries(items);
  const chunks: Array<Record<string, RadarItem>> = [];
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(Object.fromEntries(entries.slice(index, index + size)));
  }
  return chunks;
}

export async function readRadarDocument(firestore: any): Promise<RadarDocument> {
  const data = firestore.collection(DATA_COLLECTION);
  const manifestSnapshot = await data.doc(MANIFEST_DOCUMENT).get();
  const manifest = manifestSnapshot.data() || {};
  const chunkCount = Number(manifest.chunkCount || 0);
  if (manifest.version === 2 && chunkCount >= 0) {
    const snapshots = await Promise.all(
      Array.from({ length: chunkCount }, (_, index) => data.doc(chunkDocument(index)).get())
    );
    const items: Record<string, RadarItem> = {};
    snapshots.forEach((snapshot) => Object.assign(items, snapshot.data()?.items || {}));
    return {
      items,
      updatedAt: manifest.updatedAt || null,
      sourceStopsUpdatedAt: manifest.sourceStopsUpdatedAt || null,
    };
  }

  const legacySnapshot = await data.doc(LEGACY_DOCUMENT).get();
  const legacy = legacySnapshot.data() || {};
  return {
    items: legacy.items || {},
    updatedAt: legacy.updatedAt || null,
    sourceStopsUpdatedAt: legacy.sourceStopsUpdatedAt || null,
  };
}

function isDocumentSizeError(error: any): boolean {
  const text = `${error?.code || ""} ${error?.message || error || ""}`.toLowerCase();
  return text.includes("invalid-argument") || text.includes("maximum allowed size") || text.includes("exceeds the maximum");
}

export async function writeRadarDocument(firestore: any, document: RadarDocument): Promise<void> {
  const data = firestore.collection(DATA_COLLECTION);
  const chunks = splitRadarItems(document.items || {});
  const previousManifest = await data.doc(MANIFEST_DOCUMENT).get();
  const previousChunkCount = Number(previousManifest.data()?.chunkCount || 0);

  await Promise.all(
    chunks.map((items, index) => data.doc(chunkDocument(index)).set({ version: 2, index, items, updatedAt: document.updatedAt }))
  );
  await data.doc(MANIFEST_DOCUMENT).set({
    version: 2,
    chunkCount: chunks.length,
    totalItems: Object.keys(document.items || {}).length,
    updatedAt: document.updatedAt || null,
    sourceStopsUpdatedAt: document.sourceStopsUpdatedAt || null,
  });

  if (previousChunkCount > chunks.length) {
    await Promise.all(
      Array.from({ length: previousChunkCount - chunks.length }, (_, offset) =>
        data.doc(chunkDocument(chunks.length + offset)).delete()
      )
    );
  }

  const approximateBytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  if (approximateBytes <= LEGACY_SAFE_JSON_BYTES) {
    try {
      await data.doc(LEGACY_DOCUMENT).set(document);
    } catch (error: any) {
      if (!isDocumentSizeError(error)) throw error;
    }
  }
}

export async function clearRadarDocument(firestore: any): Promise<void> {
  const data = firestore.collection(DATA_COLLECTION);
  const manifest = await data.doc(MANIFEST_DOCUMENT).get();
  const chunkCount = Number(manifest.data()?.chunkCount || 0);
  await Promise.all([
    ...Array.from({ length: chunkCount }, (_, index) => data.doc(chunkDocument(index)).delete()),
    data.doc(MANIFEST_DOCUMENT).set({ version: 2, chunkCount: 0, totalItems: 0, updatedAt: null, sourceStopsUpdatedAt: null }),
    data.doc(LEGACY_DOCUMENT).set({ items: {}, updatedAt: null, sourceStopsUpdatedAt: null }),
  ]);
}
