// What the DEPLOYED (7c3610a) logic did with each fixture: offline reconstruction for the report.
// Old logic: text = typeof out.response === 'string' ? out.response : ''; slice first '{' .. last '}'; JSON.parse;
// missing fields defaulted; no schema checks. null -> 502 bad_model_output.
import { FIXTURES } from './fixtures.js';
import { handleReply } from '../src/turn.js';
function oldHandle(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return 'reject(502)';
  try { JSON.parse(text.slice(a, b + 1)); } catch (_) { return 'reject(502)'; }
  return 'accept';
}
const rows = FIXTURES.map(f => { const o = oldHandle(f.raw), h = handleReply(f.raw, f.req); return [f.name, o, h.ok ? 'accept' : 'reject ' + h.reason]; });
console.log('fixture | old worker | new worker');
for (const r of rows) console.log(r.join(' | '));
console.log('\nold rejected (could explain a live 502):', rows.filter(r => r[1] !== 'accept').map(r => r[0]).join('; '));
