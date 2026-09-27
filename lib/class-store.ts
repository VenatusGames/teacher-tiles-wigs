import { collection, doc, writeBatch, type Transaction, type DocumentReference } from 'firebase/firestore';
import { getDoc, getDocs, runTransaction } from './firestore-activity';
import { auth, requireDb } from './firebase';
import { decryptRecord, emailLookup, isEncrypted } from './encryption';
import { classKey } from './key-vault';
import { cachedRead, invalidateReads, patchCachedRead } from './read-cache';
import { decodePacked, encodePacked, readPacked, writePacked, type Row, type PackedRows } from './packed-store';
import { emptyData, localDate, personalize, type Access, type AppData, type Student, type HistoryEntry, type HistoryItem } from './model';
import {
  deleteStudentAccessResponse, deleteStudentAccessResponsesForStudent, loadPendingStudentResponses,
  markStudentResponsesImported, mirrorTeacherResponse, syncStudentAccessChange,
} from './student-access';

type ClassState = {
  data: AppData;
  days: Record<string, string[]>;
  cleanupPaths: string[];
  purges: Record<string, string[]>;
};
type Month = { entries: HistoryEntry[] };
const root = (access: Access) => doc(requireDb(), 'classes', access.ownerId);
const records = (access: Access, name: string) => collection(root(access), name);
const monthRef = (access: Access, month: string) => doc(records(access, 'historyMonths'), month);
function requireTeacher(access: Access) {
  if (access.role !== 'teacher' || access.ownerId !== auth?.currentUser?.uid) throw new Error('Only your teacher can change the class.');
}
function text(value: unknown, label: string, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error('Enter ' + label + ' (up to ' + max + ' characters).');
  return value.trim();
}
function imageValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 33000 || (!/^data:image\/jpeg;base64,/.test(value) && !/^preset:(smile|sad|yes|no)$/.test(value))) throw new Error('Choose a smaller picture.');
  return value;
}
function historyImageValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 33000 || (!/^data:image\/jpeg;base64,/.test(value) && !/^preset:(smile|sad|yes|no)$/.test(value) && !/^images\/[A-Za-z0-9._/-]+$/.test(value))) throw new Error('Choose a valid response image.');
  return value;
}
function starter(): ClassState {
  return { data: { ...structuredClone(emptyData),
    questions: [{ id: 'starter', prompt: 'How focused did you feel today?', position: 1, fridayOnly: false }],
    answers: ['Getting Started', 'On My Way', 'Locked In'].map((label, index) => ({ id: 'starter-' + index, questionId: 'starter', label, imageKey: null, position: index + 1 })),
  }, days: {}, cleanupPaths: [], purges: {} };
}
function ordered(data: AppData): AppData {
  return { ...data, students: [...data.students].sort((a, b) => a.name.localeCompare(b.name)),
    questions: [...data.questions].sort((a, b) => a.position - b.position), answers: [...data.answers].sort((a, b) => a.position - b.position) };
}
async function fetchPacked(ref: DocumentReference) { return runTransaction(requireDb(), tx => readPacked(tx, ref)); }
async function stateIn(tx: Transaction, access: Access, key: CryptoKey) {
  const rows = await readPacked(tx, root(access));
  return { rows, state: await decodePacked<ClassState>(rows, key) };
}
async function monthIn(tx: Transaction, access: Access, month: string, key: CryptoKey, expected = false) {
  const rows = await readPacked(tx, monthRef(access, month));
  if (expected && !rows.head.exists()) throw new Error('A history month is missing. No replacement data was saved.');
  return { rows, value: rows.head.exists() ? await decodePacked<Month>(rows, key) : { entries: [] } };
}
const hasMonth = (state: ClassState, month: string) => Object.keys(state.days).some(day => day.startsWith(month + '-'));
function validPublicItems(value: unknown): value is HistoryItem[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 20 && value.every(item => {
    if (!item || typeof item !== 'object') return false;
    const row = item as HistoryItem;
    return typeof row.question === 'string' && row.question.length <= 2200
      && typeof row.answer === 'string' && row.answer.length <= 400
      && (row.imageKey === null || (typeof row.imageKey === 'string'
        && row.imageKey.length <= 33000
        && (/^data:image\/jpeg;base64,/.test(row.imageKey) || /^preset:(smile|sad|yes|no)$/.test(row.imageKey) || /^images\/[A-Za-z0-9._/-]+$/.test(row.imageKey))));
  });
}
async function importStudentResponses(access: Access, initial: ClassState): Promise<ClassState> {
  const pending = await loadPendingStudentResponses(access);
  if (!pending.entries.length) return initial;
  const key = await classKey(access);
  const months = [...new Set(pending.entries.map(entry => entry.id.slice(0, 7)))].filter(month => /^\d{4}-\d{2}$/.test(month));
  const next = await runTransaction(requireDb(), async tx => {
    const current = await stateIn(tx, access, key);
    const archives = new Map<string, Awaited<ReturnType<typeof monthIn>>>();
    for (const month of months) archives.set(month, await monthIn(tx, access, month, key, hasMonth(current.state, month)));
    for (const entry of pending.entries) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.id)) continue;
      const profile = current.state.data.students.find(student => student.id === entry.studentId);
      if (!profile || !validPublicItems(entry.items)) continue;
      if (current.state.days[entry.id]?.includes(entry.studentId)) continue;
      const month = entry.id.slice(0, 7);
      const archive = archives.get(month);
      if (!archive) continue;
      archive.value.entries.push({
        id: entry.id,
        studentId: entry.studentId,
        studentName: profile.name,
        createdAt: Number.isFinite(Date.parse(entry.createdAt)) ? entry.createdAt : `${entry.id}T12:00:00.000Z`,
        items: entry.items.map(item => ({ question: item.question, answer: item.answer, imageKey: historyImageValue(item.imageKey), ...(item.questionId ? { questionId: item.questionId } : {}), ...(item.answerId ? { answerId: item.answerId } : {}) })),
      });
      (current.state.days[entry.id] ??= []).push(entry.studentId);
    }
    for (const [month, archive] of archives) {
      writePacked(tx, archive.rows, await encodePacked(monthRef(access, month), archive.value, key));
    }
    writePacked(tx, current.rows, await encodePacked(root(access), current.state, key));
    return current.state;
  });
  remember(access, next);
  months.forEach(month => invalidateReads(access, 'history:month:' + month));
  await markStudentResponsesImported(pending.entries.map(entry => entry.refPath));
  return next;
}

function remember(access: Access, state: ClassState) {
  patchCachedRead<ClassState>(access, 'class', () => state);
}
export function refreshClassData(access: Access) { invalidateReads(access, 'class'); invalidateReads(access, 'history:'); }

async function loadState(access: Access): Promise<ClassState> {
  requireTeacher(access);
  return cachedRead(access, 'class', async () => {
    const rows = await fetchPacked(root(access));
    const state = rows.head.data()?.storage === 2
      ? await decodePacked<ClassState>(rows, await classKey(access))
      : await convertLegacy(access, rows);
    return finishMaintenance(access, state);
  }, Infinity);
}
export async function loadClass(access: Access): Promise<AppData> {
  let state = await loadState(access);
  while (true) {
    const next = await importStudentResponses(access, state);
    if (next === state) break;
    state = next;
  }
  return ordered(state.data);
}

// Migration freezes the old layout before reading it. Legacy writes are denied
// by the rules once storage='packing', including writes from an older open tab.
// A failed conversion resumes from the frozen source; storage=2 is published last.
async function convertLegacy(access: Access, initial: PackedRows): Promise<ClassState> {
  if (!initial.head.exists()) {
    const key = await classKey(access, undefined, true);
    return runTransaction(requireDb(), async tx => {
      const current = await readPacked(tx, root(access));
      if (current.head.exists()) {
        if (current.head.data()?.storage === 2) return decodePacked<ClassState>(current, key);
        throw new Error('The class changed while opening. Please try again.');
      }
      const state = starter();
      writePacked(tx, current, await encodePacked(root(access), state, key));
      return state;
    });
  }
  const locked = await runTransaction(requireDb(), async tx => {
    const current = await readPacked(tx, root(access));
    if (!current.head.exists()) throw new Error('Your class is no longer available.');
    if (current.head.data()?.storage !== 2 && current.head.data()?.storage !== 'packing') tx.set(root(access), { ...current.head.data(), storage: 'packing' });
    return current;
  });
  if (locked.head.data()?.storage === 2) return decodePacked<ClassState>(locked, await classKey(access));
  const [questions, answers, students] = await Promise.all(['questions', 'answers', 'students'].map(name => getDocs(records(access, name))));
  const sharedEncrypted = [locked.head, ...questions.docs, ...answers.docs].some(row => isEncrypted(row.data()!));
  const shared = await classKey(access, undefined, !sharedEncrypted);
  const legacy = async <T,>(row: Row, key: CryptoKey | undefined): Promise<T> => isEncrypted(row.data()!)
    ? decryptRecord<T>(row.data()!, key!, row.ref.path) : row.data() as T;
  const settings = await legacy<AppData['settings']>(locked.head, shared);
  const state: ClassState = { data: { settings: { title: settings.title, description: settings.description }, students: [], questions: [], answers: [] }, days: {}, cleanupPaths: [], purges: {} };
  state.data.questions = await Promise.all(questions.docs.map(async row => ({ ...await legacy<AppData['questions'][number]>(row, shared), id: row.id })));
  state.data.answers = await Promise.all(answers.docs.map(async row => ({ ...await legacy<AppData['answers'][number]>(row, shared), id: row.id })));
  const months = new Map<string, Month>();
  state.cleanupPaths.push(...questions.docs.map(row => row.ref.path), ...answers.docs.map(row => row.ref.path));
  for (const row of students.docs) {
    const responses = await getDocs(collection(row.ref, 'responses'));
    const encrypted = [row, ...responses.docs].some(item => isEncrypted(item.data()!));
    const key = encrypted ? await classKey(access, row.id) : undefined;
    const old = await legacy<Student & { email?: string }>(row, key);
    const student: Student = { id: row.id, name: old.name, imageKey: old.imageKey ?? null, currentScore: old.currentScore ?? null, goalScore: old.goalScore ?? null };
    state.data.students.push(student);
    state.cleanupPaths.push(row.ref.path, ...responses.docs.map(item => item.ref.path));
    const hash = row.data().emailHash || (old.email ? await emailLookup(old.email) : '');
    const links = [hash ? doc(requireDb(), 'studentAccess', hash) : null, old.email ? doc(requireDb(), 'studentLinks', old.email.trim().toLowerCase()) : null];
    for (const ref of links) {
      if (!ref) continue;
      const link = await getDoc(ref);
      if (link.exists() && link.data().ownerId === access.ownerId && link.data().studentId === row.id) state.cleanupPaths.push(ref.path);
    }
    for (const response of responses.docs) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(response.id)) throw new Error('A legacy check-in has an invalid date. No source records were removed.');
      const oldResponse = await legacy<{ createdAt: any; items: HistoryEntry['items'] }>(response, key);
      const createdAt = typeof oldResponse.createdAt === 'string' ? oldResponse.createdAt : oldResponse.createdAt?.toDate().toISOString() ?? response.id + 'T12:00:00.000Z';
      const month = response.id.slice(0, 7);
      if (!months.has(month)) months.set(month, { entries: [] });
      months.get(month)!.entries.push({ id: response.id, studentId: row.id, studentName: student.name, createdAt, items: oldResponse.items });
      (state.days[response.id] ??= []).push(row.id);
    }
  }
  // Another tab may finish conversion first. Reading the class in each month
  // transaction prevents an unfinished converter from overwriting live history.
  for (const [month, value] of months) {
    await runTransaction(requireDb(), async tx => {
      const currentClass = await tx.get(root(access));
      if (currentClass.data()?.storage === 2) return;
      const old = await readPacked(tx, monthRef(access, month));
      writePacked(tx, old, await encodePacked(monthRef(access, month), value, shared));
    });
  }
  return runTransaction(requireDb(), async tx => {
    const current = await readPacked(tx, root(access));
    if (current.head.data()?.storage === 2) return decodePacked<ClassState>(current, shared);
    writePacked(tx, current, await encodePacked(root(access), state, shared));
    return state;
  });
}

// Cleanup is resumable and happens only once, after the replacement is durable.
async function finishMaintenance(access: Access, initial: ClassState): Promise<ClassState> {
  let state = initial;
  if (!state.cleanupPaths.length && !Object.keys(state.purges).length) return state;
  const key = await classKey(access);
  if (state.cleanupPaths.length) {
    const paths = new Set(state.cleanupPaths);
    for (let start = 0; start < state.cleanupPaths.length; start += 400) {
      const batch = writeBatch(requireDb());
      state.cleanupPaths.slice(start, start + 400).forEach(path => batch.delete(doc(requireDb(), path)));
      await batch.commit();
    }
    state = await runTransaction(requireDb(), async tx => {
      const current = await stateIn(tx, access, key);
      current.state.cleanupPaths = current.state.cleanupPaths.filter(path => !paths.has(path));
      writePacked(tx, current.rows, await encodePacked(root(access), current.state, key));
      return current.state;
    });
  }
  for (const [studentId, months] of Object.entries(state.purges)) {
    for (const month of months) {
      state = await runTransaction(requireDb(), async tx => {
        const current = await stateIn(tx, access, key);
        if (!current.state.purges[studentId]?.includes(month)) return current.state;
        const archive = await monthIn(tx, access, month, key, true);
        archive.value.entries = archive.value.entries.filter(entry => entry.studentId !== studentId);
        writePacked(tx, archive.rows, await encodePacked(monthRef(access, month), archive.value, key));
        current.state.purges[studentId] = current.state.purges[studentId].filter(value => value !== month);
        if (!current.state.purges[studentId].length) delete current.state.purges[studentId];
        writePacked(tx, current.rows, await encodePacked(root(access), current.state, key));
        return current.state;
      });
      invalidateReads(access, 'history:month:' + month);
    }
  }
  return state;
}

function editedHistoryItems(value: unknown): HistoryItem[] {
  if (!validPublicItems(value)) throw new Error('That edited response is invalid.');
  return value.map(item => ({
    question: text(item.question, 'a question', 2200),
    answer: text(item.answer, 'an answer', 400),
    imageKey: historyImageValue(item.imageKey),
    ...(typeof item.questionId === 'string' && item.questionId.length <= 100 ? { questionId: item.questionId } : {}),
    ...(typeof item.answerId === 'string' && item.answerId.length <= 100 ? { answerId: item.answerId } : {}),
  }));
}

export async function changeClass(access: Access, body: Record<string, unknown>) {
  requireTeacher(access);
  await loadState(access);
  const key = await classKey(access);
  const id = String(body.id ?? '');
  // IDs are stable across retries, so transaction retries cannot create duplicates.
  const newId = crypto.randomUUID();
  let editedEntry: HistoryEntry | null = null;
  try {
    let state = await runTransaction(requireDb(), async tx => {
      const current = await stateIn(tx, access, key);
      const state = current.state;
      const data = state.data;
      const student = () => { const found = data.students.find(row => row.id === id); if (!found) throw new Error('That student no longer exists.'); return found; };
      switch (body.action) {
        case 'saveSettings': data.settings = { title: text(body.title, 'a title', 160), description: text(body.description, 'a description', 4000) }; break;
        case 'addStudent': data.students.push({ id: newId, name: text(body.name, 'a student name', 100), imageKey: imageValue(body.imageKey), currentScore: null, goalScore: null }); break;
        case 'updateStudentName': student().name = text(body.name, 'a student name', 100); break;
        case 'updateStudentImage': student().imageKey = imageValue(body.imageKey); break;
        case 'removeStudentImage': student().imageKey = null; break;
        case 'updateStudentScores': {
          if (![body.currentScore, body.goalScore].every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9)) throw new Error('Enter valid scores.');
          Object.assign(student(), { currentScore: body.currentScore, goalScore: body.goalScore }); break;
        }
        case 'deleteStudent': {
          student(); data.students = data.students.filter(row => row.id !== id);
          const months = [...new Set(Object.keys(state.days).filter(day => state.days[day].includes(id)).map(day => day.slice(0, 7)))];
          if (months.length) state.purges[id] = months;
          for (const day of Object.keys(state.days)) { state.days[day] = state.days[day].filter(value => value !== id); if (!state.days[day].length) delete state.days[day]; }
          break;
        }
        case 'addQuestion': data.questions.push({ id: newId, prompt: text(body.prompt, 'a question', 2000), position: Date.now(), fridayOnly: Boolean(body.fridayOnly) }); break;
        case 'setQuestionFridayOnly': {
          const question = data.questions.find(row => row.id === id); if (!question) throw new Error('That question no longer exists.'); question.fridayOnly = Boolean(body.fridayOnly); break;
        }
        case 'deleteQuestion': data.questions = data.questions.filter(row => row.id !== id); data.answers = data.answers.filter(row => row.questionId !== id); break;
        case 'addAnswer': {
          const questionId = String(body.questionId ?? ''); if (!data.questions.some(row => row.id === questionId)) throw new Error('That question no longer exists.');
          data.answers.push({ id: newId, questionId, label: text(body.label, 'an answer', 300), imageKey: imageValue(body.imageKey), position: Date.now() }); break;
        }
        case 'deleteAnswer': data.answers = data.answers.filter(row => row.id !== id); break;
        case 'editResponse': {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) throw new Error('Choose a valid check-in date.');
          const studentId = String(body.studentId);
          const profile = data.students.find(row => row.id === studentId);
          if (!profile) throw new Error('That student no longer exists.');
          const month = id.slice(0, 7);
          const archive = await monthIn(tx, access, month, key, hasMonth(state, month));
          const entry = archive.value.entries.find(row => row.id === id && row.studentId === studentId);
          if (!entry) throw new Error('That check-in no longer exists.');
          entry.studentName = profile.name;
          entry.items = editedHistoryItems(body.items);
          editedEntry = structuredClone(entry);
          writePacked(tx, archive.rows, await encodePacked(monthRef(access, month), archive.value, key)); break;
        }
        case 'deleteResponse': {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) throw new Error('Choose a valid check-in date.');
          const studentId = String(body.studentId); const month = id.slice(0, 7);
          const archive = await monthIn(tx, access, month, key, hasMonth(state, month));
          archive.value.entries = archive.value.entries.filter(entry => entry.id !== id || entry.studentId !== studentId);
          state.days[id] = (state.days[id] ?? []).filter(value => value !== studentId); if (!state.days[id].length) delete state.days[id];
          writePacked(tx, archive.rows, await encodePacked(monthRef(access, month), archive.value, key)); break;
        }
        default: throw new Error('Unknown class action.');
      }
      writePacked(tx, current.rows, await encodePacked(root(access), state, key));
      return state;
    });
    remember(access, state);
    if (body.action === 'deleteResponse' || body.action === 'editResponse') invalidateReads(access, 'history:month:' + id.slice(0, 7));
    state = await finishMaintenance(access, state);
    remember(access, state);
    await syncStudentAccessChange(access, state.data, body, newId);
    if (body.action === 'deleteResponse') await deleteStudentAccessResponse(access, id, String(body.studentId));
    if (body.action === 'editResponse' && editedEntry) await mirrorTeacherResponse(access, editedEntry);
    if (body.action === 'deleteStudent') await deleteStudentAccessResponsesForStudent(access, id);
  } catch (error) { refreshClassData(access); throw error; }
}
export async function completedToday(access: Access, id: string) {
  const state = await loadState(access);
  if (!state.data.students.some(student => student.id === id)) throw new Error('That student no longer exists.');
  return state.days[localDate()]?.includes(id) ?? false;
}
export async function completedTodayStudentIds(access: Access) {
  const state = await loadState(access);
  const valid = new Set(state.data.students.map(student => student.id));
  return (state.days[localDate()] ?? []).filter(id => valid.has(id));
}
function selectionsFor(student: Student, data: AppData, selections: Record<string, string>) {
  const active = data.questions.filter(question => !question.fridayOnly || new Date().getDay() === 5);
  if (!active.length || active.length > 20) throw new Error('The class must have between 1 and 20 questions per check-in.');
  return active.map(question => {
    const answer = data.answers.find(row => row.id === selections[question.id] && row.questionId === question.id);
    if (!answer) throw new Error('Answer every question first.');
    return { question: personalize(question.prompt, student), answer: answer.label, imageKey: answer.imageKey, questionId: question.id, answerId: answer.id };
  });
}
export async function submitResponse(access: Access, student: Student, data: AppData, selections: Record<string, string>) {
  requireTeacher(access);
  selectionsFor(student, data, selections); // Reject partial check-ins without any reads.
  await loadState(access);
  const key = await classKey(access); const day = localDate(); const month = day.slice(0, 7); const createdAt = new Date().toISOString();
  let savedEntry: HistoryEntry | null = null;
  const state = await runTransaction(requireDb(), async tx => {
    const current = await stateIn(tx, access, key);
    const profile = current.state.data.students.find(row => row.id === student.id);
    if (!profile) throw new Error('That student no longer exists.');
    if (current.state.days[day]?.includes(student.id)) throw new Error('You already completed today’s check-in.');
    const items = selectionsFor(profile, current.state.data, selections);
    const archive = await monthIn(tx, access, month, key, hasMonth(current.state, month));
    savedEntry = { id: day, studentId: student.id, studentName: profile.name, createdAt, items };
    archive.value.entries.push(savedEntry);
    (current.state.days[day] ??= []).push(student.id);
    const [monthRows, classRows] = await Promise.all([encodePacked(monthRef(access, month), archive.value, key), encodePacked(root(access), current.state, key)]);
    writePacked(tx, archive.rows, monthRows); writePacked(tx, current.rows, classRows);
    return current.state;
  });
  remember(access, state); invalidateReads(access, 'history:month:' + month);
  if (savedEntry) await mirrorTeacherResponse(access, savedEntry);
}

export type HistoryFilter = { studentId: string; from: string; to: string; order: 'asc' | 'desc'; after?: string };
export function retryHistory(access: Access) { invalidateReads(access, 'history:'); }
async function loadMonth(access: Access, month: string) {
  return cachedRead(access, 'history:month:' + month, async () => {
    const rows = await fetchPacked(monthRef(access, month));
    return decodePacked<Month>(rows, await classKey(access));
  }, Infinity);
}
export async function loadHistoryPage(access: Access, filter: HistoryFilter): Promise<{ entries: HistoryEntry[]; hasMore: boolean; nextCursor?: string }> {
  const state = await loadState(access);
  for (const date of [filter.from, filter.to]) if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose valid dates.');
  if (filter.from && filter.to && filter.from > filter.to) throw new Error('The start date must be before the end date.');
  if (!['asc', 'desc'].includes(filter.order)) throw new Error('Choose a valid sort order.');
  if (filter.studentId !== 'all' && !state.data.students.some(student => student.id === filter.studentId)) throw new Error('That student is no longer available.');
  const names = new Map(state.data.students.map(student => [student.id, student.name]));
  const direction = filter.order === 'asc' ? 1 : -1;
  const ids = Object.entries(state.days).filter(([day]) => (!filter.from || day >= filter.from) && (!filter.to || day <= filter.to))
    .flatMap(([day, students]) => students.filter(id => names.has(id) && (filter.studentId === 'all' || id === filter.studentId)).map(id => day + ':' + id))
    .sort((a, b) => direction * a.localeCompare(b));
  if (filter.after && !/^\d{4}-\d{2}-\d{2}:[A-Za-z0-9-]+$/.test(filter.after)) throw new Error('Invalid history page. Reset the filters.');
  const remaining = filter.after ? ids.filter(id => direction * id.localeCompare(filter.after!) > 0) : ids;
  const page = remaining.slice(0, 10);
  const months = [...new Set(page.map(id => id.slice(0, 7)))];
  const archives = await Promise.all(months.map(month => loadMonth(access, month)));
  const lookup = new Map(archives.flatMap(archive => archive.entries.map(entry => [entry.id + ':' + entry.studentId, entry] as const)));
  const entries = page.map(id => { const entry = lookup.get(id); if (!entry) throw new Error('History changed. Refresh from server to load the latest check-ins.'); return { ...entry, studentName: names.get(entry.studentId)! }; });
  return { entries, hasMore: remaining.length > 10, nextCursor: page.at(-1) };
}
export async function loadHistory(access: Access, studentId?: string): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = []; let after: string | undefined;
  do {
    const page = await loadHistoryPage(access, { studentId: studentId ?? 'all', from: '', to: '', order: 'desc', after });
    entries.push(...page.entries); after = page.hasMore ? page.nextCursor : undefined;
  } while (after);
  return entries;
}

export async function loadAllHistory(access: Access): Promise<HistoryEntry[]> {
  const state = await loadState(access);
  const valid = new Set(state.data.students.map(student => student.id));
  const names = new Map(state.data.students.map(student => [student.id, student.name]));
  const months = [...new Set(Object.keys(state.days).map(day => day.slice(0, 7)))].sort();
  const archives = await Promise.all(months.map(month => loadMonth(access, month)));
  const newestByStudentDay = new Map<string, HistoryEntry>();
  archives.flatMap(archive => archive.entries)
    .filter(entry => valid.has(entry.studentId))
    .forEach(entry => {
      const key = `${entry.id}:${entry.studentId}`;
      const current = newestByStudentDay.get(key);
      if (!current || entry.createdAt > current.createdAt) newestByStudentDay.set(key, entry);
    });
  return [...newestByStudentDay.values()]
    .map(entry => ({ ...entry, studentName: names.get(entry.studentId) ?? entry.studentName }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
