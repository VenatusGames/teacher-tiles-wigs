import { getDoc as sdkGetDoc, getDocs as sdkGetDocs, runTransaction as sdkRunTransaction } from 'firebase/firestore';

// Memory-only diagnostics. Never collect paths, IDs, emails, payloads, or keys.
type Activity = { requests: number; documents: number; errors: number; pending: number; lastRequest: number | null };
let activity: Activity = { requests: 0, documents: 0, errors: 0, pending: 0, lastRequest: null };
const listeners = new Set<() => void>();
export const getReadActivity = () => activity;
export function subscribeReadActivity(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function update(values: Partial<Activity>) { activity = { ...activity, ...values }; listeners.forEach(listener => listener()); }
async function track<T>(request: () => Promise<T>, count: (result: T) => number): Promise<T> {
  update({ requests: activity.requests + 1, pending: activity.pending + 1, lastRequest: Date.now() });
  try {
    const result = await request();
    update({ documents: activity.documents + count(result) });
    return result;
  } catch (error) { update({ errors: activity.errors + 1 }); throw error; }
  finally { update({ pending: activity.pending - 1 }); }
}
export const getDoc: typeof sdkGetDoc = reference => track(() => sdkGetDoc(reference), result => result.exists() ? 1 : 0);
export const getDocs: typeof sdkGetDocs = reference => track(() => sdkGetDocs(reference), result => result.docs.length);
export const runTransaction: typeof sdkRunTransaction = (db, updateFunction, options) => sdkRunTransaction(db, transaction => {
  // The SDK can retry a transaction. Count each read attempt, including retries.
  const tracked = new Proxy(transaction, {
    get(target, property) {
      if (property === 'get') return (reference: Parameters<typeof transaction.get>[0]) => track(() => target.get(reference), result => result.exists() ? 1 : 0);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return updateFunction(tracked);
}, options);
