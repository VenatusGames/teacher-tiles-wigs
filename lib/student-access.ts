import {
  collection, doc, getDoc as sdkGetDoc, getDocs as sdkGetDocs, limit, orderBy, query,
  serverTimestamp, setDoc, startAfter, where, writeBatch, type DocumentData, type QueryConstraint,
} from 'firebase/firestore';
import { auth, db, requireDb } from './firebase';
import { getDoc, getDocs } from './firestore-activity';
import { cachedRead, patchCachedRead } from './read-cache';
import { localDate, personalize, type Answer, type AppData, type HistoryEntry, type HistoryItem, type Student } from './model';

export type TeacherAccess = { role: 'teacher'; ownerId: string };
export type PublicStudentAccess = {
  token: string;
  data: AppData;
  completedStudentIds: string[];
};
export type PendingStudentResponse = HistoryEntry & { refPath: string };

type AccessRoot = {
  version: 2;
  ownerId: string;
  active: true;
  title: string;
  description: string;
  studentIds: string[];
  questionIds: string[];
  answerIds: string[];
};

const tokenPattern = /^[A-Za-z0-9_-]{32,96}$/;
const privateConfigRef = (access: TeacherAccess) => doc(requireDb(), 'classes', access.ownerId, 'studentAccess', 'config');
const publicRootRef = (token: string) => {
  if (!db) throw new Error('WIGs is not configured yet.');
  if (!tokenPattern.test(token)) throw new Error('This student link is invalid.');
  return doc(db, 'studentAccess', token);
};

function requireTeacher(access: TeacherAccess) {
  if (access.ownerId !== auth?.currentUser?.uid || !auth.currentUser.emailVerified) throw new Error('Only your teacher can manage student access.');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function studentRecord(student: Student) {
  return {
    name: student.name,
    imageKey: student.imageKey,
    currentScore: student.currentScore,
    goalScore: student.goalScore,
  };
}
function questionRecord(question: AppData['questions'][number]) {
  return { prompt: question.prompt, position: question.position, fridayOnly: question.fridayOnly };
}
function answerRecord(answer: Answer) {
  return { questionId: answer.questionId, label: answer.label, imageKey: answer.imageKey, position: answer.position };
}

export async function getStudentAccessToken(access: TeacherAccess): Promise<string | null> {
  requireTeacher(access);
  return cachedRead(access, 'student-access:config', async () => {
    const snap = await getDoc(privateConfigRef(access));
    const token = snap.data()?.token;
    return typeof token === 'string' && tokenPattern.test(token) ? token : null;
  }, Infinity);
}


export async function ensureStudentAccess(access: TeacherAccess, data: AppData) {
  requireTeacher(access);
  let token = await getStudentAccessToken(access);
  if (!token) {
    token = randomToken();
    await setDoc(privateConfigRef(access), { version: 1, token });
    patchCachedRead<string | null>(access, 'student-access:config', () => token);
  }
  await syncStudentAccess(access, data, token);
  return token;
}


export async function rotateStudentAccess(access: TeacherAccess, data: AppData) {
  requireTeacher(access);
  const oldToken = await getStudentAccessToken(access);
  let responseCopies: Array<{ id: string; data: DocumentData }> = [];
  if (oldToken) {
    const rootRef = publicRootRef(oldToken);
    const [students, questions, answers, responses] = await Promise.all([
      getDocs(collection(rootRef, 'students')),
      getDocs(collection(rootRef, 'questions')),
      getDocs(collection(rootRef, 'answers')),
      getDocs(collection(rootRef, 'responses')),
    ]);
    responseCopies = responses.docs.map(row => ({ id: row.id, data: row.data() }));
    const refs = [...students.docs, ...questions.docs, ...answers.docs, ...responses.docs].map(row => row.ref);
    for (let start = 0; start < refs.length; start += 440) {
      const batch = writeBatch(requireDb());
      refs.slice(start, start + 440).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
    const batch = writeBatch(requireDb());
    batch.delete(rootRef);
    await batch.commit();
  }
  const token = randomToken();
  await setDoc(privateConfigRef(access), { version: 1, token });
  patchCachedRead<string | null>(access, 'student-access:config', () => token);
  await syncStudentAccess(access, data, token);
  if (responseCopies.length) {
    const rootRef = publicRootRef(token);
    for (let start = 0; start < responseCopies.length; start += 440) {
      const batch = writeBatch(requireDb());
      responseCopies.slice(start, start + 440).forEach(row => batch.set(doc(rootRef, 'responses', row.id), row.data));
      await batch.commit();
    }
  }
  return token;
}

export async function syncStudentAccess(access: TeacherAccess, data: AppData, knownToken?: string | null) {
  requireTeacher(access);
  const token = knownToken ?? await getStudentAccessToken(access);
  if (!token) return null;
  const rootRef = publicRootRef(token);
  const previous = await getDoc(rootRef);
  const old = previous.data() as Partial<AccessRoot> | undefined;
  const currentStudentIds = data.students.map(row => row.id);
  const currentQuestionIds = data.questions.map(row => row.id);
  const currentAnswerIds = data.answers.map(row => row.id);
  const operations: Array<(batch: ReturnType<typeof writeBatch>) => void> = [];
  operations.push(batch => batch.set(rootRef, {
    version: 2,
    ownerId: access.ownerId,
    active: true,
    title: data.settings.title,
    description: data.settings.description,
    studentIds: currentStudentIds,
    questionIds: currentQuestionIds,
    answerIds: currentAnswerIds,
  } satisfies AccessRoot));
  data.students.forEach(student => operations.push(batch => batch.set(doc(rootRef, 'students', student.id), studentRecord(student))));
  data.questions.forEach(question => operations.push(batch => batch.set(doc(rootRef, 'questions', question.id), questionRecord(question))));
  data.answers.forEach(answer => operations.push(batch => batch.set(doc(rootRef, 'answers', answer.id), answerRecord(answer))));
  for (const id of old?.studentIds ?? []) if (!currentStudentIds.includes(id)) operations.push(batch => batch.delete(doc(rootRef, 'students', id)));
  for (const id of old?.questionIds ?? []) if (!currentQuestionIds.includes(id)) operations.push(batch => batch.delete(doc(rootRef, 'questions', id)));
  for (const id of old?.answerIds ?? []) if (!currentAnswerIds.includes(id)) operations.push(batch => batch.delete(doc(rootRef, 'answers', id)));
  for (let start = 0; start < operations.length; start += 450) {
    const batch = writeBatch(requireDb());
    operations.slice(start, start + 450).forEach(operation => operation(batch));
    await batch.commit();
  }
  return token;
}


export async function syncStudentAccessChange(access: TeacherAccess, data: AppData, body: Record<string, unknown>, newId: string) {
  requireTeacher(access);
  const token = await getStudentAccessToken(access);
  if (!token) return;
  const rootRef = publicRootRef(token);
  const batch = writeBatch(requireDb());
  const root: AccessRoot = {
    version: 2,
    ownerId: access.ownerId,
    active: true,
    title: data.settings.title,
    description: data.settings.description,
    studentIds: data.students.map(row => row.id),
    questionIds: data.questions.map(row => row.id),
    answerIds: data.answers.map(row => row.id),
  };
  batch.set(rootRef, root);
  const id = String(body.id ?? '');
  switch (body.action) {
    case 'addStudent': {
      const student = data.students.find(row => row.id === newId);
      if (student) batch.set(doc(rootRef, 'students', student.id), studentRecord(student));
      break;
    }
    case 'updateStudentName':
    case 'updateStudentImage':
    case 'removeStudentImage':
    case 'updateStudentScores': {
      const student = data.students.find(row => row.id === id);
      if (student) batch.set(doc(rootRef, 'students', student.id), studentRecord(student));
      break;
    }
    case 'deleteStudent': batch.delete(doc(rootRef, 'students', id)); break;
    case 'addQuestion': {
      const question = data.questions.find(row => row.id === newId);
      if (question) batch.set(doc(rootRef, 'questions', question.id), questionRecord(question));
      break;
    }
    case 'setQuestionFridayOnly': {
      const question = data.questions.find(row => row.id === id);
      if (question) batch.set(doc(rootRef, 'questions', question.id), questionRecord(question));
      break;
    }
    case 'deleteQuestion': {
      batch.delete(doc(rootRef, 'questions', id));
      const oldAnswers = await getDocs(query(collection(rootRef, 'answers'), where('questionId', '==', id)));
      oldAnswers.docs.forEach(row => batch.delete(row.ref));
      break;
    }
    case 'addAnswer': {
      const answer = data.answers.find(row => row.id === newId);
      if (answer) batch.set(doc(rootRef, 'answers', answer.id), answerRecord(answer));
      break;
    }
    case 'deleteAnswer': batch.delete(doc(rootRef, 'answers', id)); break;
    case 'saveSettings':
    case 'deleteResponse':
      break;
    default:
      return;
  }
  await batch.commit();
}

export function studentAccessUrl(token: string) {
  const url = new URL(window.location.href);
  url.hash = '';
  url.search = '';
  url.searchParams.set('student', token);
  return url.toString();
}

export async function loadStudentAccess(token: string): Promise<PublicStudentAccess> {
  const rootRef = publicRootRef(token);
  const root = await sdkGetDoc(rootRef);
  if (!root.exists() || root.data().version !== 2 || root.data().active !== true) throw new Error('This student link is not active. Ask your teacher for the current link.');
  const [studentsSnap, questionsSnap, answersSnap, todaySnap] = await Promise.all([
    sdkGetDocs(collection(rootRef, 'students')),
    sdkGetDocs(collection(rootRef, 'questions')),
    sdkGetDocs(collection(rootRef, 'answers')),
    sdkGetDocs(query(collection(rootRef, 'responses'), where('day', '==', localDate()))),
  ]);
  const data: AppData = {
    settings: { title: String(root.data().title ?? 'Daily WIG Check-In'), description: String(root.data().description ?? '') },
    students: studentsSnap.docs.map(row => ({ id: row.id, ...row.data() } as Student)).sort((a, b) => a.name.localeCompare(b.name)),
    questions: questionsSnap.docs.map(row => ({ id: row.id, ...row.data() } as AppData['questions'][number])).sort((a, b) => a.position - b.position),
    answers: answersSnap.docs.map(row => ({ id: row.id, ...row.data() } as Answer)).sort((a, b) => a.position - b.position),
  };
  return { token, data, completedStudentIds: todaySnap.docs.map(row => String(row.data().studentId ?? '')).filter(Boolean) };
}

function selectedItems(student: Student, data: AppData, selections: Record<string, string>) {
  const activeQuestions = data.questions.filter(question => !question.fridayOnly || new Date().getDay() === 5);
  if (!activeQuestions.length || activeQuestions.length > 20) throw new Error('There are no check-in questions available today.');
  return activeQuestions.map(question => {
    const answer = data.answers.find(row => row.questionId === question.id && row.id === selections[question.id]);
    if (!answer) throw new Error('Answer every question first.');
    return { question: personalize(question.prompt, student), answer: answer.label, imageKey: answer.imageKey, questionId: question.id, answerId: answer.id } satisfies HistoryItem;
  });
}

export async function submitStudentResponse(token: string, student: Student, data: AppData, selections: Record<string, string>) {
  const rootRef = publicRootRef(token);
  const day = localDate();
  const responseRef = doc(rootRef, 'responses', `${day}_${student.id}`);
  const items = selectedItems(student, data, selections);
  try {
    await setDoc(responseRef, {
      version: 1,
      day,
      studentId: student.id,
      studentName: student.name,
      createdAt: serverTimestamp(),
      items,
      imported: false,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'permission-denied') throw new Error('You already completed today’s check-in, or this student link is no longer active.');
    throw error;
  }
}

function historyFromDoc(row: { id: string; data(): DocumentData }): HistoryEntry {
  const value = row.data();
  const createdAt = value.createdAt?.toDate?.().toISOString?.() ?? String(value.createdAt ?? `${value.day}T12:00:00.000Z`);
  return {
    id: String(value.day ?? row.id.slice(0, 10)),
    studentId: String(value.studentId ?? ''),
    studentName: String(value.studentName ?? ''),
    createdAt,
    items: Array.isArray(value.items) ? value.items as HistoryItem[] : [],
  };
}

export async function loadStudentHistoryPage(token: string, studentId: string, afterDay?: string) {
  const rootRef = publicRootRef(token);
  const constraints: QueryConstraint[] = [where('studentId', '==', studentId), orderBy('day', 'desc'), limit(10)];
  if (afterDay) constraints.splice(2, 0, startAfter(afterDay));
  const snap = await sdkGetDocs(query(collection(rootRef, 'responses'), ...constraints));
  const entries = snap.docs.map(historyFromDoc);
  return { entries, hasMore: entries.length === 10, nextCursor: entries.at(-1)?.id };
}

export async function loadPendingStudentResponses(access: TeacherAccess): Promise<{ token: string | null; entries: PendingStudentResponse[] }> {
  requireTeacher(access);
  const token = await getStudentAccessToken(access);
  if (!token) return { token: null, entries: [] };
  const rootRef = publicRootRef(token);
  const snap = await getDocs(query(collection(rootRef, 'responses'), where('imported', '==', false), limit(100)));
  return { token, entries: snap.docs.map(row => ({ ...historyFromDoc(row), refPath: row.ref.path })) };
}

export async function markStudentResponsesImported(paths: string[]) {
  if (!paths.length) return;
  const database = requireDb();
  for (let start = 0; start < paths.length; start += 450) {
    const batch = writeBatch(database);
    paths.slice(start, start + 450).forEach(path => batch.update(doc(database, path), { imported: true }));
    await batch.commit();
  }
}

export async function mirrorTeacherResponse(access: TeacherAccess, entry: HistoryEntry) {
  requireTeacher(access);
  const token = await getStudentAccessToken(access);
  if (!token) return;
  const rootRef = publicRootRef(token);
  await setDoc(doc(rootRef, 'responses', `${entry.id}_${entry.studentId}`), {
    version: 1,
    day: entry.id,
    studentId: entry.studentId,
    studentName: entry.studentName,
    createdAt: entry.createdAt,
    items: entry.items,
    imported: true,
  });
}

export async function deleteStudentAccessResponse(access: TeacherAccess, day: string, studentId: string) {
  requireTeacher(access);
  const token = await getStudentAccessToken(access);
  if (!token) return;
  const rootRef = publicRootRef(token);
  const batch = writeBatch(requireDb());
  batch.delete(doc(rootRef, 'responses', `${day}_${studentId}`));
  await batch.commit();
}

export async function deleteStudentAccessResponsesForStudent(access: TeacherAccess, studentId: string) {
  requireTeacher(access);
  const token = await getStudentAccessToken(access);
  if (!token) return;
  const rootRef = publicRootRef(token);
  const snap = await getDocs(query(collection(rootRef, 'responses'), where('studentId', '==', studentId)));
  for (let start = 0; start < snap.docs.length; start += 450) {
    const batch = writeBatch(requireDb());
    snap.docs.slice(start, start + 450).forEach(row => batch.delete(row.ref));
    await batch.commit();
  }
}
