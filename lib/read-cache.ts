import { auth } from './firebase';
import type { Access } from './model';

// Tab-memory only. No decrypted data or keys are persisted to browser storage.
const entries = new Map<string, { expires: number; value: Promise<unknown> }>();
const identity = () => JSON.stringify([auth?.currentUser?.uid, auth?.currentUser?.email, auth?.currentUser?.emailVerified]);
let account = identity();
export function clearReadCache() {
  entries.clear(); account = identity();
  // Retire the previous five-minute browser cache. New loads use packed server records.
  try { sessionStorage.removeItem('wigs:encrypted-class:v1'); } catch { /* Storage may be disabled. */ }
}
function prefix(access: Access) {
  if (account !== identity()) clearReadCache();
  return JSON.stringify([auth?.currentUser?.uid, access.ownerId, access.role]) + ':';
}
export function invalidateReads(access: Access, name: string) {
  const start = prefix(access) + name;
  for (const key of entries.keys()) if (key.startsWith(start)) entries.delete(key);
}
export function patchCachedRead<T>(access: Access, name: string, update: (old: T) => T) {
  const key = prefix(access) + name;
  const previous = entries.get(key);
  if (!previous) return;
  const value = previous.value.then(old => update(old as T));
  const entry = { expires: previous.expires, value };
  entries.set(key, entry);
  void value.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
}
export function cachedRead<T>(access: Access, name: string, load: () => Promise<T>, ttl = Infinity): Promise<T> {
  const key = prefix(access) + name;
  const old = entries.get(key);
  if (old && old.expires > Date.now()) return old.value as Promise<T>;
  const value = load();
  const entry = { expires: Date.now() + ttl, value };
  // History browsing must never evict the packed class or encryption key.
  if (entries.size >= 500) {
    const historyKey = [...entries.keys()].find(candidate => candidate.includes(':history:'));
    if (historyKey) entries.delete(historyKey);
  }
  entries.set(key, entry);
  void value.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return value;
}
