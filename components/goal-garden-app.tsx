
import { FormEvent, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getReadActivity, subscribeReadActivity } from '@/lib/firestore-activity';
import {
  ArrowLeft, CalendarDays, Check, ChevronRight, CircleCheckBig, CircleX, Database, Footprints, Frown,
  ImagePlus, LoaderCircle, LogOut, Plus, Rows3, Settings, Smile,
  Sprout, Target, Trash2, UserRound, RefreshCw, Link2, Copy, PieChart, Bug, Pencil,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { type Access, type Student, type Question, type Answer, type AppData, type HistoryEntry, type HistoryItem, emptyData } from '@/lib/model';
import { loadClass, changeClass, loadHistoryPage, retryHistory, type HistoryFilter, completedToday, completedTodayStudentIds, loadAllHistory, submitResponse } from '@/lib/class-store';
import { logOut, friendlyError } from '@/lib/firebase';
import { ensureStudentAccess, getStudentAccessToken, rotateStudentAccess, studentAccessUrl, syncStudentAccess } from '@/lib/student-access';

type Screen = 'students' | 'menu' | 'lead' | 'history';
type ImageUploader = (file: File | null) => Promise<string | null>;

const presetChoices = [
  { key: 'preset:smile', label: 'Smiley Face', icon: Smile },
  { key: 'preset:sad', label: 'Sad Face', icon: Frown },
  { key: 'preset:yes', label: 'Yes', icon: CircleCheckBig },
  { key: 'preset:no', label: 'No', icon: CircleX },
] as const;


export function GoalGardenApp({ access, email }: { access: Access; email: string }) {
  const [data, setData] = useState<AppData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>('students');
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, string>>({});
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [advancing, setAdvancing] = useState(false);
  const [isFriday, setIsFriday] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checkingToday, setCheckingToday] = useState(false);
  const [alreadyCheckedIn, setAlreadyCheckedIn] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [error, setError] = useState('');
  const [adminOpen, setAdminOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [surveyStarted, setSurveyStarted] = useState(false);

  const refresh = useCallback(async () => {
    const next = await loadClass(access);
    const completed = await completedTodayStudentIds(access);
    setData(next);
    setCompletedIds(new Set(completed));
    setReady(true);
    setSelectedStudent((current) => current ? next.students.find((student) => student.id === current.id) ?? null : null);
  }, [access]);

  useEffect(() => {
    refresh().catch(err => setError(friendlyError(err))).finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => { setIsFriday(new Date().getDay() === 5); }, []);

  const activeQuestions = useMemo(
    () => data.questions.filter((question) => !question.fridayOnly || isFriday),
    [data.questions, isFriday],
  );
  const currentQuestion = activeQuestions[currentQuestionIndex] ?? null;
  const currentAnswers = currentQuestion
    ? data.answers.filter((answer) => answer.questionId === currentQuestion.id)
    : [];

  const goHome = () => {
    setSurveyStarted(false);
    setScreen('students');
    setSelectedStudent(null);
    setSelectedAnswers({});
    setCurrentQuestionIndex(0);
    setAdvancing(false);
    setAlreadyCheckedIn(false);
    setError('');
  };

  const chooseStudent = (student: Student) => {
    setSurveyStarted(false);
    setSelectedStudent(student);
    setScreen('menu');
    setSelectedAnswers({});
    setCurrentQuestionIndex(0);
    setAdvancing(false);
    setAlreadyCheckedIn(false);
    setError('');
  };

  const startLeadMeasures = async () => {
    if (!selectedStudent) return;
    setSurveyStarted(false);
    setSelectedAnswers({});
    setCurrentQuestionIndex(0);
    setAdvancing(false);
    setAlreadyCheckedIn(false);
    setCheckingToday(true);
    setError('');
    setScreen('lead');
    try {
      setAlreadyCheckedIn(await completedToday(access, selectedStudent.id));
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'Could not check today’s status.');
    } finally {
      setCheckingToday(false);
    }
  };

  const openHistory = () => {
    if (!selectedStudent) return;
    setScreen('history');
    setError('');
  };

  const submitCheckIn = async (answers = selectedAnswers) => {
    if (!selectedStudent || activeQuestions.some((question) => !answers[question.id])) return;
    setSaving(true);
    setError('');
    try {
      await submitResponse(access, selectedStudent, data, answers);
      setCompletedIds(current => new Set(current).add(selectedStudent.id));
    }
    catch (err) { setError(friendlyError(err)); return; }
    finally { setSaving(false); }
    setCelebrating(true);
    window.setTimeout(() => {
      setCelebrating(false);
      setScreen('menu');
      setSelectedAnswers({});
      setCurrentQuestionIndex(0);
    }, 1200);
  };

  const chooseAnswer = (question: Question, answerId: string) => {
    if (advancing || saving) return;
    const nextAnswers = { ...selectedAnswers, [question.id]: answerId };
    setSelectedAnswers(nextAnswers);
    setAdvancing(true);
    window.setTimeout(() => {
      if (currentQuestionIndex < activeQuestions.length - 1) {
        setCurrentQuestionIndex((index) => index + 1);
        setAdvancing(false);
      } else {
        void submitCheckIn(nextAnswers).finally(() => setAdvancing(false));
      }
    }, 420);
  };


  if (loading) return <LoadingScreen />;
  if (!ready) return <main className="auth-gate"><section className="auth-card">
    <h1>Could not open your class</h1>
    <p role="alert">{error || 'Please try again.'}</p>
    <button onClick={() => { setLoading(true); setError(''); void refresh().catch(err => setError(friendlyError(err))).finally(() => setLoading(false)); }}>Try again</button>
    <button onClick={() => void logOut().catch(err => setError(friendlyError(err)))}>Sign out</button>
  </section></main>;

  return (
    <main className="app-shell min-h-screen overflow-x-hidden bg-background text-foreground">
      <header className="site-header">
        <button className="brand-button" onClick={goHome} aria-label="Return to student profiles">
          <img className="brand-mark brand-image" src="/wigs/favicon.png" alt="" /><span>WIGs</span>
        </button>
        <div className="account-controls"><span className="account-email">{email}</span>
          {screen !== 'lead' && <button className="admin-launch" aria-label="Refresh from server" title="Refresh account and changes from another device" onClick={() => window.dispatchEvent(new Event('wigs:refresh'))}><RefreshCw /></button>}
          {access.role === 'teacher' && <button className="admin-launch" onClick={() => setStatsOpen(true)} aria-label="Open class statistics" title="Class statistics"><PieChart /></button>}
          {access.role === 'teacher' && <button className="admin-launch" onClick={() => setAdminOpen(true)} aria-label="Open admin panel"><Settings /></button>}<button className="admin-launch" onClick={() => void logOut().catch(err => setError(friendlyError(err)))} aria-label="Sign out"><LogOut /></button></div>
      </header>

      {screen !== 'students' && (
        <button className="back-button" onClick={() => setScreen(screen === 'menu' && access.role === 'teacher' ? 'students' : 'menu')}>
          <ArrowLeft /> <span>Back</span>
        </button>
      )}

      {error && <div className="error-banner" role="alert">{error}</div>}

      {screen === 'students' && access.role === 'teacher' && (
        <section className="page-section student-page page-enter">
          <p className="eyebrow">Choose your profile</p>
          <h1>Who is growing a goal today?</h1>
          <p className="intro">Tap your sticker to check in and keep your progress moving.</p>
          {data.students.length ? (
            <div className="student-grid">
              {data.students.map((student, index) => (
                <button key={student.id} className="student-sticker" onClick={() => chooseStudent(student)} style={{ animationDelay: `${index * 70}ms` }}>
                  <span className="student-photo-wrap"><ProfileImage student={student} />{completedIds.has(student.id) && <span className="student-complete-badge" title="Checked in today" aria-label="Checked in today"><Check /></span>}</span>
                  <span className="student-name">{student.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-card"><UserRound /><h2>No students yet</h2><p>Open the admin panel to add the first student profile.</p></div>
          )}
        </section>
      )}

      {screen === 'menu' && selectedStudent && (
        <section className="page-section menu-page page-enter">
          <div className="mini-profile"><ProfileImage student={selectedStudent} /><div><p className="eyebrow">Welcome back</p><h1>{selectedStudent.name}</h1></div></div>
          <div className="choice-grid">
            <button className="path-card lead-card" onClick={startLeadMeasures}>
              <LeadBars /><span><strong>Lead Measures</strong><small>Make today&apos;s check-in</small></span><ChevronRight />
            </button>
            <button className="path-card history-card" onClick={openHistory}>
              <Rows3 /><span><strong>View history</strong><small>Browse past check-ins</small></span><ChevronRight />
            </button>
          </div>
        </section>
      )}

      {screen === 'lead' && selectedStudent && (
        <section className="page-section lead-page page-enter">
          {!surveyStarted && <div className="lead-heading"><LeadBars /><div><p className="eyebrow">{selectedStudent.name}&apos;s check-in</p><h1>{data.settings.title}</h1>{currentQuestion && !checkingToday && !alreadyCheckedIn && <button type="button" className="survey-start lead-start" onClick={() => setSurveyStarted(true)}>START <ChevronRight /></button>}<p>{personalize(data.settings.description, selectedStudent)}</p></div></div>}
          {checkingToday ? (
            <div className="loading-inline"><LoaderCircle className="spin" /> Checking today&apos;s progress…</div>
          ) : alreadyCheckedIn ? (
            <div className="empty-card already-checked-card"><Check /><h2>You&apos;re checked in for today!</h2><p>Come back tomorrow to keep growing your WIG.</p><button type="button" className="empty-card-action" onClick={openHistory}><Rows3 /> View my history</button></div>
          ) : currentQuestion && !surveyStarted ? null : currentQuestion ? (
            <div className="question-flow">
              <div className="question-progress" aria-label={`Question ${currentQuestionIndex + 1} of ${activeQuestions.length}`}>
                <span>{currentQuestionIndex + 1} of {activeQuestions.length}</span>
                <div><i style={{ width: `${((currentQuestionIndex + 1) / activeQuestions.length) * 100}%` }} /></div>
              </div>
              <article className={`question-stage ${advancing ? 'is-advancing' : ''}`} key={currentQuestion.id}>
                {currentQuestion.fridayOnly && <span className="friday-question"><CalendarDays /> Friday reflection</span>}
                <h2 className="floating-question">{personalize(currentQuestion.prompt, selectedStudent)}</h2>
                {currentAnswers.length ? (
                  <div className="round-answer-grid">
                    {currentAnswers.map((answer, answerIndex) => {
                      const active = selectedAnswers[currentQuestion.id] === answer.id;
                      return (
                        <button
                          className={`round-answer-choice ${active ? 'selected' : ''}`}
                          key={answer.id}
                          onClick={() => chooseAnswer(currentQuestion, answer.id)}
                          aria-label={answer.label}
                          aria-pressed={active}
                          disabled={advancing || saving}
                        >
                          <AnswerVisual answer={answer} index={answerIndex} />
                          {!isFacePreset(answer.imageKey) && <span>{answer.label}</span>}
                          {active && <b className="answer-check"><Check /></b>}
                        </button>
                      );
                    })}
                  </div>
                ) : <p className="soft-note floating-note">This question needs answer choices from the admin panel.</p>}
              </article>
              {saving && <div className="saving-checkin"><LoaderCircle className="spin" /> Saving your WIG…</div>}
            </div>
          ) : data.questions.length ? (
            <div className="empty-card"><CalendarDays /><h2>You&apos;re all caught up</h2><p>There are no questions scheduled for today. Friday reflections will appear at the end of the week.</p></div>
          ) : <div className="empty-card"><LeadBars /><h2>No lead measures yet</h2><p>An admin can add the first question and image choices.</p></div>}
        </section>
      )}

      {screen === 'history' && selectedStudent && (
        <section className="page-section history-page page-enter">
          <div className="history-heading"><Database /><div><p className="eyebrow">Every check-in, together</p><h1>{selectedStudent.name}&apos;s history</h1></div></div>
          <HistoryBrowser key={selectedStudent.id} access={access} students={[selectedStudent]} />
        </section>
      )}

      {celebrating && <div className="celebration" role="status"><span><Check /></span><strong>WIG saved!</strong><small>Nice work, {selectedStudent?.name}.</small></div>}

      {screen === 'students' && access.role === 'teacher' && <a className="teacher-tiles-credit" href="https://teachertiles.com" aria-label="Powered by TeacherTiles">
        <img src="/wigs/teacher-tiles.png" alt="" />
        <span>Powered by <strong>TeacherTiles</strong></span>
      </a>}

      <Dialog open={adminOpen} onOpenChange={setAdminOpen}>
        <DialogContent className="admin-dialog" showCloseButton>
          <DialogTitle className="sr-only">WIGs admin panel</DialogTitle>
          {access.role === 'teacher' && <AdminPanel data={data} refresh={refresh} access={access} completedIds={completedIds} debugEnabled={debugEnabled} setDebugEnabled={setDebugEnabled} closeAdmin={() => setAdminOpen(false)} />}
        </DialogContent>
      </Dialog>

      <Dialog open={statsOpen} onOpenChange={setStatsOpen}>
        <DialogContent className="stats-dialog" showCloseButton>
          <DialogTitle className="sr-only">Class statistics</DialogTitle>
          {access.role === 'teacher' && <StatisticsPanel access={access} data={data} completedIds={completedIds} open={statsOpen} debugEnabled={debugEnabled} />}
        </DialogContent>
      </Dialog>
    </main>
  );
}

function LoadingScreen() {
  return <main className="loading-screen"><img className="brand-mark brand-image" src="/wigs/favicon.png" alt="" /><h1>WIGs</h1><LoaderCircle className="spin" /><p>Growing your dashboard…</p></main>;
}

function ProfileImage({ student }: { student: Student }) {
  return <span className="student-photo">{student.imageKey ? <img src={fileUrl(student.imageKey)} alt="" /> : <span className={`initial-avatar avatar-${Array.from(student.id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4}`}>{student.name.slice(0, 1).toUpperCase()}</span>}</span>;
}

function AnswerVisual({ answer, index }: { answer: Answer; index: number }) {
  const preset = presetChoices.find((choice) => choice.key === answer.imageKey);
  const Icon = preset?.icon ?? [Sprout, Footprints, Target][index % 3];
  return <span className={`answer-visual answer-${index % 3} ${preset ? `preset-visual ${presetToneClass(answer.imageKey)}` : ''}`}>{answer.imageKey?.startsWith('images/') ? <img src={fileUrl(answer.imageKey)} alt="" /> : <Icon />}</span>;
}

function LeadBars() {
  return <span className="lead-bars" aria-label="Three increasing bars"><i /><i /><i /></span>;
}

function HistoryAnswer({ item }: { item: HistoryItem | undefined }) {
  if (!item) return <span className="history-empty">—</span>;
  const preset = presetChoices.find((choice) => choice.key === item.imageKey);
  if (preset) {
    const Icon = preset.icon;
    return <span className="history-answer" aria-label={item.answer} title={item.answer}><span className={`history-answer-visual preset ${presetToneClass(item.imageKey)}`}><Icon /></span></span>;
  }
  if (item.imageKey?.startsWith('images/') || item.imageKey?.startsWith('data:image/jpeg;base64,')) {
    return <span className="history-answer" aria-label={item.answer} title={item.answer}><span className="history-answer-visual"><img src={fileUrl(item.imageKey)} alt={item.answer} /></span></span>;
  }
  return <span className="answer-text-pill">{item.answer}</span>;
}

function HistoryBrowser({ access, students, onDelete, onEdit, data }: { access: Access; students: Student[]; onDelete?: (entry: HistoryEntry) => Promise<boolean>; onEdit?: (entry: HistoryEntry, items: HistoryItem[]) => Promise<boolean>; data?: AppData }) {
  const initial: HistoryFilter = { studentId: students[0]?.id ?? '', from: '', to: '', order: 'desc' };
  const [draft, setDraft] = useState<HistoryFilter>(initial);
  const [filter, setFilter] = useState<HistoryFilter>(initial);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editingKey, setEditingKey] = useState('');
  const [editItems, setEditItems] = useState<HistoryItem[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const after = cursors.at(-1);
  const indexLink = /https:\/\/console\.firebase\.google\.com\/[^\s)]+/.exec(error)?.[0]?.replace(/[.,;]+$/, '');

  useEffect(() => {
    const valid = new Set(students.map(student => student.id));
    const nextStudent = onDelete ? (filter.studentId === 'all' || valid.has(filter.studentId) ? filter.studentId : 'all') : (valid.has(filter.studentId) ? filter.studentId : students[0]?.id ?? '');
    if (nextStudent !== filter.studentId) {
      const next = { ...filter, studentId: nextStudent };
      setDraft(next); setFilter(next); setCursors([undefined]);
    }
  }, [students, onDelete, filter]);

  useEffect(() => {
    let active = true;
    setError(''); setLoading(true);
    if (!filter.studentId) { setEntries([]); setHasMore(false); setLoading(false); return; }
    loadHistoryPage(access, { ...filter, after }).then(page => {
      if (active) { setEntries(page.entries); setHasMore(page.hasMore); setNextCursor(page.nextCursor ?? page.entries.at(-1)?.id); }
    }).catch(err => { if (active) { setEntries([]); setHasMore(false); setError(friendlyError(err)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [access, filter, after, revision]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) { setError('Choose an end date on or after the start date.'); return; }
    setEditingKey(''); setCursors([undefined]); setFilter({ ...draft });
  };
  const beginEdit = (entry: HistoryEntry) => {
    setEditingKey(`${entry.id}:${entry.studentId}`);
    setEditItems(entry.items.map(item => ({ ...item })));
    setError('');
  };
  const changeEditItem = (index: number, next: HistoryItem) => setEditItems(items => items.map((item, itemIndex) => itemIndex === index ? next : item));

  return (
    <div className="history-browser">
      <form className="history-filters" onSubmit={apply}>
        {(students.length > 1 || onDelete) && <label>Student<select aria-label="Student" value={draft.studentId} onChange={event => setDraft({ ...draft, studentId: event.target.value })}>{onDelete && <option value="all">All students</option>}{students.map(student => <option key={student.id} value={student.id}>{student.name}</option>)}</select></label>}
        <label>From<input type="date" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
        <label>Through<input type="date" value={draft.to} min={draft.from || undefined} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
        <label>Order<select aria-label="Sort order" value={draft.order} onChange={event => setDraft({ ...draft, order: event.target.value as 'asc' | 'desc' })}><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label>
        <button type="submit" disabled={loading || deleting || savingEdit || !draft.studentId}>Apply filters</button>
        <button type="button" disabled={loading || deleting || savingEdit} onClick={() => { const next = { ...draft, from: '', to: '', order: 'desc' as const }; setDraft(next); setFilter(next); setCursors([undefined]); }}>Reset dates</button>
      </form>
      {error && <div role="alert" className="history-feedback"><p>{error}</p>{indexLink && <p><a href={indexLink} target="_blank" rel="noopener noreferrer">Create the required Firestore index</a>. Wait for it to finish building, then try again.</p>}<button type="button" onClick={() => { retryHistory(access); setRevision(value => value + 1); }}>Try again</button></div>}
      {loading ? <p role="status" className="history-feedback">Loading check-ins…</p> : <>
        <p className="history-summary" role="status">{filter.studentId === 'all' ? 'All students' : students.find(student => student.id === filter.studentId)?.name ?? 'History'} · Page {cursors.length} · {entries.length} check-in{entries.length === 1 ? '' : 's'}</p>
        {!entries.length && !error && <p className="history-feedback">{students.length ? 'No check-ins in this date range. Try different dates or another student.' : 'Add a student to start collecting check-ins.'}</p>}
        <div className="history-records">{entries.map(entry => {
          const key = `${entry.id}:${entry.studentId}`;
          const editing = editingKey === key;
          const profile = students.find(student => student.id === entry.studentId);
          return <details className={`history-record${editing ? ' is-editing' : ''}`} key={key} open={editing ? true : undefined}>
            <summary><span><strong>{filter.studentId === 'all' && <>{entry.studentName} · </>}{formatDate(entry.createdAt)}</strong><small>{editing ? 'Editing this check-in' : `${entry.items.length} answer${entry.items.length === 1 ? '' : 's'} · Select to view`}</small></span></summary>
            {editing ? <div className="history-edit-form">{editItems.map((item, index) => {
              const question = data?.questions.find(row => row.id === item.questionId) ?? (profile ? data?.questions.find(row => personalize(row.prompt, profile) === item.question) : undefined);
              const choices = question ? data?.answers.filter(answer => answer.questionId === question.id) ?? [] : [];
              const selected = choices.find(answer => answer.id === item.answerId) ?? choices.find(answer => answer.label === item.answer && answer.imageKey === item.imageKey);
              return <div className="history-edit-row" key={index}><strong>{item.question}</strong><div>
                {choices.length ? <select value={selected?.id ?? ''} onChange={event => {
                  const answer = choices.find(choice => choice.id === event.target.value);
                  if (answer) changeEditItem(index, { ...item, questionId: question?.id, answerId: answer.id, answer: answer.label, imageKey: answer.imageKey });
                }}><option value="" disabled>Choose an answer</option>{choices.map(answer => <option key={answer.id} value={answer.id}>{answer.label}</option>)}</select>
                : <Input className="admin-input" value={item.answer} maxLength={400} onChange={event => changeEditItem(index, { ...item, answer: event.target.value, imageKey: null, answerId: undefined })} />}
                <span className="history-edit-preview"><HistoryAnswer item={editItems[index]} />{editItems[index].imageKey && <span>{editItems[index].answer}</span>}</span>
              </div></div>;
            })}<div className="history-edit-actions"><Button type="button" className="admin-primary" disabled={savingEdit || editItems.some(item => !item.answer.trim())} onClick={async () => {
              if (!onEdit) return;
              setSavingEdit(true);
              try { if (await onEdit(entry, editItems)) { setEditingKey(''); setRevision(value => value + 1); } }
              catch (err) { setError(friendlyError(err)); }
              finally { setSavingEdit(false); }
            }}><Check /> {savingEdit ? 'Saving…' : 'Save changes'}</Button><Button type="button" className="admin-secondary" disabled={savingEdit} onClick={() => setEditingKey('')}>Cancel</Button></div></div>
            : <dl>{entry.items.map((item, index) => <div key={index}><dt>{item.question}</dt><dd><HistoryAnswer item={item} />{item.imageKey && <span>{item.answer}</span>}</dd></div>)}</dl>}
            {onEdit && !editing && <button type="button" className="history-edit-button" disabled={deleting || savingEdit} onClick={() => beginEdit(entry)}><Pencil /> Edit responses</button>}
            {onDelete && !editing && <button type="button" className="history-remove" disabled={deleting || savingEdit} onClick={async () => {
              setDeleting(true);
              try { if (await onDelete(entry)) { if (entries.length === 1 && cursors.length > 1) setCursors(previous => previous.slice(0, -1)); else setRevision(value => value + 1); } }
              catch (err) { setError(friendlyError(err)); }
              finally { setDeleting(false); }
            }}><Trash2 /> Delete check-in</button>}
          </details>;
        })}</div>
      </>}
      <nav className="history-pagination" aria-label="History pages">
        <button type="button" disabled={loading || deleting || savingEdit || cursors.length === 1} onClick={() => setCursors(previous => previous.slice(0, -1))}>Previous</button>
        <span>Page {cursors.length}</span>
        <button type="button" disabled={loading || deleting || savingEdit || !hasMore || !entries.length} onClick={() => setCursors(previous => [...previous, nextCursor])}>Next</button>
      </nav>
    </div>
  );
}


type StatsRange = '7' | '30' | 'all';

function StatisticsPanel({ access, data, completedIds, open, debugEnabled }: { access: Access; data: AppData; completedIds: Set<string>; open: boolean; debugEnabled: boolean }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [range, setRange] = useState<StatsRange>('30');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true); setError('');
    void loadAllHistory(access).then(rows => { if (active) setEntries(rows); })
      .catch(err => { if (active) setError(friendlyError(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [access, open]);

  const cutoff = useMemo(() => {
    if (range === 'all') return '';
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - (Number(range) - 1));
    return statsDateKey(date);
  }, [range]);
  const filtered = useMemo(() => cutoff ? entries.filter(entry => entry.id >= cutoff) : entries, [entries, cutoff]);
  const studentCounts = useMemo(() => data.students.map(student => ({ student, count: filtered.filter(entry => entry.studentId === student.id).length })).sort((a, b) => b.count - a.count || a.student.name.localeCompare(b.student.name)), [data.students, filtered]);
  const classResponses = useMemo(() => {
    let affirmative = 0;
    let negative = 0;
    const negativeSources: Array<{
      studentName: string;
      studentId: string;
      date: string;
      createdAt: string;
      question: string;
      answer: string;
      imageKey: string | null;
      answerId?: string;
      questionId?: string;
      resolvedImageKey: string | null;
    }> = [];

    const answerById = new Map(data.answers.map(answer => [answer.id, answer] as const));

    filtered.forEach(entry => entry.items.forEach(item => {
      const currentAnswer = item.answerId ? answerById.get(item.answerId) : undefined;
      const resolvedImageKey = currentAnswer?.imageKey ?? item.imageKey;
      const normalizedAnswer = (currentAnswer?.label ?? item.answer).trim().toLowerCase();
      const positive = resolvedImageKey === 'preset:smile' || resolvedImageKey === 'preset:yes' || (!resolvedImageKey && (normalizedAnswer === 'smiley face' || normalizedAnswer === 'yes'));
      const isNegative = resolvedImageKey === 'preset:sad' || resolvedImageKey === 'preset:no' || (!resolvedImageKey && (normalizedAnswer === 'sad face' || normalizedAnswer === 'no'));

      if (positive) affirmative += 1;
      else if (isNegative) {
        negative += 1;
        negativeSources.push({
          studentName: entry.studentName,
          studentId: entry.studentId,
          date: entry.id,
          createdAt: entry.createdAt,
          question: item.question,
          answer: item.answer,
          imageKey: item.imageKey,
          answerId: item.answerId,
          questionId: item.questionId,
          resolvedImageKey,
        });
      }
    }));

    const total = affirmative + negative;
    return { affirmative, negative, total, percentage: total ? Math.round((affirmative / total) * 100) : null, negativeSources };
  }, [data.answers, filtered]);
  const timeline = useMemo(() => buildStatsTimeline(entries, range), [entries, range]);
  const maxTimeline = Math.max(1, ...timeline.map(row => row.count));
  const maxStudent = Math.max(1, ...studentCounts.map(row => row.count));
  const classPercentage = classResponses.percentage;
  const classDonut = classPercentage === null
    ? '#e7f4eb'
    : `conic-gradient(#65a30d 0 ${classPercentage}%, #dc2626 ${classPercentage}% 100%)`;
  const todayRate = data.students.length ? Math.round((completedIds.size / data.students.length) * 100) : 0;
  const average = data.students.length ? filtered.length / data.students.length : 0;

  return <div className="stats-panel">
    <div className="stats-topbar"><div><p className="eyebrow">Class pulse</p><h2>Response statistics</h2><p>See participation and response patterns at a glance.</p></div><PieChart /></div>
    <div className="stats-range-controls" aria-label="Statistics range">
      <button className={range === '7' ? 'active' : ''} onClick={() => setRange('7')}>7 days</button>
      <button className={range === '30' ? 'active' : ''} onClick={() => setRange('30')}>30 days</button>
      <button className={range === 'all' ? 'active' : ''} onClick={() => setRange('all')}>All time</button>
    </div>
    <div className="stats-scroll">
      {error && <p className="history-feedback" role="alert">{error}</p>}
      {loading ? <div className="stats-loading"><LoaderCircle className="spin" /> Building your class snapshot…</div> : <>
        <div className="stats-cards">
          <article><small>Check-ins</small><strong>{filtered.length}</strong><span>{range === 'all' ? 'all time' : `last ${range} days`}</span></article>
          <article><small>Average</small><strong>{average.toFixed(1)}</strong><span>check-ins per student</span></article>
          <article><small>Today</small><strong>{completedIds.size}/{data.students.length}</strong><span>checked in</span></article>
        </div>
        <div className="stats-visual-grid">
          <article className="stats-card stats-today-card"><div className="stats-card-heading"><div><small>Today&apos;s participation</small><h3>{todayRate}% complete</h3></div></div><div className="stats-ring" style={{ background: `conic-gradient(#65a30d 0 ${todayRate}%, #e7f4eb ${todayRate}% 100%)` }}><span><strong>{completedIds.size}</strong><small>of {data.students.length}</small></span></div><p>{data.students.length ? `${Math.max(0, data.students.length - completedIds.size)} student${data.students.length - completedIds.size === 1 ? '' : 's'} still to check in today.` : 'Add students to begin tracking participation.'}</p></article>
          <article className="stats-card stats-timeline-card"><div className="stats-card-heading"><div><small>{range === 'all' ? 'Monthly activity' : 'Daily activity'}</small><h3>Check-ins over time</h3></div></div><div className="stats-bars">{timeline.map((row, index) => <div className="stats-bar-column" key={row.key} title={`${row.label}: ${row.count}`}><div><i style={{ height: `${Math.max(row.count ? 10 : 2, (row.count / maxTimeline) * 100)}%`, animationDelay: `${index * 35}ms` }} /></div><span>{row.short}</span></div>)}</div></article>
          <article className="stats-card stats-answer-card">
            <div className="stats-card-heading"><div><small>Class Percentage</small><h3>Positive response score</h3></div></div>
            <div className="stats-donut-wrap">
              <div className="stats-donut" style={{ background: classDonut }}><span><strong>{classPercentage === null ? '—' : `${classPercentage}%`}</strong><small>class score</small></span></div>
              <div className="stats-legend">
                <div><i style={{ background: '#65a30d' }} /><span>Affirmative · Smiley Face + Yes</span><strong>{classResponses.affirmative}</strong></div>
                <div><i style={{ background: '#dc2626' }} /><span>Negative · Sad Face + No</span><strong>{classResponses.negative}</strong></div>
                <p className="stats-class-note">100% means every scored response in this range was affirmative. Negative responses lower the class percentage.</p>
              </div>
            </div>
            {debugEnabled && classResponses.negativeSources.length > 0 && <div className="stats-negative-audit">
              <strong>Negative response audit</strong>
              <p>Debug mode is showing every response currently counted as negative.</p>
              {classResponses.negativeSources.map((source, index) => <div className="stats-negative-audit-row" key={`${source.studentId}-${source.date}-${source.answerId ?? index}`}>
                <span><b>Student:</b> {source.studentName} <small>({source.studentId})</small></span>
                <span><b>Date:</b> {source.date}</span>
                <span><b>Saved:</b> {formatDate(source.createdAt)}</span>
                <span><b>Question:</b> {source.question}</span>
                <span><b>Answer:</b> {source.answer}</span>
                <span><b>Stored imageKey:</b> {source.imageKey ?? 'null'}</span>
                <span><b>Resolved imageKey:</b> {source.resolvedImageKey ?? 'null'}</span>
                <span><b>answerId:</b> {source.answerId ?? 'none'}</span>
                <span><b>questionId:</b> {source.questionId ?? 'none'}</span>
              </div>)}
            </div>}
          </article>
          <article className="stats-card stats-students-card"><div className="stats-card-heading"><div><small>Participation by student</small><h3>Check-in activity</h3></div></div><div className="stats-student-bars">{studentCounts.length ? studentCounts.map((row, index) => <div key={row.student.id}><span>{row.student.name}</span><div><i style={{ width: `${(row.count / maxStudent) * 100}%`, animationDelay: `${index * 45}ms` }} /></div><strong>{row.count}</strong></div>) : <p className="stats-empty">Add students to see participation.</p>}</div></article>
        </div>
      </>}
    </div>
  </div>;
}

function statsDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildStatsTimeline(entries: HistoryEntry[], range: StatsRange) {
  if (range === 'all') {
    const counts = new Map<string, number>();
    entries.forEach(entry => counts.set(entry.id.slice(0, 7), (counts.get(entry.id.slice(0, 7)) ?? 0) + 1));
    return [...counts.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 12).map(([key, count]) => {
      const [year, month] = key.split('-').map(Number);
      const date = new Date(year, month - 1, 1);
      return { key, count, label: new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date), short: new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date) };
    });
  }
  const days = Number(range);
  const counts = new Map(entries.map(() => ['', 0] as [string, number]));
  entries.forEach(entry => counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - index);
    const key = statsDateKey(date);
    return { key, count: counts.get(key) ?? 0, label: new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date), short: days <= 7 ? new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(date) : String(date.getDate()) };
  });
}

function ReadActivity() {
  const activity = useSyncExternalStore(subscribeReadActivity, getReadActivity);
  return <details className="read-activity"><summary>Database activity in this tab: {activity.requests} read requests</summary><p>{activity.documents} documents returned · {activity.errors} failed requests · {activity.pending} pending</p><p>Last request: {activity.lastRequest ? new Date(activity.lastRequest).toLocaleTimeString() : 'None'}. Counts start when this page loads. Cached menu visits do not increase them. Firebase’s total also includes security-rule reads, minimum query charges, and other tabs/devices.</p></details>;
}

function AdminPanel({ data, refresh, access, completedIds, debugEnabled, setDebugEnabled, closeAdmin }: { data: AppData; refresh: () => Promise<void>; access: Access; completedIds: Set<string>; debugEnabled: boolean; setDebugEnabled: (enabled: boolean) => void; closeAdmin: () => void }) {
  const [tab, setTab] = useState<'students' | 'measures' | 'history' | 'access'>('students');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [successNotice, setSuccessNotice] = useState(false);

  useEffect(() => {
    if (!message || !successNotice) return;
    const timer = window.setTimeout(() => { setMessage(''); setSuccessNotice(false); }, 3500);
    return () => window.clearTimeout(timer);
  }, [message, successNotice]);


  const action = async (body: Record<string, unknown>, success = 'Saved!') => {
    setBusy(true); setMessage(''); setSuccessNotice(false);
    try { await changeClass(access, body); await refresh(); setSuccessNotice(true); setMessage(success); return true; }
    catch (err) { setMessage(friendlyError(err)); return false; }
    finally { setBusy(false); }
  };

  const upload: ImageUploader = async (file) => {
    if (!file) return null;
    setBusy(true);
    setMessage('Preparing image…');
    setSuccessNotice(false);
    try {
      const preparedFile = await prepareImageForUpload(file);
      return await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read this picture.')); reader.readAsDataURL(preparedFile); });
    } finally {
      setBusy(false);
      setMessage('');
    }
  };

  const deleteCheckIn = async (entry: HistoryEntry) => {
    if (!window.confirm(`Delete ${entry.studentName}'s check-in from ${formatDate(entry.createdAt)}? This cannot be undone.`)) return false;
    return action({ action: 'deleteResponse', id: entry.id, studentId: entry.studentId }, 'Check-in deleted.');
  };
  const editCheckIn = async (entry: HistoryEntry, items: HistoryItem[]) => action({ action: 'editResponse', id: entry.id, studentId: entry.studentId, items }, 'Student responses updated.');
  const toggleDebug = () => {
    if (debugEnabled) { setDebugEnabled(false); return; }
    const password = window.prompt('Enter the debug password.');
    if (password === null) return;
    if (password !== 'admindebug') { window.alert('Incorrect debug password.'); return; }
    setDebugEnabled(true);
  };
  return (
    <div className="admin-panel">
      <div className="admin-topbar"><div><p className="eyebrow">WIGs</p><h2>Admin panel</h2></div><button type="button" className={`admin-debug-toggle${debugEnabled ? ' active' : ''}`} onClick={toggleDebug}><Bug /> Debug</button></div>
      <p className="template-help">Use Save or Add to keep your changes. Leaving a section discards its unsaved edits.</p>
      <nav className="admin-tabs" aria-label="Admin sections">
        <button className={tab === 'students' ? 'active' : ''} onClick={() => setTab('students')}><UserRound /> Students</button>
        <button className={tab === 'measures' ? 'active' : ''} onClick={() => setTab('measures')}><LeadBars /> Lead Measures</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><Database /> History</button>
        <button className={tab === 'access' ? 'active' : ''} onClick={() => setTab('access')}><Link2 /> Student Access</button>
      </nav>
      {message && <p key={message} className={`form-message${successNotice ? ' form-message-success' : ''}`} role="status">{message}</p>}
      <div className="admin-scroll">
        {debugEnabled && <ReadActivity />}
        {tab === 'students' && <StudentsAdmin students={data.students} completedIds={completedIds} busy={busy} upload={upload} action={action} closeAdmin={closeAdmin} />}
        {tab === 'measures' && <MeasuresAdmin data={data} busy={busy} upload={upload} action={action} />}
        {tab === 'history' && <section className="admin-section"><div className="section-title"><div><p className="eyebrow">Past check-ins</p><h3>Student history</h3></div></div><HistoryBrowser access={access} students={data.students} data={data} onDelete={deleteCheckIn} onEdit={editCheckIn} /></section>}
        {tab === 'access' && <StudentAccessAdmin access={access} data={data} refreshClass={refresh} />}
      </div>
    </div>
  );
}


function StudentAccessAdmin({ access, data, refreshClass }: { access: Access; data: AppData; refreshClass: () => Promise<void> }) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let live = true;
    void getStudentAccessToken(access).then(value => { if (live) setToken(value); })
      .catch(err => { if (live) setMessage(friendlyError(err)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [access]);

  const create = async () => {
    setBusy(true); setMessage('');
    try {
      const value = await ensureStudentAccess(access, data);
      setToken(value);
      setMessage('Student link is ready.');
    } catch (err) { setMessage(friendlyError(err)); }
    finally { setBusy(false); }
  };

  const refresh = async () => {
    if (!token) return;
    setBusy(true); setMessage('');
    try {
      await syncStudentAccess(access, data, token);
      setMessage('Student view refreshed.');
    } catch (err) { setMessage(friendlyError(err)); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(studentAccessUrl(token));
      setMessage('Student link copied.');
    } catch {
      setMessage('Copy was blocked by the browser. Select and copy the link below.');
    }
  };

  const replaceLink = async () => {
    if (!token) return;
    if (!window.confirm('Kill the current student link and generate a new one? The old link will stop working immediately. This cannot be undone.')) return;
    setBusy(true); setMessage('');
    try {
      await refreshClass();
      const value = await rotateStudentAccess(access, data);
      setToken(value);
      setMessage('The old link was disabled and a new student link was generated.');
    } catch (err) { setMessage(friendlyError(err)); }
    finally { setBusy(false); }
  };

  const url = token ? studentAccessUrl(token) : '';
  return <section className="admin-section student-access-admin">
    <div className="section-title"><div><p className="eyebrow">No student login</p><h3>Student Access</h3></div></div>
    <p className="template-help">Create one class link and share the same link with every student. Students choose their own face, complete one check-in per day, and can view their own selected profile&apos;s history. The admin panel is never shown in student mode.</p>
    <p className="student-access-warning">You are responsible for keeping this link private and secure. Do not give out this link to anyone.</p>
    {loading ? <p className="history-feedback">Checking for an existing student link…</p> : token ? <>
      <label className="student-access-link-label">Static student link
        <div className="student-access-link-row"><Input className="admin-input" value={url} readOnly onFocus={event => event.currentTarget.select()} /><Button type="button" className="admin-primary" onClick={copy}><Copy /> Copy</Button></div>
      </label>
      <div className="student-access-actions"><Button type="button" className="admin-secondary" disabled={busy} onClick={refresh}><RefreshCw /> Refresh student view</Button><Button type="button" className="student-access-danger" disabled={busy} onClick={replaceLink}><Trash2 /> Kill old link & generate new</Button></div>
      <p className="template-help">This URL stays the same. Changes to students, questions, answer choices, and scores are automatically republished after you save them.</p>
    </> : <Button type="button" className="admin-primary" disabled={busy} onClick={create}><Link2 /> {busy ? 'Creating…' : 'Generate student link'}</Button>}
    {message && <p className="form-message" role="status">{message}</p>}
  </section>;
}

function StudentsAdmin({ students, completedIds, busy, upload, action, closeAdmin }: { students: Student[]; completedIds: Set<string>; busy: boolean; upload: ImageUploader; action: (body: Record<string, unknown>, success?: string) => Promise<boolean>; closeAdmin: () => void }) {
  const [name, setName] = useState(''); const [file, setFile] = useState<File | null>(null); const [key, setKey] = useState(0);
  const add = async (event: FormEvent) => { event.preventDefault(); try { const imageKey = await upload(file); if (await action({ action: 'addStudent', name, imageKey }, `${name} was added.`)) { setName(''); setFile(null); setKey((value) => value + 1); } } catch (error) { window.alert(error instanceof Error ? error.message : 'Upload failed.'); } };
  return <section className="admin-section"><div className="section-title"><div><p className="eyebrow">Profiles</p><h3>Add a student</h3></div><span className="count-pill">{students.length} students</span></div><form className="admin-form-row" onSubmit={add}><Input className="admin-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Student initials or first name" required maxLength={100} /><FilePicker key={key} label={file?.name ?? 'Choose picture'} onFile={setFile} /><Button className="admin-primary" type="submit" disabled={busy || !name.trim()}><Plus /> Add student</Button></form><div className="admin-student-list">{students.map((student) => <StudentAdminCard key={student.id} student={student} complete={completedIds.has(student.id)} busy={busy} upload={upload} action={action} closeAdmin={closeAdmin} />)}</div></section>;
}

function StudentAdminCard({ student, complete, busy, upload, action, closeAdmin }: { student: Student; complete: boolean; busy: boolean; upload: ImageUploader; action: (body: Record<string, unknown>, success?: string) => Promise<boolean>; closeAdmin: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(student.name);
  const [currentScore, setCurrentScore] = useState(student.currentScore === null ? '' : String(student.currentScore));
  const [goalScore, setGoalScore] = useState(student.goalScore === null ? '' : String(student.goalScore));
  useEffect(() => { if (!editingName) setNameDraft(student.name); }, [student.name, editingName]);
  useEffect(() => {
    setCurrentScore(student.currentScore === null ? '' : String(student.currentScore));
    setGoalScore(student.goalScore === null ? '' : String(student.goalScore));
  }, [student.currentScore, student.goalScore]);
  const replaceImage = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const imageKey = await upload(file);
      if (!imageKey) return;
      if (await action({ action: 'updateStudentImage', id: student.id, imageKey }, 'Student picture saved.')) closeAdmin();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Image update failed.');
    } finally {
      setUploading(false);
    }
  };
  const removeImage = async () => {
    if (!student.imageKey || busy || uploading) return;
    await action({ action: 'updateStudentImage', id: student.id, imageKey: null }, 'Student picture removed.');
  };
  const saveName = async () => {
    const nextName = nameDraft.trim();
    if (!nextName || nextName === student.name) {
      setNameDraft(student.name);
      setEditingName(false);
      return;
    }
    if (await action({ action: 'updateStudentName', id: student.id, name: nextName }, `${student.name} was renamed to ${nextName}.`)) {
      setEditingName(false);
    }
  };
  const saveScores = () => action({ action: 'updateStudentScores', id: student.id, currentScore: Number(currentScore), goalScore: Number(goalScore) }, `${student.name}'s scores were saved.`);
  return (
    <div className="admin-student">
      <span className="student-photo-wrap admin-student-photo-wrap"><ProfileImage student={student} />{complete && <span className="student-complete-badge" title="Checked in today" aria-label="Checked in today"><Check /></span>}</span>
      {editingName ? (
        <form onSubmit={event => { event.preventDefault(); void saveName(); }}>
        <Input
          className="admin-input student-name-input"
          value={nameDraft}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setNameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); setNameDraft(student.name); setEditingName(false); }
          }}
          aria-label={`Edit ${student.name}'s name`}
        />
        <Button type="submit" className="admin-secondary" disabled={busy || !nameDraft.trim()}>Save name</Button>
        <button type="button" onClick={() => { setNameDraft(student.name); setEditingName(false); }}>Cancel</button>
        </form>
      ) : (
        <strong
          className="admin-student-name"
          tabIndex={0}
          title="Double-click to edit name"
          aria-label={`${student.name}. Double-click or press Enter to edit.`}
          onDoubleClick={() => setEditingName(true)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'F2') setEditingName(true); }}
        >{student.name}</strong>
      )}
      <Button variant="destructive" size="icon" aria-label={`Delete ${student.name}`} onClick={() => action({ action: 'deleteStudent', id: student.id }, `${student.name} was removed.`)}><Trash2 /></Button>
      <div className="student-photo-actions">
        <button
          type="button"
          className="file-picker existing-student-photo-button"
          disabled={busy || uploading}
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.jpg,.jpeg,.png,image/jpeg,image/png';
            input.style.position = 'fixed';
            input.style.left = '-10000px';
            input.style.top = '0';
            input.style.width = '1px';
            input.style.height = '1px';
            input.style.opacity = '0';
            input.onchange = () => {
              const file = input.files?.[0] ?? null;
              input.remove();
              if (file) void replaceImage(file);
            };
            input.oncancel = () => input.remove();
            document.body.appendChild(input);
            closeAdmin();
            window.setTimeout(() => input.click(), 180);
          }}
        ><ImagePlus /><span>{uploading ? 'Preparing…' : 'Change picture'}</span></button>
        {student.imageKey && <button type="button" disabled={busy || uploading} onClick={() => void removeImage()}>Remove</button>}
      </div>
      <div className="student-score-editor">
        <label>Current Score<Input className="admin-input" type="number" step="any" value={currentScore} onChange={(event) => setCurrentScore(event.target.value)} placeholder="0" /></label>
        <label>Goal Score<Input className="admin-input" type="number" step="any" value={goalScore} onChange={(event) => setGoalScore(event.target.value)} placeholder="0" /></label>
        <Button type="button" className="admin-secondary" disabled={busy || currentScore === '' || goalScore === '' || (Number(currentScore) === student.currentScore && Number(goalScore) === student.goalScore)} onClick={saveScores}><Check /> Save scores</Button>
      </div>
    </div>
  );
}

function MeasuresAdmin({ data, busy, upload, action }: { data: AppData; busy: boolean; upload: ImageUploader; action: (body: Record<string, unknown>, success?: string) => Promise<boolean> }) {
  const [title, setTitle] = useState(data.settings.title);
  const [description, setDescription] = useState(data.settings.description);
  const [prompt, setPrompt] = useState('');
  const [fridayOnly, setFridayOnly] = useState(false);
  useEffect(() => { setTitle(data.settings.title); setDescription(data.settings.description); }, [data.settings.title, data.settings.description]);
  const addQuestion = async (event: FormEvent) => {
    event.preventDefault();
    if (data.questions.length >= 20) return;
    if (await action({ action: 'addQuestion', prompt, fridayOnly }, 'Question added.')) {
      setPrompt('');
      setFridayOnly(false);
    }
  };

  return (
    <div className="admin-measures">
      <section className="admin-section">
        <div className="section-title"><div><p className="eyebrow">Student intro</p><h3>Lead measure heading</h3></div></div>
        <div className="settings-form">
          <label>Title<Input className="admin-input" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Description<Textarea className="admin-textarea" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <p className="template-help">Use <code>(name)</code>, <code>(score-a)</code>, and <code>(score-b)</code> to personalize descriptions and questions for each student. Line breaks are preserved.</p>
          <Button className="admin-primary" disabled={busy || (title === data.settings.title && description === data.settings.description)} onClick={() => action({ action: 'saveSettings', title, description }, 'Heading updated.')}><Check /> Save heading</Button>
        </div>
      </section>
      <section className="admin-section">
        <div className="section-title"><div><p className="eyebrow">Question builder</p><h3>Questions & image choices</h3></div><span className="count-pill">{data.questions.length} questions</span></div>
        <form className="admin-form-row question-add-form" onSubmit={addQuestion}>
          <Input className="admin-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Type a new question" maxLength={2000} required />
          <label className="friday-option">
            <Checkbox checked={fridayOnly} onCheckedChange={(checked) => setFridayOnly(checked)} />
            <span><strong>Fridays only</strong><small>Ask at the end of the week</small></span>
          </label>
          <Button type="submit" className="admin-primary" disabled={busy || !prompt.trim() || data.questions.length >= 20}><Plus /> Add question</Button>
        </form>
        <div className="question-builder-list">
          {data.questions.map((question, index) => <QuestionBuilder key={question.id} question={question} index={index} answers={data.answers.filter((answer) => answer.questionId === question.id)} busy={busy} upload={upload} action={action} />)}
        </div>
      </section>
    </div>
  );
}

function QuestionBuilder({ question, index, answers, busy, upload, action }: { question: Question; index: number; answers: Answer[]; busy: boolean; upload: ImageUploader; action: (body: Record<string, unknown>, success?: string) => Promise<boolean> }) {
  const [scheduleDraft, setScheduleDraft] = useState(Boolean(question.fridayOnly));
  useEffect(() => { setScheduleDraft(Boolean(question.fridayOnly)); }, [question.fridayOnly]);
  const [label, setLabel] = useState(''); const [file, setFile] = useState<File | null>(null); const [key, setKey] = useState(0); const [presetKey, setPresetKey] = useState('');
  const addAnswer = async (event: FormEvent) => { event.preventDefault(); try { const uploadedKey = await upload(file); const imageKey = uploadedKey || presetKey || null; if (await action({ action: 'addAnswer', questionId: question.id, label, imageKey }, 'Answer choice added.')) { setLabel(''); setFile(null); setPresetKey(''); setKey((value) => value + 1); } } catch (error) { window.alert(error instanceof Error ? error.message : 'Upload failed.'); } };
  const choosePreset = (choice: typeof presetChoices[number]) => { setPresetKey(choice.key); setFile(null); setLabel(choice.label); setKey((value) => value + 1); };
  return (
    <article className="question-builder">
      <div className="question-builder-head">
        <span>{index + 1}</span>
        <div className="question-builder-title">
          <strong>{question.prompt}</strong>
          <label className="question-schedule-toggle">
            <Checkbox
              checked={scheduleDraft}
              disabled={busy}
              onCheckedChange={setScheduleDraft}
            />
            <span><CalendarDays /> Fridays only</span>
          </label>
          {scheduleDraft !== Boolean(question.fridayOnly) && <><Button type="button" className="admin-secondary" disabled={busy} onClick={() => void action({ action: 'setQuestionFridayOnly', id: question.id, fridayOnly: scheduleDraft }, scheduleDraft ? 'Question set to Fridays only.' : 'Question set to every day.')}>Save schedule</Button><button type="button" disabled={busy} onClick={() => setScheduleDraft(Boolean(question.fridayOnly))}>Cancel</button></>}
        </div>
        <Button variant="destructive" size="icon" aria-label="Delete question" onClick={() => action({ action: 'deleteQuestion', id: question.id }, 'Question removed.')}><Trash2 /></Button>
      </div>
      <div className="answer-admin-list">{answers.map((answer, answerIndex) => <div className="answer-admin-item" key={answer.id}><AnswerVisual answer={answer} index={answerIndex} /><strong>{answer.label}</strong><Button variant="destructive" size="icon" aria-label={`Delete ${answer.label}`} onClick={() => action({ action: 'deleteAnswer', id: answer.id }, 'Answer removed.')}><Trash2 /></Button></div>)}</div>
      <div className="preset-picker"><span>Prebuilt images</span><div>{presetChoices.map((choice) => { const Icon = choice.icon; return <button type="button" className={presetKey === choice.key ? 'active' : ''} key={choice.key} onClick={() => choosePreset(choice)} aria-pressed={presetKey === choice.key}><Icon /><small>{choice.label}</small></button>; })}</div></div>
      <form className="answer-add-row" onSubmit={addAnswer}><Input className="admin-input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Answer label" /><FilePicker key={key} label={file?.name ?? (presetKey ? 'Use selected image' : 'Or upload an image')} onFile={(nextFile) => { setFile(nextFile); if (nextFile) setPresetKey(''); }} /><Button type="submit" className="admin-secondary" disabled={busy || !label.trim()}><Plus /> Add choice</Button></form>
    </article>
  );
}

function FilePicker({ label, onFile }: { label: string; onFile: (file: File | null) => void }) {
  return <label className="file-picker"><ImagePlus /><span>{label}</span><input type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" onChange={(event) => {
    const file = event.currentTarget.files?.[0] ?? null;
    onFile(file);
    event.currentTarget.value = '';
  }} /></label>;
}

async function prepareImageForUpload(file: File) {
  const maxInputBytes = 10 * 1024 * 1024;
  const maxOutputBytes = 20 * 1024;
  const lowerName = file.name.toLowerCase();
  const mime = (file.type || '').toLowerCase();
  const isJpeg = /\.(jpe?g)$/.test(lowerName) || mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/pjpeg';
  const isPng = /\.png$/.test(lowerName) || mime === 'image/png';

  if (!isJpeg && !isPng) throw new Error('Please choose a JPG, JPEG, or PNG picture.');
  if (file.size <= 0) throw new Error('That picture is empty. Choose another JPG or PNG image.');
  if (file.size > maxInputBytes) throw new Error('That photo is too large. Choose a JPG or PNG under 10 MB.');

  const loaded = await loadUploadImage(file);
  try {
    const image = loaded.image;
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('That picture could not be read. Try another JPG or PNG image.');
    if (width * height > 32_000_000) throw new Error(`That photo is ${width}×${height}, which is too large to process safely. Resize it and try again.`);

    let smallest: Blob | null = null;
    for (const maxEdge of [384, 320, 256, 192, 160, 128]) {
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));

      let context: CanvasRenderingContext2D | null = null;
      try {
        context = canvas.getContext('2d');
      } catch {
        context = null;
      }
      if (!context) throw new Error('This browser could not prepare the picture. Try another JPG or PNG image.');

      try {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      } catch {
        throw new Error('This browser could not draw that picture. Try another JPG or PNG image.');
      }

      for (const quality of [0.82, 0.7, 0.58, 0.46, 0.36]) {
        const blob = await canvasToBlob(canvas, quality);
        smallest = blob;
        if (blob.size <= maxOutputBytes) {
          return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'student-photo'}.jpg`, { type: 'image/jpeg' });
        }
      }

      canvas.width = 1;
      canvas.height = 1;
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }

    if (smallest && smallest.size <= 24 * 1024) {
      return new File([smallest], 'student-photo.jpg', { type: 'image/jpeg' });
    }
    throw new Error('The picture could not be compressed enough. Try a smaller JPG or PNG image.');
  } finally {
    loaded.cleanup();
  }
}

type LoadedUploadImage = { image: HTMLImageElement; cleanup: () => void };

function loadUploadImage(file: File): Promise<LoadedUploadImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    let settled = false;
    let timeout = 0;

    const cleanup = () => {
      if (timeout) window.clearTimeout(timeout);
      URL.revokeObjectURL(url);
      image.onload = null;
      image.onerror = null;
    };

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    image.onload = async () => {
      if (settled) return;
      try {
        if (typeof image.decode === 'function') {
          try { await image.decode(); } catch { /* onload already confirmed the browser decoded enough to draw */ }
        }
        if (settled) return;
        settled = true;
        if (timeout) window.clearTimeout(timeout);
        resolve({ image, cleanup });
      } catch {
        fail('That picture could not be decoded. Try another JPG or PNG image.');
      }
    };
    image.onerror = () => fail('That picture could not be opened. Please use a standard JPG, JPEG, or PNG image.');
    timeout = window.setTimeout(() => fail('That picture took too long to open. Try a smaller JPG or PNG image.'), 20000);
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The picture could not be converted. Try another JPG or PNG image.')), 'image/jpeg', quality);
    } catch {
      reject(new Error('The picture could not be converted. Try another JPG or PNG image.'));
    }
  });
}

function personalize(text: string, student: Student) {
  return text
    .replace(/\(name\)/gi, student.name)
    .replace(/\(score-a\)/gi, formatScore(student.currentScore))
    .replace(/\(score-b\)/gi, formatScore(student.goalScore));
}

function formatScore(value: number | null) { return value === null ? '—' : String(value); }
function fileUrl(key: string) { return key; }
function presetToneClass(key: string | null | undefined) {
  if (key === 'preset:smile' || key === 'preset:yes') return 'preset-positive';
  if (key === 'preset:sad') return 'preset-sad';
  if (key === 'preset:no') return 'preset-no';
  return '';
}
function isFacePreset(key: string | null) { return key === 'preset:smile' || key === 'preset:sad'; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); }
