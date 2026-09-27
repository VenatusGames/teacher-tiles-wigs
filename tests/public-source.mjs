import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, existsSync } from 'node:fs';

// An explicit inventory prevents accidental publication of a new export or upload.
// Add files here only after reviewing them for public sharing.
const approved = new Set([
  '.github/workflows/deploy-pages.yml', '.gitignore', 'README.md',
  'app/globals.css', 'index.html', 'main.tsx',
  'components/auth-gate.tsx', 'components/student-access-app.tsx', 'lib/firebase.ts', 'lib/firebase-config.ts', 'lib/firestore-activity.ts',
  'lib/model.ts', 'lib/class-store.ts', 'lib/student-access.ts', 'lib/packed-store.ts', 'lib/encryption.ts', 'lib/key-vault.ts', 'lib/read-cache.ts', 'firestore.rules', 'firebase.json',
  'firestore.indexes.json', '.firebaserc',
  'components/goal-garden-app.tsx', 'components/ui/button.tsx',
  'components/ui/checkbox.tsx', 'components/ui/dialog.tsx',
  'components/ui/input.tsx', 'components/ui/textarea.tsx',
  'env.d.ts', 'lib/utils.ts',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'public/favicon.svg', 'public/favicon.png', 'public/teacher-tiles.png',
  'tests/model.mjs', 'tests/encryption.mjs', 'tests/firestore-rules.mjs', 'tests/public-source.mjs', 'tsconfig.json', 'vite.config.ts',
]);
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).filter(existsSync))];
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['access token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{16,})\b/],
  ['service key', /\b(?:sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{35})\b/],
  ['email address', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['personal machine path', /(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/]|\/(?:Users|home)\/)[A-Za-z0-9._-]+/],
  ['embedded file', /data:(?:image|application)\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]{32,}/],
];
for (const file of files) {
  assert(approved.has(file), `Unreviewed public file: ${file}`);
  assert(!lstatSync(file).isSymbolicLink(), `Linked file is not allowed: ${file}`);
  const bytes = readFileSync(file);
  if (file === 'public/teacher-tiles.png' || file === 'public/favicon.png') {
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    let offset = 8;
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      assert(['IHDR', 'IDAT', 'IEND'].includes(type), `Unexpected PNG metadata: ${type}`);
      offset += length + 12;
    }
    assert.equal(offset, bytes.length);
    continue;
  }
  assert(!bytes.includes(0), `Unexpected binary file: ${file}`);
  let text = bytes.toString('utf8');
  if (file === 'lib/firebase-config.ts') {
    const key = text.match(/AIza[A-Za-z0-9_-]{35}/)?.[0];
    assert(key, 'Missing reviewed public Firebase client key');
    assert.equal(createHash('sha256').update(key).digest('hex'), 'fae5699941355100cd83765ec32a612c92adfa6ca9ba789484f409a67eb88377');
    text = text.replace(key, '[reviewed public Firebase identifier]');
  }
  for (const [label, pattern] of rules) assert(!pattern.test(text), `Potential ${label} in ${file}; inspect privately.`);
}
console.log(`Public-source audit passed for ${files.length} files. This checks the current source, not prior Git history.`);
