import { doc, type DocumentReference, type Transaction } from 'firebase/firestore';
import { decryptRecord, encryptRecord, fromBase64, toBase64 } from './encryption';

// Each part stays well below Firestore's 1 MiB document limit. A class + month
// update fits within the 10 MiB transaction limit, even at the maximum size.
const PART_BYTES = 480000;
const MAX_PARTS = 4;
export type Row = { ref: DocumentReference; id: string; exists(): boolean; data(): Record<string, any> | undefined };
export type PackedRows = { head: Row; parts: Row[] };
const partRef = (ref: DocumentReference, index: number) => doc(ref, 'parts', String(index));
export function partCount(row: Row) {
  const count = row.data()?.partCount;
  if (!Number.isInteger(count) || count < 1 || count > MAX_PARTS) throw new Error('The packed record is damaged. No data was changed.');
  return count as number;
}
export async function readPacked(tx: Transaction, ref: DocumentReference): Promise<PackedRows> {
  const head = await tx.get(ref);
  if (!head.exists() || head.data()?.storage !== 2) return { head, parts: [] };
  const parts = await Promise.all(Array.from({ length: partCount(head) - 1 }, (_, index) => tx.get(partRef(ref, index + 1))));
  if (parts.some(part => !part.exists())) throw new Error('A packed record is incomplete. No data was changed.');
  return { head, parts };
}
async function compress(value: unknown): Promise<Uint8Array<ArrayBuffer>> {
  // Reference repeated large strings (especially answer photos) only once.
  const strings: string[] = [];
  const indexes = new Map<string, number>();
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'string' || item.length < 100) return item;
    let index = indexes.get(item);
    if (index === undefined) { index = strings.length; strings.push(item); indexes.set(item, index); }
    return { __packedText: index };
  });
  const stream = new Blob([JSON.stringify({ json, strings })]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function decodePacked<T>(rows: PackedRows, key: CryptoKey): Promise<T> {
  if (!rows.head.exists() || rows.head.data()?.storage !== 2) throw new Error('The packed record is unavailable.');
  const segments = await Promise.all([rows.head, ...rows.parts].map(async row => fromBase64(await decryptRecord<string>(row.data()!, key, row.ref.path))));
  const stream = new Blob(segments).stream().pipeThrough(new DecompressionStream('gzip'));
  const { json, strings } = JSON.parse(await new Response(stream).text()) as { json: string; strings: string[] };
  return JSON.parse(json, (_name, value) => {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && '__packedText' in value) {
      if (!Number.isInteger(value.__packedText) || typeof strings[value.__packedText] !== 'string') throw new Error('The packed text is damaged.');
      return strings[value.__packedText];
    }
    return value;
  }) as T;
}
export async function encodePacked(ref: DocumentReference, value: unknown, key: CryptoKey) {
  const bytes = await compress(value);
  const count = Math.max(1, Math.ceil(bytes.length / PART_BYTES));
  if (count > MAX_PARTS) throw new Error('This class or history month is too large to save. Use smaller pictures. No data was changed.');
  return Promise.all(Array.from({ length: count }, async (_, index) => {
    const target = index === 0 ? ref : partRef(ref, index);
    const envelope = await encryptRecord(toBase64(bytes.slice(index * PART_BYTES, (index + 1) * PART_BYTES)), key, target.path);
    return { ref: target, payload: index === 0 ? { ...envelope, storage: 2, partCount: count } : envelope };
  }));
}
export function writePacked(tx: Transaction, old: PackedRows, encoded: Awaited<ReturnType<typeof encodePacked>>) {
  encoded.forEach(row => tx.set(row.ref, row.payload));
  if (old.head.data()?.storage === 2) {
    for (let index = encoded.length; index < partCount(old.head); index++) tx.delete(partRef(old.head.ref, index));
  }
}
