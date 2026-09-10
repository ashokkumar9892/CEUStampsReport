// Copies the page into dist/ for Netlify: public/ at the root, shared/ beside it
// (the page imports /shared/format.js and /shared/table.js). Nothing else from
// the repository is published.

import { cpSync, rmSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const out = new URL('dist/', root);

rmSync(out, { recursive: true, force: true });
cpSync(new URL('public/', root), out, { recursive: true });
cpSync(new URL('shared/', root), new URL('shared/', out), { recursive: true });
console.log('Built dist/ (public/ + shared/).');
