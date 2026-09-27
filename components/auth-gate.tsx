import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { clearReadCache } from '@/lib/read-cache';
import { LogIn, LoaderCircle, LogOut } from 'lucide-react';
import { auth, db, firebaseConfigured, googleSignIn, logOut, friendlyError } from '@/lib/firebase';
import { type Access } from '@/lib/model';
import { GoalGardenApp } from './goal-garden-app';
import { StudentAccessApp } from './student-access-app';

export function AuthGate() {
  const token = new URLSearchParams(window.location.search).get('student');
  return token ? <StudentAccessApp token={token} /> : <TeacherAuthGate />;
}

function TeacherAuthGate() {
  const [user, setUser] = useState<User | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [loading, setLoading] = useState(firebaseConfigured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!auth || !db) return;
    let identity: string | undefined;
    const stopAuth = onAuthStateChanged(auth, current => {
      const nextIdentity = JSON.stringify([current?.uid, current?.email, current?.emailVerified]);
      setUser(current);
      // Token/User object refreshes for the same identity must not reload the class.
      if (nextIdentity === identity) return;
      identity = nextIdentity;
      setAccess(null); setError('');
      if (!current) { clearReadCache(); setLoading(false); return; }
      if (!current.email || !current.emailVerified) {
        clearReadCache(); setError('Use a Google account with a verified email address.'); setLoading(false); return;
      }
      setLoading(true);
      const accountScope: Access = { role: 'teacher', ownerId: current.uid };
      setAccess(accountScope); setLoading(false);
    });
    const refresh = () => { clearReadCache(); setLoading(true); setRetry(value => value + 1); };
    window.addEventListener('wigs:refresh', refresh);
    return () => { stopAuth(); window.removeEventListener('wigs:refresh', refresh); };
  }, [retry]);
  const login = async () => {
    setBusy(true); setError('');
    try { await googleSignIn(); } catch (err) { setError(friendlyError(err)); }
    finally { setBusy(false); }
  };
  if (user && access && !loading && !error) return <GoalGardenApp key={`${user.uid}:${access.ownerId}:teacher`} access={access} email={user.email ?? ''} />;
  return <main className="auth-gate"><section className="auth-card" aria-labelledby="sign-in-title">
    <img className="auth-mark brand-image" src="/wigs/favicon.png" alt="" /><p className="eyebrow">WIGs</p>
    <h1 id="sign-in-title">{loading ? 'Opening your WIGs…' : 'Sign in to continue'}</h1>
    <p>Use your Google account to open your class.</p>
    {loading ? <LoaderCircle className="spin" aria-label="Loading" /> : <>
      {!firebaseConfigured && <p role="status">WIGs sign-in is being set up. Please check back soon.</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      {user ? <><button onClick={() => { clearReadCache(); setError(''); setLoading(true); setRetry(v => v + 1); }}>Try again</button><button onClick={() => void logOut().catch(err => setError(friendlyError(err)))}><LogOut /> Use another account</button></> : <button className="google-sign-in" onClick={() => void login()} disabled={busy || !firebaseConfigured}>{busy ? <LoaderCircle className="spin" /> : <LogIn />} {busy ? 'Signing in…' : 'Sign in with Google'}</button>}
    </>}
  </section></main>;
}
