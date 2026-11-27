// Offline runner: node test/run.js  (no network, no provider). Exit code 1 on any mismatch.
import { handleReply } from '../src/turn.js';
import { FIXTURES } from './fixtures.js';
let fail = 0;
const rows = [];
for (const f of FIXTURES) {
  const h = handleReply(f.raw, f.req);
  const got = h.ok ? 'accept' : h.reason;
  let ok = got === f.expect;
  if (ok && h.ok && f.via && h.via !== f.via) ok = false;
  if (ok && h.ok) { if (Object.keys(h.turn).join() !== 'say,vote,beliefs,plan,act') ok = false; if (f.dropped && f.dropped.some(k => k in h.turn)) ok = false; }
  if (ok && !h.ok && JSON.stringify(h).includes('Med Lab with Blue')) ok = false; // rejections never carry model text
  rows.push([ok ? 'PASS' : 'FAIL', f.name, got + (h.via ? ' via ' + h.via : '')]);
  if (!ok) { fail++; rows[rows.length - 1].push('expected ' + f.expect + (f.via ? ' via ' + f.via : '')); }
}
for (const r of rows) console.log(r.join(' | '));
console.log(`\n${FIXTURES.length - fail}/${FIXTURES.length} fixtures as expected`);
process.exit(fail ? 1 : 0);
