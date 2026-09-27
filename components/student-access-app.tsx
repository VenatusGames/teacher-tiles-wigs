import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, CalendarDays, Check, ChevronRight, CircleCheckBig, CircleX, Database, Footprints,
  Frown, LoaderCircle, Rows3, Smile, Sprout, Target, UserRound,
} from 'lucide-react';
import { type Answer, type AppData, type HistoryEntry, type HistoryItem, type Question, type Student } from '@/lib/model';
import { loadStudentAccess, loadStudentHistoryPage, submitStudentResponse } from '@/lib/student-access';
import { friendlyError } from '@/lib/firebase';

type Screen = 'students' | 'menu' | 'lead' | 'history';

const presetChoices = [
  { key: 'preset:smile', label: 'Smiley Face', icon: Smile },
  { key: 'preset:sad', label: 'Sad Face', icon: Frown },
  { key: 'preset:yes', label: 'Yes', icon: CircleCheckBig },
  { key: 'preset:no', label: 'No', icon: CircleX },
] as const;

export function StudentAccessApp({ token }: { token: string }) {
  const [data, setData] = useState<AppData | null>(null);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [screen, setScreen] = useState<Screen>('students');
  const [student, setStudent] = useState<Student | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [started, setStarted] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const isFriday = new Date().getDay() === 5;

  const refresh = async () => {
    const access = await loadStudentAccess(token);
    setData(access.data);
    setCompletedIds(new Set(access.completedStudentIds));
    setStudent(current => current ? access.data.students.find(row => row.id === current.id) ?? null : null);
  };

  useEffect(() => {
    void refresh().catch(err => setError(friendlyError(err))).finally(() => setLoading(false));
  }, [token]);

  const activeQuestions = useMemo(
    () => data?.questions.filter(question => !question.fridayOnly || isFriday) ?? [],
    [data?.questions, isFriday],
  );
  const currentQuestion = activeQuestions[questionIndex] ?? null;
  const currentAnswers = data && currentQuestion ? data.answers.filter(answer => answer.questionId === currentQuestion.id) : [];
  const alreadyCheckedIn = student ? completedIds.has(student.id) : false;

  const goHome = () => {
    setScreen('students');
    setStudent(null);
    setAnswers({});
    setQuestionIndex(0);
    setStarted(false);
    setAdvancing(false);
    setError('');
  };
  const chooseStudent = (next: Student) => {
    setStudent(next);
    setScreen('menu');
    setAnswers({});
    setQuestionIndex(0);
    setStarted(false);
    setAdvancing(false);
    setError('');
  };
  const startLead = () => {
    setAnswers({});
    setQuestionIndex(0);
    setStarted(false);
    setAdvancing(false);
    setError('');
    setScreen('lead');
  };
  const openHistory = () => { setError(''); setScreen('history'); };

  const submit = async (nextAnswers: Record<string, string>) => {
    if (!student || !data || activeQuestions.some(question => !nextAnswers[question.id]) || completedIds.has(student.id)) return;
    setSaving(true);
    setError('');
    try {
      await submitStudentResponse(token, student, data, nextAnswers);
      setCompletedIds(previous => new Set(previous).add(student.id));
    } catch (err) {
      setError(friendlyError(err));
      return;
    } finally {
      setSaving(false);
    }
    setCelebrating(true);
    window.setTimeout(() => {
      setCelebrating(false);
      setScreen('menu');
      setAnswers({});
      setQuestionIndex(0);
      setStarted(false);
    }, 1200);
  };

  const chooseAnswer = (question: Question, answerId: string) => {
    if (advancing || saving || alreadyCheckedIn) return;
    const next = { ...answers, [question.id]: answerId };
    setAnswers(next);
    setAdvancing(true);
    window.setTimeout(() => {
      if (questionIndex < activeQuestions.length - 1) {
        setQuestionIndex(index => index + 1);
        setAdvancing(false);
      } else {
        void submit(next).finally(() => setAdvancing(false));
      }
    }, 420);
  };

  if (loading) return <LoadingScreen />;
  if (!data) return <main className="auth-gate"><section className="auth-card"><h1>Student access unavailable</h1><p role="alert">{error || 'Ask your teacher for the current student link.'}</p><button onClick={() => { setLoading(true); setError(''); void refresh().catch(err => setError(friendlyError(err))).finally(() => setLoading(false)); }}>Try again</button></section></main>;

  return <main className="app-shell min-h-screen overflow-x-hidden bg-background text-foreground">
    <header className="site-header">
      <button className="brand-button" onClick={goHome} aria-label="Return to student profiles"><img className="brand-mark brand-image" src="/wigs/favicon.png" alt="" /><span>WIGs</span></button>
      <span className="student-access-label">Student Access</span>
    </header>

    {screen !== 'students' && <button className="back-button" onClick={() => screen === 'menu' ? goHome() : setScreen('menu')}><ArrowLeft /><span>Back</span></button>}
    {error && <div className="error-banner" role="alert">{error}</div>}

    {screen === 'students' && <section className="page-section student-page page-enter">
      <p className="eyebrow">Choose your profile</p>
      <h1>Who is growing a goal today?</h1>
      <p className="intro">Tap your own sticker to check in or view your history.</p>
      {data.students.length ? <div className="student-grid">{data.students.map((row, index) => {
        const complete = completedIds.has(row.id);
        return <button key={row.id} className="student-sticker" onClick={() => chooseStudent(row)} style={{ animationDelay: `${index * 70}ms` }}>
          <span className="student-photo-wrap"><ProfileImage student={row} />{complete && <span className="student-complete-badge" title="Checked in today" aria-label="Checked in today"><Check /></span>}</span>
          <span className="student-name">{row.name}</span>
        </button>;
      })}</div> : <div className="empty-card"><UserRound /><h2>No students yet</h2><p>Ask your teacher to add student profiles.</p></div>}
    </section>}

    {screen === 'menu' && student && <section className="page-section menu-page page-enter">
      <div className="mini-profile"><ProfileImage student={student} /><div><p className="eyebrow">Welcome back</p><h1>{student.name}</h1></div></div>
      <div className="choice-grid">
        <button className="path-card lead-card" onClick={startLead}><LeadBars /><span><strong>Lead Measures</strong><small>{alreadyCheckedIn ? 'Checked in for today' : "Make today's check-in"}</small></span><ChevronRight /></button>
        <button className="path-card history-card" onClick={openHistory}><Rows3 /><span><strong>View history</strong><small>Browse past check-ins</small></span><ChevronRight /></button>
      </div>
    </section>}

    {screen === 'lead' && student && <section className="page-section lead-page page-enter">
      {!started && <div className="lead-heading"><LeadBars /><div><p className="eyebrow">{student.name}&apos;s check-in</p><h1>{data.settings.title}</h1>{currentQuestion && !alreadyCheckedIn && <button type="button" className="survey-start lead-start" onClick={() => setStarted(true)}>START <ChevronRight /></button>}<p>{personalize(data.settings.description, student)}</p></div></div>}
      {alreadyCheckedIn ? <div className="empty-card already-checked-card"><Check /><h2>You&apos;re checked in for today!</h2><p>Your daily check-in is locked, but you can still view your history.</p><button type="button" className="empty-card-action" onClick={openHistory}><Rows3 /> View my history</button></div>
      : currentQuestion && !started ? null
      : currentQuestion ? <div className="question-flow">
        <div className="question-progress" aria-label={`Question ${questionIndex + 1} of ${activeQuestions.length}`}><span>{questionIndex + 1} of {activeQuestions.length}</span><div><i style={{ width: `${((questionIndex + 1) / activeQuestions.length) * 100}%` }} /></div></div>
        <article className={`question-stage ${advancing ? 'is-advancing' : ''}`} key={currentQuestion.id}>
          {currentQuestion.fridayOnly && <span className="friday-question"><CalendarDays /> Friday reflection</span>}
          <h2 className="floating-question">{personalize(currentQuestion.prompt, student)}</h2>
          {currentAnswers.length ? <div className="round-answer-grid">{currentAnswers.map((answer, answerIndex) => {
            const active = answers[currentQuestion.id] === answer.id;
            return <button className={`round-answer-choice ${active ? 'selected' : ''}`} key={answer.id} onClick={() => chooseAnswer(currentQuestion, answer.id)} aria-label={answer.label} aria-pressed={active} disabled={advancing || saving}>
              <AnswerVisual answer={answer} index={answerIndex} />
              {!isFacePreset(answer.imageKey) && <span>{answer.label}</span>}
              {active && <b className="answer-check"><Check /></b>}
            </button>;
          })}</div> : <p className="soft-note floating-note">This question does not have answer choices yet.</p>}
        </article>
        {saving && <div className="saving-checkin"><LoaderCircle className="spin" /> Saving your WIG…</div>}
      </div>
      : data.questions.length ? <div className="empty-card"><CalendarDays /><h2>You&apos;re all caught up</h2><p>There are no questions scheduled for today.</p></div>
      : <div className="empty-card"><LeadBars /><h2>No lead measures yet</h2><p>Your teacher has not added the first question yet.</p></div>}
    </section>}

    {screen === 'history' && student && <section className="page-section history-page page-enter"><div className="history-heading"><Database /><div><p className="eyebrow">Every check-in, together</p><h1>{student.name}&apos;s history</h1></div></div><StudentHistory token={token} student={student} /></section>}

    {celebrating && <div className="celebration" role="status"><span><Check /></span><strong>WIG saved!</strong><small>Nice work, {student?.name}.</small></div>}
  </main>;
}

function StudentHistory({ token, student }: { token: string; student: Student }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const cursor = cursors.at(-1);
  useEffect(() => {
    setLoading(true); setError('');
    void loadStudentHistoryPage(token, student.id, cursor).then(page => {
      setEntries(page.entries); setHasMore(page.hasMore); setNextCursor(page.nextCursor);
    }).catch(err => setError(friendlyError(err))).finally(() => setLoading(false));
  }, [token, student.id, cursor]);
  return <div className="history-browser">
    {error && <p className="history-feedback" role="alert">{error}</p>}
    {loading ? <p className="history-feedback">Loading check-ins…</p> : <>
      <p className="history-summary">{student.name} · Page {cursors.length} · {entries.length} check-in{entries.length === 1 ? '' : 's'}</p>
      {!entries.length && !error && <p className="history-feedback">No check-ins yet.</p>}
      <div className="history-records student-history-records">{entries.map(entry => <article className="student-history-row" key={`${entry.studentId}:${entry.id}`}><strong className="student-history-date">{formatDate(entry.createdAt)}</strong><div className="student-history-answers">{entry.items.map((item, index) => <span className="student-history-answer" key={index}><span className="student-history-question">{item.question}:</span><HistoryAnswer item={item} />{item.imageKey && <span>{item.answer}</span>}</span>)}</div></article>)}</div>
    </>}
    <nav className="history-pagination" aria-label="History pages"><button type="button" disabled={loading || cursors.length === 1} onClick={() => setCursors(previous => previous.slice(0, -1))}>Previous</button><span>Page {cursors.length}</span><button type="button" disabled={loading || !hasMore || !nextCursor} onClick={() => setCursors(previous => [...previous, nextCursor])}>Next</button></nav>
  </div>;
}

function LoadingScreen() { return <main className="loading-screen"><img className="brand-mark brand-image" src="/wigs/favicon.png" alt="" /><h1>WIGs</h1><LoaderCircle className="spin" /><p>Opening student access…</p></main>; }
function ProfileImage({ student }: { student: Student }) { return <span className="student-photo">{student.imageKey ? <img src={student.imageKey} alt="" /> : <span className={`initial-avatar avatar-${Array.from(student.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4}`}>{student.name.slice(0, 1).toUpperCase()}</span>}</span>; }
function AnswerVisual({ answer, index }: { answer: Answer; index: number }) {
  const preset = presetChoices.find(choice => choice.key === answer.imageKey);
  const Icon = preset?.icon ?? [Sprout, Footprints, Target][index % 3];
  return <span className={`answer-visual answer-${index % 3} ${preset ? `preset-visual ${presetToneClass(answer.imageKey)}` : ''}`}>{answer.imageKey && !preset ? <img src={answer.imageKey} alt="" /> : <Icon />}</span>;
}
function LeadBars() { return <span className="lead-bars" aria-label="Three increasing bars"><i /><i /><i /></span>; }
function HistoryAnswer({ item }: { item: HistoryItem }) {
  const preset = presetChoices.find(choice => choice.key === item.imageKey);
  if (preset) { const Icon = preset.icon; return <span className="history-answer" aria-label={item.answer} title={item.answer}><span className={`history-answer-visual preset ${presetToneClass(item.imageKey)}`}><Icon /></span></span>; }
  if (item.imageKey) return <span className="history-answer" aria-label={item.answer} title={item.answer}><span className="history-answer-visual"><img src={item.imageKey} alt={item.answer} /></span></span>;
  return <span className="answer-text-pill">{item.answer}</span>;
}
function personalize(text: string, student: Student) { return text.replace(/\(name\)/gi, student.name).replace(/\(score-a\)/gi, student.currentScore === null ? '—' : String(student.currentScore)).replace(/\(score-b\)/gi, student.goalScore === null ? '—' : String(student.goalScore)); }
function presetToneClass(key: string | null | undefined) {
  if (key === 'preset:smile' || key === 'preset:yes') return 'preset-positive';
  if (key === 'preset:sad') return 'preset-sad';
  if (key === 'preset:no') return 'preset-no';
  return '';
}
function isFacePreset(key: string | null) { return key === 'preset:smile' || key === 'preset:sad'; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
