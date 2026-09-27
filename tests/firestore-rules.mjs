import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, collection, query, where, orderBy, limit, setDoc, deleteDoc, writeBatch, setLogLevel, serverTimestamp } from 'firebase/firestore';
import assert from 'node:assert/strict';
import ts from 'typescript';
setLogLevel('silent');
const env = await initializeTestEnvironment({ projectId: 'demo-wigs-tests', firestore: { host: '127.0.0.1', port: 8085, rules: readFileSync('firestore.rules', 'utf8') } });
const email = name => [name, 'example.invalid'].join('@');
const signed = (uid, extra = {}) => env.authenticatedContext(uid, { email: email(uid), email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...extra }).firestore();
const teacher = signed('teacher-a'), other = signed('teacher-b'), formerStudent = signed('child'), anonymous = env.unauthenticatedContext().firestore();
const root = 'classes/teacher-a';
const profile = root + '/students/child-1';
const encrypted = () => ({ version: 1, iv: randomBytes(12).toString('base64'), ciphertext: randomBytes(64).toString('base64') });
const packedRecord = () => ({ ...encrypted(), storage: 2, partCount: 1 });
const key = () => ({ version: 1, keyMaterial: randomBytes(32).toString('base64') });
const hash = createHash('sha256').update(email('child')).digest('hex');
let checks = 0;
const ok = async promise => { await assertSucceeds(promise); checks++; };
const no = async promise => { await assertFails(promise); checks++; };
try {
  await env.clearFirestore();
  await ok(setDoc(doc(teacher, root + '/keys/shared'), key()));
  await ok(setDoc(doc(teacher, root), packedRecord()));
  await ok(setDoc(doc(teacher, root + '/parts/1'), encrypted()));
  await ok(setDoc(doc(teacher, root + '/historyMonths/2026-01'), packedRecord()));
  await ok(setDoc(doc(teacher, root + '/historyMonths/2026-01/parts/1'), encrypted()));
  await no(setDoc(doc(teacher, root + '/parts/4'), encrypted()));
  await no(setDoc(doc(teacher, root + '/historyMonths/bad'), packedRecord()));
  for (const value of [0, 5, 1.5, '1']) await no(setDoc(doc(teacher, root), { ...packedRecord(), partCount: value }));
  await no(setDoc(doc(teacher, root), { ...packedRecord(), name: 'Plaintext' }));
  await no(setDoc(doc(teacher, root), encrypted()));
  await no(setDoc(doc(teacher, root + '/keys/shared'), key()));
  await no(deleteDoc(doc(teacher, root + '/keys/shared')));
  await no(getDocs(collection(teacher, root + '/keys')));
  await no(getDocs(collection(teacher, 'classes')));
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'studentAccess', hash), { ownerId: 'teacher-a', studentId: 'child-1' });
    await setDoc(doc(db, 'studentLinks', email('child')), { ownerId: 'teacher-a', studentId: 'child-1' });
    await setDoc(doc(db, profile), { ...encrypted(), emailHash: hash });
  });
  const publicToken = 'student-access-token-1234567890abcdef';
  const publicRoot = 'studentAccess/' + publicToken;
  await ok(setDoc(doc(teacher, root + '/studentAccess/config'), { version: 1, token: publicToken }));
  // The owner must be able to inspect an as-yet-unpublished token and create
  // the root plus its child records in the same first-publish batch.
  await ok(getDoc(doc(teacher, publicRoot)));
  const initialPublish = writeBatch(teacher);
  initialPublish.set(doc(teacher, publicRoot), {
    version: 2, ownerId: 'teacher-a', active: true, title: 'Daily WIG Check-In', description: 'Choose honestly.',
    studentIds: ['child-1'], questionIds: ['q-1'], answerIds: ['a-1'],
  });
  initialPublish.set(doc(teacher, publicRoot + '/students/child-1'), { name: 'Child', imageKey: null, currentScore: 2, goalScore: 5 });
  initialPublish.set(doc(teacher, publicRoot + '/questions/q-1'), { prompt: 'How did it go?', position: 1, fridayOnly: false });
  initialPublish.set(doc(teacher, publicRoot + '/answers/a-1'), { questionId: 'q-1', label: 'Great', imageKey: 'preset:smile', position: 1 });
  await ok(initialPublish.commit());
  await ok(getDoc(doc(anonymous, publicRoot)));
  await ok(getDocs(collection(anonymous, publicRoot + '/students')));
  await ok(getDocs(collection(anonymous, publicRoot + '/questions')));
  await ok(getDocs(collection(anonymous, publicRoot + '/answers')));
  await no(getDocs(collection(anonymous, 'studentAccess')));
  await no(getDoc(doc(anonymous, root + '/studentAccess/config')));
  await no(setDoc(doc(anonymous, publicRoot + '/students/child-2'), { name: 'Nope' }));
  const responsePath = publicRoot + '/responses/2026-09-21_child-1';
  const publicResponse = {
    version: 1, day: '2026-09-21', studentId: 'child-1', studentName: 'Child', createdAt: serverTimestamp(),
    items: [{ question: 'How did it go?', answer: 'Great', imageKey: 'preset:smile' }], imported: false,
  };
  await ok(setDoc(doc(anonymous, responsePath), publicResponse));
  await ok(getDocs(query(collection(anonymous, publicRoot + '/responses'), where('day', '==', '2026-09-21'))));
  await ok(getDocs(query(collection(anonymous, publicRoot + '/responses'), where('studentId', '==', 'child-1'), orderBy('day', 'desc'), limit(10))));
  await no(setDoc(doc(anonymous, responsePath), publicResponse));
  await no(deleteDoc(doc(anonymous, responsePath)));
  await no(setDoc(doc(anonymous, publicRoot + '/responses/2026-09-21_missing'), { ...publicResponse, studentId: 'missing' }));
  await no(setDoc(doc(other, publicRoot), { version: 2, ownerId: 'teacher-b', active: true, title: 'x', description: '', studentIds: [], questionIds: [], answerIds: [] }));
  await ok(setDoc(doc(teacher, responsePath), { version: 1, day: '2026-09-21', studentId: 'child-1', studentName: 'Child', createdAt: '2026-09-21T12:00:00.000Z', items: publicResponse.items, imported: true }));

  const paths = [root, root + '/parts/1', root + '/keys/shared', root + '/historyMonths/2026-01', root + '/historyMonths/2026-01/parts/1', profile];
  for (const db of [other, formerStudent, anonymous, signed('teacher-a', { email_verified: false }), signed('teacher-a', { firebase: { sign_in_provider: 'password' } })]) {
    for (const path of paths) { await no(getDoc(doc(db, path))); await no(setDoc(doc(db, path), packedRecord())); await no(deleteDoc(doc(db, path))); }
    await no(getDocs(collection(db, root + '/students')));
    await no(setDoc(doc(db, profile + '/responses/2026-01-02'), encrypted()));
    await no(getDoc(doc(db, 'studentAccess', hash)));
    await no(deleteDoc(doc(db, 'studentAccess', hash)));
  }
  for (const path of paths) await ok(getDoc(doc(teacher, path)));
  await no(setDoc(doc(teacher, profile), encrypted()));
  await no(setDoc(doc(teacher, root + '/questions/q'), encrypted()));
  await no(setDoc(doc(teacher, root + '/answers/a'), encrypted()));
  await no(setDoc(doc(teacher, profile + '/responses/2026-01-02'), encrypted()));
  await no(setDoc(doc(teacher, 'studentAccess', hash), { ownerId: 'teacher-a', studentId: 'child-1' }));
  await no(setDoc(doc(teacher, 'studentLinks', email('new')), { ownerId: 'teacher-a', studentId: 'child-1' }));
  const cleanup = writeBatch(teacher);
  cleanup.delete(doc(teacher, profile));
  cleanup.delete(doc(teacher, 'studentAccess', hash));
  cleanup.delete(doc(teacher, 'studentLinks', email('child')));
  await ok(cleanup.commit());
  await ok(deleteDoc(doc(teacher, 'studentAccess', hash))); // Interrupted cleanup can retry missing records.
  const cleanupIds = Array.from({ length: 30 }, (_, index) => createHash('sha256').update('cleanup-' + index).digest('hex'));
  await env.withSecurityRulesDisabled(async context => {
    const batch = writeBatch(context.firestore());
    cleanupIds.forEach(id => batch.set(doc(context.firestore(), 'studentAccess', id), { ownerId: 'teacher-a', studentId: 'old' }));
    await batch.commit();
  });
  const bulkCleanup = writeBatch(teacher);
  cleanupIds.forEach(id => bulkCleanup.delete(doc(teacher, 'studentAccess', id)));
  await ok(bulkCleanup.commit()); // No dependent lookup per directory deletion.

  // A migration lock rejects old writes AND old deletes until conversion commits.
  const legacyRoot = 'classes/legacy-owner'; const legacyDb = signed('legacy-owner');
  const source = encrypted();
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), legacyRoot), source);
    await setDoc(doc(context.firestore(), legacyRoot + '/students/old'), encrypted());
    await setDoc(doc(context.firestore(), legacyRoot + '/students/old/responses/2026-01-02'), encrypted());
  });
  await ok(setDoc(doc(legacyDb, legacyRoot), { ...source, storage: 'packing' }));
  await no(setDoc(doc(legacyDb, legacyRoot), { ...source, storage: 'packing', ciphertext: encrypted().ciphertext }));
  await no(setDoc(doc(legacyDb, legacyRoot + '/students/old'), encrypted()));
  await no(deleteDoc(doc(legacyDb, legacyRoot + '/students/old')));
  await no(deleteDoc(doc(legacyDb, legacyRoot + '/students/old/responses/2026-01-02')));
  await ok(setDoc(doc(legacyDb, legacyRoot), packedRecord()));
  await ok(deleteDoc(doc(legacyDb, legacyRoot + '/students/old/responses/2026-01-02')));
  await ok(deleteDoc(doc(legacyDb, legacyRoot + '/students/old')));
  await no(setDoc(doc(legacyDb, legacyRoot), { ...source, storage: 'packing' }));

  // Run the actual app storage code against the emulator, including Web Crypto,
  // compressed records, migration, check-ins, deletes, and SDK transactions.
  const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const compile = (file, imports = {}) => {
    let source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    for (const [name, url] of Object.entries(imports)) source = source.replaceAll("from '" + name + "'", "from '" + url + "'");
    return moduleUrl(source);
  };
  const firestoreUrl = import.meta.resolve('firebase/firestore');
  globalThis.packedRulesHarness = { db: signed('integration-owner'), auth: { currentUser: { uid: 'integration-owner', emailVerified: true } } };
  const firebaseUrl = moduleUrl('export const auth = globalThis.packedRulesHarness.auth; export const requireDb = () => globalThis.packedRulesHarness.db;');
  const encryptionUrl = compile('lib/encryption.ts'); const encryption = await import(encryptionUrl);
  const cacheUrl = compile('lib/read-cache.ts', { './firebase': firebaseUrl }); const cache = await import(cacheUrl);
  const activityUrl = compile('lib/firestore-activity.ts', { 'firebase/firestore': firestoreUrl }); const activity = await import(activityUrl);
  const packedUrl = compile('lib/packed-store.ts', { 'firebase/firestore': firestoreUrl, './encryption': encryptionUrl });
  const vaultUrl = compile('lib/key-vault.ts', { 'firebase/firestore': firestoreUrl, './firestore-activity': activityUrl, './firebase': firebaseUrl, './encryption': encryptionUrl, './read-cache': cacheUrl });
  const studentAccessUrl = moduleUrl(`
export async function loadPendingStudentResponses(){ return { token: null, entries: [] }; }
export async function markStudentResponsesImported(){}
export async function mirrorTeacherResponse(){}
export async function syncStudentAccessChange(){}
export async function deleteStudentAccessResponse(){}
export async function deleteStudentAccessResponsesForStudent(){}
`);
  const store = await import(compile('lib/class-store.ts', { 'firebase/firestore': firestoreUrl, './firestore-activity': activityUrl, './firebase': firebaseUrl, './encryption': encryptionUrl, './read-cache': cacheUrl, './key-vault': vaultUrl, './packed-store': packedUrl, './model': compile('lib/model.ts'), './student-access': studentAccessUrl }));
  const access = { role: 'teacher', ownerId: 'integration-owner' };
  await store.loadClass(access);
  await store.changeClass(access, { action: 'addStudent', name: 'Integration learner', imageKey: 'preset:smile' });
  cache.clearReadCache();
  let before = activity.getReadActivity().requests;
  const data = await store.loadClass(access); const student = data.students[0];
  assert.equal(activity.getReadActivity().requests - before, 2);
  before = activity.getReadActivity().requests;
  assert.equal(await store.completedToday(access, student.id), false);
  assert.equal(activity.getReadActivity().requests, before);
  await store.submitResponse(access, student, data, { starter: 'starter-1' });
  assert.equal(activity.getReadActivity().requests - before, 2);
  assert.equal((await store.loadHistory(access))[0].items[0].answer, 'On My Way');
  await assert.rejects(store.submitResponse(access, student, data, { starter: 'starter-1' }), /already completed/);
  await store.changeClass(access, { action: 'deleteStudent', id: student.id });
  assert.equal((await store.loadHistory(access)).length, 0);

  // Multi-part bundles use the same transaction/rules path as small classes.
  const packed = await import(packedUrl);
  const integrationDb = globalThis.packedRulesHarness.db;
  const integrationRoot = doc(integrationDb, 'classes/integration-owner');
  const integrationKey = await encryption.importKey((await getDoc(doc(integrationRoot, 'keys/shared'))).data().keyMaterial);
  const largeState = await packed.decodePacked({ head: await getDoc(integrationRoot), parts: [] }, integrationKey);
  largeState.data.students = Array.from({ length: 32 }, (_, index) => ({ id: 'large-' + index, name: 'Large class learner ' + index, imageKey: 'data:image/jpeg;base64,' + randomBytes(24 * 1024).toString('base64'), currentScore: null, goalScore: null }));
  const encoded = await packed.encodePacked(integrationRoot, largeState, integrationKey);
  assert(encoded.length > 1);
  const largeBatch = writeBatch(integrationDb);
  encoded.forEach(row => largeBatch.set(row.ref, row.payload));
  await largeBatch.commit(); cache.clearReadCache(); before = activity.getReadActivity().requests;
  assert.equal((await store.loadClass(access)).students.length, 32);
  assert.equal(activity.getReadActivity().requests - before, encoded.length + 1);
  before = activity.getReadActivity().requests;
  await store.changeClass(access, { action: 'updateStudentName', id: 'large-0', name: 'Updated large class learner' });
  assert.equal(activity.getReadActivity().requests - before, encoded.length);

  // Actual legacy migration and post-commit cleanup under production rules.
  const migrationOwner = 'migration-integration';
  globalThis.packedRulesHarness.db = signed(migrationOwner); globalThis.packedRulesHarness.auth.currentUser = { uid: migrationOwner, emailVerified: true };
  const migrationAccess = { role: 'teacher', ownerId: migrationOwner };
  const migrationRoot = 'classes/' + migrationOwner;
  const material = key(); const sharedKey = await encryption.importKey(material.keyMaterial);
  const studentMaterial = key(); const studentKey = await encryption.importKey(studentMaterial.keyMaterial);
  const oldEmail = email('migration-child'); const oldHash = await encryption.emailLookup(oldEmail);
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, migrationRoot + '/keys/shared'), material);
    await setDoc(doc(db, migrationRoot + '/keys/student_old'), studentMaterial);
    await setDoc(doc(db, migrationRoot), await encryption.encryptRecord({ title: 'Migrated class', description: 'Migration test' }, sharedKey, migrationRoot));
    const path = migrationRoot + '/students/old';
    await setDoc(doc(db, path), { ...await encryption.encryptRecord({ id: 'old', name: 'Old learner', email: oldEmail, currentScore: 3, goalScore: 8, imageKey: null }, studentKey, path), emailHash: oldHash });
    await setDoc(doc(db, path + '/responses/2026-01-02'), await encryption.encryptRecord({ createdAt: '2026-01-02T12:00:00.000Z', items: [] }, studentKey, path + '/responses/2026-01-02'));
    await setDoc(doc(db, 'studentAccess', oldHash), { ownerId: migrationOwner, studentId: 'old' });
    await setDoc(doc(db, 'studentLinks', oldEmail), { ownerId: migrationOwner, studentId: 'old' });
  });
  const migrated = await store.loadClass(migrationAccess);
  assert.equal(migrated.students[0].currentScore, 3); assert(!('email' in migrated.students[0]));
  assert.equal((await store.loadHistory(migrationAccess)).length, 1);
  assert(!(await getDoc(doc(globalThis.packedRulesHarness.db, migrationRoot + '/students/old'))).exists());
  cache.clearReadCache(); before = activity.getReadActivity().requests;
  await store.loadClass(migrationAccess);
  assert.equal(activity.getReadActivity().requests - before, 2);
  delete globalThis.packedRulesHarness;
  console.log(`${checks} security checks plus real-SDK packed storage/migration/multi-part integration passed. Cold loads: 2 reads; completion check: 0; submission: 2.`);
} finally { await env.cleanup(); }
