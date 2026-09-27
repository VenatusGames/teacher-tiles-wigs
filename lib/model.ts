export type Student = { id: string; name: string; imageKey: string | null; currentScore: number | null; goalScore: number | null };
export type Question = { id: string; prompt: string; position: number; fridayOnly: boolean };
export type Answer = { id: string; questionId: string; label: string; imageKey: string | null; position: number };
export type AppData = { settings: { title: string; description: string }; students: Student[]; questions: Question[]; answers: Answer[] };
export type HistoryItem = { question: string; answer: string; imageKey: string | null; questionId?: string; answerId?: string };
export type HistoryEntry = { id: string; studentId: string; studentName: string; createdAt: string; items: HistoryItem[] };
export type Access = { role: 'teacher'; ownerId: string };
export const emptyData: AppData = { settings: { title: 'Daily WIG Check-In', description: 'Pick the picture that best matches your effort today.' }, students: [], questions: [], answers: [] };
export function localDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function personalize(text: string, student: Student) {
  return text.replace(/\(name\)/gi, student.name).replace(/\(score-a\)/gi, student.currentScore === null ? '—' : String(student.currentScore)).replace(/\(score-b\)/gi, student.goalScore === null ? '—' : String(student.goalScore));
}
