const DATA_COLLECTION = "data";
const LEGACY_DOCUMENT = "stops";
const MANIFEST_DOCUMENT = "stops-v2";
const CHUNK_PREFIX = "stops-v2-chunk-";
const STOPS_PER_CHUNK = 350;
const LEGACY_SAFE_JSON_BYTES = 900_000;

export type StopsDocument = {
  stops: any[];
  updatedAt: string | null;
  storage: "v2-chunks" | "legacy";
};

export function compactStop(stop: any): any {
  const compacted: Record<string, unknown> = {};
  Object.entries(stop || {}).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    if ((key === "isAgent" || key === "hasProblem") && value === false) return;
    compacted[key] = value;
  });
  return compacted;
}

export function splitStops(stops: any[], size = STOPS_PER_CHUNK): any[][] {
  const chunks: any[][] = [];
  for (let index = 0; index < stops.length; index += size) chunks.push(stops.slice(index, index + size));
  return chunks;
}

function chunkDocument(index: number): string {
  return `${CHUNK_PREFIX}${String(index).padStart(4, "0")}`;
}

export async function readStopsDocument(firestore: any): Promise<StopsDocument> {
  const data = firestore.collection(DATA_COLLECTION);
  const manifestSnapshot = await data.doc(MANIFEST_DOCUMENT).get();
  const manifest = manifestSnapshot.data() || {};
  const chunkCount = Number(manifest.chunkCount || 0);

  if (manifest.version === 2 && chunkCount >= 0) {
    const snapshots = await Promise.all(
      Array.from({ length: chunkCount }, (_, index) => data.doc(chunkDocument(index)).get())
    );
    return {
      stops: snapshots.flatMap((snapshot) => snapshot.data()?.stops || []),
      updatedAt: manifest.updatedAt || null,
      storage: "v2-chunks",
    };
  }

  const legacySnapshot = await data.doc(LEGACY_DOCUMENT).get();
  const legacy = legacySnapshot.data() || {};
  return { stops: legacy.stops || [], updatedAt: legacy.updatedAt || null, storage: "legacy" };
}

function isDocumentSizeError(error: any): boolean {
  const text = `${error?.code || ""} ${error?.message || error || ""}`.toLowerCase();
  return text.includes("invalid-argument") || text.includes("maximum allowed size") || text.includes("exceeds the maximum");
}

export async function writeStopsDocument(
  firestore: any,
  stops: any[],
  updatedAt: string
): Promise<{ legacyUpdated: boolean; chunkCount: number }> {
  const data = firestore.collection(DATA_COLLECTION);
  const compactedStops = stops.map(compactStop);
  const chunks = splitStops(compactedStops);
  const previousManifestSnapshot = await data.doc(MANIFEST_DOCUMENT).get();
  const previousChunkCount = Number(previousManifestSnapshot.data()?.chunkCount || 0);

  await Promise.all(
    chunks.map((chunk, index) => data.doc(chunkDocument(index)).set({ version: 2, index, stops: chunk, updatedAt }))
  );
  await data.doc(MANIFEST_DOCUMENT).set({
    version: 2,
    chunkCount: chunks.length,
    totalStops: compactedStops.length,
    updatedAt,
  });

  if (previousChunkCount > chunks.length) {
    await Promise.all(
      Array.from({ length: previousChunkCount - chunks.length }, (_, offset) =>
        data.doc(chunkDocument(chunks.length + offset)).delete()
      )
    );
  }

  const legacyPayload = { stops: compactedStops, updatedAt };
  const approximateBytes = Buffer.byteLength(JSON.stringify(legacyPayload), "utf8");
  let legacyUpdated = false;
  if (approximateBytes <= LEGACY_SAFE_JSON_BYTES) {
    try {
      await data.doc(LEGACY_DOCUMENT).set(legacyPayload);
      legacyUpdated = true;
    } catch (error: any) {
      if (!isDocumentSizeError(error)) throw error;
    }
  }

  return { legacyUpdated, chunkCount: chunks.length };
}

export async function clearStopsDocument(firestore: any): Promise<void> {
  const data = firestore.collection(DATA_COLLECTION);
  const manifestSnapshot = await data.doc(MANIFEST_DOCUMENT).get();
  const chunkCount = Number(manifestSnapshot.data()?.chunkCount || 0);
  await Promise.all([
    ...Array.from({ length: chunkCount }, (_, index) => data.doc(chunkDocument(index)).delete()),
    data.doc(MANIFEST_DOCUMENT).set({ version: 2, chunkCount: 0, totalStops: 0, updatedAt: null }),
    data.doc(LEGACY_DOCUMENT).set({ stops: [], updatedAt: null }),
  ]);
}
