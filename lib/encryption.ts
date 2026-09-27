// No keys are bundled with the site. Each vault key is generated using Web Crypto.
export type EncryptedRecord = { version: 1; iv: string; ciphertext: string };
const encoder = new TextEncoder();
export function toBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
export async function importKey(value: string): Promise<CryptoKey> {
  const raw = fromBase64(value);
  if (raw.length !== 32) throw new Error('The encryption key is invalid. No data was changed.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export function isEncrypted(value: Record<string, unknown>): boolean {
  // A damaged or unsupported envelope must fail closed, never be treated as legacy plaintext.
  return 'ciphertext' in value || 'iv' in value || 'version' in value;
}
export async function encryptRecord(value: unknown, key: CryptoKey, path: string): Promise<EncryptedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`wigstracker:v1:${path}`), tagLength: 128 }, key, encoder.encode(JSON.stringify(value)));
  const ciphertext = toBase64(new Uint8Array(bytes));
  if (ciphertext.length > 950000) throw new Error('This record is too large to save. Use fewer or smaller pictures.');
  return { version: 1, iv: toBase64(iv), ciphertext };
}
export async function decryptRecord<T>(value: Record<string, unknown>, key: CryptoKey, path: string): Promise<T> {
  try {
    if (value.version !== 1 || typeof value.iv !== 'string' || typeof value.ciphertext !== 'string') throw new Error();
    const iv = fromBase64(value.iv);
    if (iv.length !== 12) throw new Error();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`wigstracker:v1:${path}`), tagLength: 128 }, key, fromBase64(value.ciphertext));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as T;
  } catch {
    throw new Error('This record could not be decrypted. No replacement data was saved. Contact your teacher.');
  }
}
// Used only to delete retired email assignment records; never for sign-in.
export async function emailLookup(email: string): Promise<string> {
  if (!email.trim()) return '';
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(email.trim().toLowerCase()));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
