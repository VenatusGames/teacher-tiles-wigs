import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createHash } from 'node:crypto';

const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
function compile(file, imports = {}) {
  let source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  for (const [name, url] of Object.entries(imports)) source = source.replaceAll("from '" + name + "'", "from '" + url + "'");
  return moduleUrl(source);
}
const encryptionUrl = compile('lib/encryption.ts');
const encryption = await import(encryptionUrl);
const { encryptRecord, decryptRecord, importKey, toBase64, emailLookup } = encryption;
const raw = crypto.getRandomValues(new Uint8Array(32));
const key = await importKey(toBase64(raw));
const path = 'classes/test/students/test';
const payload = { name: 'Synthetic learner 🌱', imageKey: 'preset:smile', items: [{ answer: 'A test answer' }] };
const first = await encryptRecord(payload, key, path);
const second = await encryptRecord(payload, key, path);
const syntheticPhoto = 'data:image/jpeg;base64,' + toBase64(crypto.getRandomValues(new Uint8Array(24 * 1024)));
const photoEnvelope = await encryptRecord({ imageKey: syntheticPhoto }, key, path);
assert.deepEqual(await decryptRecord(photoEnvelope, key, path), { imageKey: syntheticPhoto });
assert(!JSON.stringify(photoEnvelope).includes(syntheticPhoto));
assert.notEqual(first.iv, second.iv);
assert.notEqual(first.ciphertext, second.ciphertext);
assert.deepEqual(await decryptRecord(first, key, path), payload);
assert(!JSON.stringify(first).includes(payload.name));
await assert.rejects(decryptRecord(first, key, path + '-other'));
await assert.rejects(decryptRecord(first, await importKey(toBase64(crypto.getRandomValues(new Uint8Array(32)))), path));
await assert.rejects(decryptRecord({ ...first, version: 2 }, key, path));
await assert.rejects(decryptRecord({ ...first, iv: 'broken' }, key, path));
await assert.rejects(decryptRecord({ ...first, ciphertext: (first.ciphertext[0] === 'A' ? 'B' : 'A') + first.ciphertext.slice(1) }, key, path));
await assert.rejects(encryptRecord('x'.repeat(720000), key, path), /too large/);
const address = name => [name, 'example.invalid'].join('@');
assert.equal(await emailLookup('  ' + address('Child').toUpperCase() + '  '), createHash('sha256').update(address('child')).digest('hex'));
assert.equal(await emailLookup(''), '');

// In-memory Firestore API exercises the real storage/migration code with Web Crypto.
// This tests application behavior, not server-side security rules (separate suite).
const rows = new Map();
const ref = path => ({ path, id: path.split('/').at(-1) });
const snapshot = reference => {
  const value = rows.get(reference.path);
  return { ref: reference, id: reference.id, exists: () => value !== undefined, data: () => value };
};
let commits = 0, failAt = -1;
let reads = 0, writeCount = 0;
let raceBeforeCommit;
let transactionRetries = 0;
const firestore = {
  doc: (parent, ...parts) => ref([parent.path, ...parts].filter(Boolean).join('/')),
  collection: (parent, ...parts) => ref([parent.path, ...parts].filter(Boolean).join('/')),
  getDoc: async reference => { reads++; return snapshot(reference); },
  getDocs: async reference => {
    let docs = [...rows.keys()].filter(path => path.startsWith(reference.path + '/') && path.split('/').length === reference.path.split('/').length + 1).map(path => snapshot(ref(path)));
    const constraints = reference.constraints ?? [];
    const direction = constraints.find(c => c.kind === 'order')?.direction ?? 'asc';
    docs.sort((a,b) => (direction === 'asc' ? 1 : -1) * a.id.localeCompare(b.id));
    for (const c of constraints) {
      if (c.kind === 'where') docs = docs.filter(row => c.op === '>=' ? row.id >= c.value : row.id <= c.value);
      if (c.kind === 'after') docs = docs.filter(row => direction === 'asc' ? row.id > c.value : row.id < c.value);
      if (c.kind === 'limit') docs = docs.slice(0,c.value);
    }
    reads += Math.max(1, docs.length); return { docs };
  },
  query: (reference, ...constraints) => ({ ...reference, constraints }),
  documentId: () => '__name__',
  orderBy: (_field, direction) => ({ kind: 'order', direction }),
  where: (_field, op, value) => ({ kind: 'where', op, value }),
  startAfter: value => ({ kind: 'after', value }),
  limit: value => ({ kind: 'limit', value }),
  deleteDoc: async reference => { rows.delete(reference.path); },
  runTransaction: async (_db, fn) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const writes = [], observed = new Map(); let writing = false;
      const result = await fn({
        get: async reference => { assert(!writing, 'All reads must precede writes'); reads++; observed.set(reference.path, rows.get(reference.path)); return snapshot(reference); },
        set: (reference, data) => { writing = true; writes.push(() => rows.set(reference.path, data)); },
        delete: reference => { writing = true; writes.push(() => rows.delete(reference.path)); },
      });
      if (raceBeforeCommit) { const race = raceBeforeCommit; raceBeforeCommit = undefined; await race(); }
      if ([...observed].some(([path, value]) => rows.get(path) !== value)) { transactionRetries++; continue; }
      if (++commits === failAt) throw new Error('Simulated interruption');
      writeCount += writes.length;
      for (const write of writes) write();
      return result;
    }
    throw new Error('Transaction contention');
  },
  writeBatch: () => {
    const deletes = [];
    return { delete: reference => deletes.push(reference.path), commit: async () => { for (const path of deletes) rows.delete(path); } };
  },
};
const auth = { currentUser: { uid: 'teacher-test', email: address('teacher') } };
globalThis.encryptionHarness = { firestore, auth };
const firestoreUrl = moduleUrl('export const { doc, collection, getDoc, getDocs, runTransaction, writeBatch, deleteDoc, query, documentId, orderBy, where, startAfter, limit } = globalThis.encryptionHarness.firestore;');
const firebaseUrl = moduleUrl('export const auth = globalThis.encryptionHarness.auth; export const requireDb = () => ({});');
const modelUrl = compile('lib/model.ts');
const cacheUrl = compile('lib/read-cache.ts', { './firebase': firebaseUrl });
const cache = await import(cacheUrl);
const activityUrl = compile('lib/firestore-activity.ts', { 'firebase/firestore': firestoreUrl });
const activity = await import(activityUrl);
const vaultUrl = compile('lib/key-vault.ts', { 'firebase/firestore': firestoreUrl, './firestore-activity': activityUrl, './firebase': firebaseUrl, './encryption': encryptionUrl, './read-cache': cacheUrl });
const packedUrl = compile('lib/packed-store.ts', { 'firebase/firestore': firestoreUrl, './encryption': encryptionUrl });
const packed = await import(packedUrl);
const studentAccessUrl = moduleUrl(`
export async function loadPendingStudentResponses(){ return { token: null, entries: [] }; }
export async function markStudentResponsesImported(){}
export async function mirrorTeacherResponse(){}
export async function syncStudentAccessChange(){}
export async function deleteStudentAccessResponse(){}
export async function deleteStudentAccessResponsesForStudent(){}
`);
const store = await import(compile('lib/class-store.ts', { 'firebase/firestore': firestoreUrl, './firestore-activity': activityUrl, './firebase': firebaseUrl, './encryption': encryptionUrl, './key-vault': vaultUrl, './packed-store': packedUrl, './model': modelUrl, './read-cache': cacheUrl, './student-access': studentAccessUrl }));
const teacher = { role: 'teacher', ownerId: auth.currentUser.uid };
const classPath = 'classes/' + teacher.ownerId;
const sharedKey = async () => importKey(rows.get(classPath + '/keys/shared').keyMaterial);
const readValue = async path => {
  const head = snapshot(ref(path));
  const parts = Array.from({ length: (head.data()?.partCount ?? 1) - 1 }, (_, i) => snapshot(ref(path + '/parts/' + (i + 1))));
  return packed.decodePacked({ head, parts }, await sharedKey());
};
const setValue = async (path, value) => {
  const encoded = await packed.encodePacked(ref(path), value, await sharedKey());
  const count = rows.get(path)?.partCount ?? 1;
  for (let i = encoded.length; i < count; i++) rows.delete(path + '/parts/' + i);
  encoded.forEach(row => rows.set(row.ref.path, row.payload));
};
let cacheLoads = 0;
await Promise.all([cache.cachedRead(teacher, 'dedupe', async () => ++cacheLoads), cache.cachedRead(teacher, 'dedupe', async () => ++cacheLoads)]);
assert.equal(cacheLoads, 1);
cache.clearReadCache();
let data = await store.loadClass(teacher);
assert.equal(data.questions.length, 1);
assert.equal(rows.get(classPath).storage, 2);
assert.equal(rows.get(classPath).partCount, 1);
assert(![...rows.keys()].some(path => /\/(students|questions|answers)\//.test(path)));
for (let index = 0; index < 35; index++) await store.changeClass(teacher, { action: 'addStudent', name: 'Synthetic learner ' + index, email: address('ignored'), imageKey: index % 2 ? syntheticPhoto : 'preset:smile' });
data = await store.loadClass(teacher);
assert.equal(data.students.length, 35);
assert(!data.students.some(student => 'email' in student));
assert(![...rows.keys()].some(path => path.includes('/keys/student_')));
const child = data.students[0];
const coldCounts = [];
for (let i = 0; i < 3; i++) {
  cache.clearReadCache(); const before = reads;
  assert.deepEqual(await store.loadClass(teacher), data);
  coldCounts.push(reads - before);
}
assert.deepEqual(coldCounts, [2, 2, 2], 'Every cold load reads exactly one packed class and one shared key');
const warmReads = reads;
for (const student of data.students) assert.equal(await store.completedToday(teacher, student.id), false);
await Promise.all([store.loadClass(teacher), store.loadClass(teacher)]);
assert.equal(reads, warmReads, 'Roster/menu/completion checks add no reads for any student');
const realNow = Date.now;
Date.now = () => realNow() + 10 * 86400000;
await store.loadClass(teacher);
assert.equal(reads, warmReads, 'No timer or five-minute expiry refetches the class');
Date.now = realNow;
store.refreshClassData(teacher);
const refreshReads = reads;
await store.loadClass(teacher);
assert.equal(reads - refreshReads, 1, 'Explicit refresh fetches only the packed class when the key is already loaded');
for (const action of [
  { action: 'updateStudentName', id: child.id, name: 'Renamed synthetic learner' },
  { action: 'updateStudentImage', id: child.id, imageKey: syntheticPhoto },
  { action: 'updateStudentScores', id: child.id, currentScore: 2, goalScore: 8 },
  { action: 'saveSettings', title: 'Packed class', description: 'Packed description' },
  { action: 'setQuestionFridayOnly', id: 'starter', fridayOnly: false },
]) {
  const beforeReads = reads, beforeWrites = writeCount;
  await store.changeClass(teacher, action); await store.loadClass(teacher);
  assert.equal(reads - beforeReads, 1, action.action + ' reads only the packed class');
  assert.equal(writeCount - beforeWrites, 1);
}
data = await store.loadClass(teacher);
assert.equal(data.students.find(row => row.id === child.id).currentScore, 2);
await store.changeClass(teacher, { action: 'addQuestion', prompt: 'Additional question', fridayOnly: true });
const question = (await store.loadClass(teacher)).questions.find(row => row.id !== 'starter');
await store.changeClass(teacher, { action: 'addAnswer', questionId: question.id, label: 'Additional answer' });
let beforeReads = reads;
await store.changeClass(teacher, { action: 'deleteQuestion', id: question.id });
assert.equal(reads - beforeReads, 1, 'Deleting a question never scans its answers');
assert.equal((await store.loadClass(teacher)).answers.length, 3);
await assert.rejects(store.changeClass(teacher, { action: 'updateStudentEmail', id: child.id, email: address('unused') }), /Unknown class action/);
data = await store.loadClass(teacher);
const forbidden = { role: 'teacher', ownerId: 'other-owner' };
await assert.rejects(store.loadClass(forbidden));
await assert.rejects(store.completedToday(forbidden, child.id));
await assert.rejects(store.changeClass(forbidden, { action: 'deleteStudent', id: child.id }));
beforeReads = reads;
const beforePartialWrites = writeCount;
await assert.rejects(store.submitResponse(teacher, child, data, {}), /Answer every question/);
assert.equal(reads, beforeReads); assert.equal(writeCount, beforePartialWrites);
await store.submitResponse(teacher, child, data, { starter: 'starter-1' });
assert.equal(reads - beforeReads, 2, 'Check-in transaction reads only class + month, with no per-student keys');
assert.equal(writeCount - beforePartialWrites, 2, 'Check-in and completion index commit atomically');
assert(await store.completedToday(teacher, child.id));
const submittedState = JSON.stringify([...rows]);
await assert.rejects(store.submitResponse(teacher, child, data, { starter: 'starter-1' }), /already completed/);
assert.equal(JSON.stringify([...rows]), submittedState);
const beforeHistory = reads;
assert.equal((await store.loadHistory(teacher, child.id))[0].items[0].answer, 'On My Way');
assert.equal(reads - beforeHistory, 1, 'Opening history reads one packed month');
await store.loadHistory(teacher, child.id);
assert.equal(reads - beforeHistory, 1, 'Revisiting history adds no reads');

// Seed 38 records across two students on the same dates. Pagination uses the
// encrypted day index, so it needs no look-ahead query or per-student fan-out.
const secondChild = data.students.find(row => row.id !== child.id);
let state = await readValue(classPath);
const archive = { entries: [] };
for (const [student, count] of [[child, 25], [secondChild, 12]]) {
  for (let day = 1; day <= count; day++) {
    const date = '2025-01-' + String(day).padStart(2, '0');
    archive.entries.push({ id: date, studentId: student.id, studentName: student.name, createdAt: date + 'T12:00:00.000Z', items: [{ question: 'Synthetic question', answer: 'Synthetic answer', imageKey: syntheticPhoto }] });
    (state.days[date] ??= []).push(student.id);
  }
}
await setValue(classPath + '/historyMonths/2025-01', archive);
await setValue(classPath, state);
cache.clearReadCache(); await store.loadClass(teacher);
for (const order of ['asc', 'desc']) {
  const filter = { studentId: 'all', from: '', to: '', order };
  const before = reads; let page = await store.loadHistoryPage(teacher, filter);
  assert(reads - before <= 2, 'All-student history reads at most the months needed by this page');
  const entries = [...page.entries];
  while (page.hasMore) {
    page = await store.loadHistoryPage(teacher, { ...filter, after: page.nextCursor });
    entries.push(...page.entries); assert(entries.length <= 38);
  }
  assert.equal(entries.length, 38);
  assert.equal(new Set(entries.map(row => row.id + ':' + row.studentId)).size, 38);
  assert.deepEqual(entries.map(row => row.id + ':' + row.studentId), entries.map(row => row.id + ':' + row.studentId).sort((a, b) => (order === 'asc' ? 1 : -1) * a.localeCompare(b)));
}
const range = { studentId: 'all', from: '2025-01-06', to: '2025-01-06', order: 'asc' };
assert.equal((await store.loadHistoryPage(teacher, range)).entries.length, 2);
await store.changeClass(teacher, { action: 'deleteResponse', studentId: child.id, id: '2025-01-06' });
assert.equal((await store.loadHistoryPage(teacher, range)).entries.length, 1);
await store.changeClass(teacher, { action: 'deleteResponse', studentId: child.id, id: (await store.loadHistory(teacher, child.id))[0].id });
assert.equal(await store.completedToday(teacher, child.id), false);

// Concurrent edits must retry against the latest whole-class record rather than
// overwrite another tab's changes with its memory cache.
raceBeforeCommit = async () => {
  const external = await readValue(classPath);
  external.data.settings.title = 'Changed in another tab';
  await setValue(classPath, external);
};
await store.changeClass(teacher, { action: 'updateStudentName', id: child.id, name: 'Concurrent name' });
assert(transactionRetries > 0);
assert.equal((await store.loadClass(teacher)).settings.title, 'Changed in another tab');
assert.equal((await store.loadClass(teacher)).students.find(row => row.id === child.id).name, 'Concurrent name');
const beforeFailure = JSON.stringify([...rows]);
failAt = commits + 1;
await assert.rejects(store.changeClass(teacher, { action: 'saveSettings', title: 'Must not save', description: 'Atomic failure' }), /Simulated interruption/);
failAt = -1;
assert.equal(JSON.stringify([...rows]), beforeFailure);
await store.changeClass(teacher, { action: 'deleteStudent', id: child.id });
assert(!(await store.loadClass(teacher)).students.some(row => row.id === child.id));
assert(!(await readValue(classPath + '/historyMonths/2025-01')).entries.some(row => row.studentId === child.id));
assert.deepEqual((await readValue(classPath)).purges, {});

// Realistic unique photos exceed one document: splitting remains bounded and
// reloads never fall back to per-record reads. Removing photos also removes parts.
for (const student of (await store.loadClass(teacher)).students) {
  const photo = 'data:image/jpeg;base64,' + toBase64(crypto.getRandomValues(new Uint8Array(24 * 1024)));
  await store.changeClass(teacher, { action: 'updateStudentImage', id: student.id, imageKey: photo });
}
assert(rows.get(classPath).partCount > 1);
cache.clearReadCache(); beforeReads = reads;
data = await store.loadClass(teacher);
assert.equal(reads - beforeReads, rows.get(classPath).partCount + 1, 'Large classes cost one read per packed part plus one key');
for (const [path, value] of rows) if (value.ciphertext) assert(Buffer.byteLength(JSON.stringify(value)) < 1048576, path);
for (const student of data.students) await store.changeClass(teacher, { action: 'removeStudentImage', id: student.id });
assert.equal(rows.get(classPath).partCount, 1);
assert(!rows.has(classPath + '/parts/1'));
const oversized = Array.from({ length: 32 }, () => toBase64(crypto.getRandomValues(new Uint8Array(65536))));
await assert.rejects(packed.encodePacked(ref(classPath), oversized, await sharedKey()), /too large/);

// Plaintext and encrypted legacy data convert once; interruptions preserve the
// source and are resumable. No email survives in the new class or old profiles.
for (const encryptedLegacy of [false, true]) for (const failOffset of [3, 4, 5]) {
  rows.clear(); cache.clearReadCache();
  const shared = await importKey(toBase64(raw));
  rows.set(classPath + '/keys/shared', { version: 1, keyMaterial: toBase64(raw) });
  const oldStudentKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const studentKey = await importKey(oldStudentKey);
  rows.set(classPath + '/keys/student_legacy', { version: 1, keyMaterial: oldStudentKey });
  const oldRoot = { title: 'Legacy class', description: 'Legacy description' };
  rows.set(classPath, encryptedLegacy ? await encryptRecord(oldRoot, shared, classPath) : oldRoot);
  const oldProfile = { id: 'legacy', name: 'Legacy learner', email: address('legacy'), imageKey: syntheticPhoto, currentScore: 3, goalScore: 7 };
  const profilePath = classPath + '/students/legacy';
  const hash = await emailLookup(address('legacy'));
  rows.set(profilePath, encryptedLegacy ? { ...await encryptRecord(oldProfile, studentKey, profilePath), emailHash: hash } : oldProfile);
  rows.set('studentAccess/' + hash, { ownerId: teacher.ownerId, studentId: 'legacy' });
  rows.set('studentLinks/' + address('legacy'), { ownerId: teacher.ownerId, studentId: 'legacy' });
  const oldQuestion = { id: 'q', prompt: 'Legacy question', position: 1, fridayOnly: false };
  const oldAnswer = { id: 'a', questionId: 'q', label: 'Legacy answer', imageKey: 'preset:yes', position: 1 };
  rows.set(classPath + '/questions/q', encryptedLegacy ? await encryptRecord(oldQuestion, shared, classPath + '/questions/q') : oldQuestion);
  rows.set(classPath + '/answers/a', encryptedLegacy ? await encryptRecord(oldAnswer, shared, classPath + '/answers/a') : oldAnswer);
  const responsePath = profilePath + '/responses/2026-01-02';
  const response = { createdAt: '2026-01-02T15:00:00.000Z', items: [{ question: 'Legacy question', answer: 'Legacy answer', imageKey: 'preset:yes' }] };
  rows.set(responsePath, encryptedLegacy ? await encryptRecord(response, studentKey, responsePath) : { ...response, createdAt: { toDate: () => new Date(response.createdAt) } });
  failAt = commits + failOffset; // Archive, class publication, or cleanup bookkeeping.
  await assert.rejects(store.loadClass(teacher), /Simulated interruption/);
  failAt = -1;
  if (rows.get(classPath).storage !== 2) { assert(rows.has(profilePath)); assert(rows.has(responsePath)); }
  else { assert.equal((await readValue(classPath + '/historyMonths/2026-01')).entries.length, 1); }
  data = await store.loadClass(teacher);
  assert.equal(data.students[0].currentScore, 3); assert.equal(data.students[0].goalScore, 7);
  assert.equal(data.students[0].imageKey, syntheticPhoto); assert(!('email' in data.students[0]));
  assert.equal((await store.loadHistory(teacher))[0].createdAt, response.createdAt);
  assert(!rows.has(profilePath)); assert(!rows.has(responsePath));
  assert(![...rows.keys()].some(path => path.startsWith('studentAccess/') || path.startsWith('studentLinks/')));
  cache.clearReadCache(); beforeReads = reads;
  await store.loadClass(teacher);
  assert.equal(reads - beforeReads, 2, 'Converted legacy classes never rescan the old collections');
  assert.deepEqual((await readValue(classPath)).cleanupPaths, []);
}
rows.delete(classPath + '/keys/shared'); cache.clearReadCache();
const missingKeyState = JSON.stringify([...rows]);
await assert.rejects(store.loadClass(teacher), /encryption key is unavailable/);
assert.equal(JSON.stringify([...rows]), missingKeyState, 'Missing keys must never be regenerated for packed data');
const ownUser = auth.currentUser;
auth.currentUser = { uid: 'different-account' };
await assert.rejects(store.loadClass(teacher));
assert.equal((await store.loadClass({ role: 'teacher', ownerId: 'different-account' })).students.length, 0);
auth.currentUser = ownUser;
delete globalThis.encryptionHarness;
console.log('Packed storage passed: cold loads 2 reads; warm completion/menu visits 0; ordinary edits 1; submissions 2; a history month 1. Migration, concurrency, encryption, and multi-part size checks passed.');
