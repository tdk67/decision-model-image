import type { ProviderId, SavedCredential } from "./types";

const DB_NAME = "traffic-sign-categorizer-byok";
const DB_VERSION = 1;
const STORE_NAME = "credentials";

function openCredentialDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB"));
  });
}

export async function loadSavedKeys(): Promise<Partial<Record<ProviderId, SavedCredential>>> {
  if (typeof indexedDB === "undefined") return {};
  const db = await openCredentialDb();
  try {
    const result: Partial<Record<ProviderId, SavedCredential>> = {};
    for (const provider of ["gemini", "jev"] as const) {
      const cred = await new Promise<SavedCredential | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(provider);
        req.onsuccess = () => resolve(req.result as SavedCredential | undefined);
        req.onerror = () => reject(req.error ?? new Error("Failed to read IndexedDB"));
      });
      if (cred) result[provider] = cred;
    }
    return result;
  } finally {
    db.close();
  }
}

export async function saveValidatedKey(record: SavedCredential): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openCredentialDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record, record.provider);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to write IndexedDB"));
    });
  } finally {
    db.close();
  }
}

export async function clearSavedKey(provider: ProviderId): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openCredentialDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(provider);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to clear IndexedDB"));
    });
  } finally {
    db.close();
  }
}
