import { doc } from 'firebase/firestore';
import { getDoc, runTransaction } from './firestore-activity';
import { auth, requireDb } from './firebase';
import { importKey, toBase64 } from './encryption';
import type { Access } from './model';
import { cachedRead } from './read-cache';

export const keyReference = (access: Access, studentId?: string) => doc(requireDb(), 'classes', access.ownerId, 'keys', studentId ? `student_${studentId}` : 'shared');

// Keys are immutable, loaded only into memory, and protected by Firestore rules.
// Never regenerate a missing key for records which are already encrypted.
export async function classKey(access: Access, studentId?: string, allowCreate = false): Promise<CryptoKey> {
  return cachedRead(access, 'key:' + (studentId ?? 'shared'), () => fetchKey(access, studentId, allowCreate), Infinity);
}
async function fetchKey(access: Access, studentId?: string, allowCreate = false): Promise<CryptoKey> {
  const ref = keyReference(access, studentId);
  let stored = (await getDoc(ref)).data();
  if (!stored && allowCreate && access.role === 'teacher' && access.ownerId === auth?.currentUser?.uid) {
    const keyMaterial = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    stored = await runTransaction(requireDb(), async tx => {
      const current = await tx.get(ref);
      if (current.exists()) return current.data();
      const next = { version: 1, keyMaterial };
      tx.set(ref, next);
      return next;
    });
  }
  if (!stored || stored.version !== 1 || typeof stored.keyMaterial !== 'string') throw new Error('The encryption key is unavailable. Ask your teacher to open the updated app. No data was changed.');
  return importKey(stored.keyMaterial);
}
