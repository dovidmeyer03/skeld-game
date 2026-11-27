// Offline runner: node test/run.js  (no network, no provider). Exit code 1 on any failure.
// Suites: (1) extraction + strict schema (unchanged expectations), (2) request contract, (3) prompt properties,
// (4) behavior properties on candidate replies for real game payloads. Offline fixtures cannot prove live behavior.
import { readFileSync, readdirSync } from 'node:fs';
import { handleReply } from '../src/turn.js';
import { normalizeRequest, isAccused } from '../src/contract.js';
import { buildSystem, buildBrief, dryReply } from '../src/prompt.js';
import { FIXTURES } from './fixtures.js';
import { SCENARIOS, REQUESTS } from './behavior.js';

let fail = 0, total = 0;
const check = (suite, name, ok, info) => { total++; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${suite} | ${name}${info ? ' | ' + info : ''}`); };
const norm = r => { const n = normalizeRequest(r); if (!n.ok) throw new Error('fixture request invalid: ' + n.reason); return n.req; };

// (1) extraction + schema
for (const f of FIXTURES) {
  const h = handleReply(f.raw, norm(f.req));
  const got = h.ok ? 'accept' : h.reason;
  let ok = got === f.expect;
  if (ok && h.ok && f.via && h.via !== f.via) ok = false;
  if (ok && h.ok) { if (Object.keys(h.turn).join() !== 'say,vote,beliefs,plan,act') ok = false; if (f.dropped && f.dropped.some(k => k in h.turn)) ok = false; }
  if (ok && !h.ok && JSON.stringify(h).includes('Med Lab with Blue')) ok = false; // rejections never carry model text
  check('extract', f.name, ok, got + (h.via ? ' via ' + h.via : '') + (ok ? '' : ' (expected ' + f.expect + ')'));
}

// (2) request contract
for (const r of REQUESTS) {
  const n = normalizeRequest(r.body);
  const got = n.ok ? 'ok' : n.reason;
  let ok = got === r.expect;
  if (ok && n.ok && r.props) ok = r.props(n.req);
  check('request', r.name, ok, got);
}

// (3) prompt properties for every captured real payload
const dir = new URL('./payloads/', import.meta.url);
for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
  const body = readFileSync(new URL(f, dir), 'utf8'), req = norm(JSON.parse(body));
  const sys = buildSystem(req), brief = buildBrief(req);
  check('prompt', f + ': names the bot and its role', sys.includes(req.name) && brief.includes(req.name) && (req.role === 'saboteur' ? /SABOTEUR/.test(sys) && /Never reveal/.test(sys) : /You are CREW/.test(sys)));
  check('prompt', f + ': states phase rules', req.phase === 'play' ? /"act": required/.test(sys) : req.phase === 'voting' ? /"vote": required/.test(sys) : /required, never empty/.test(sys));
  check('prompt', f + ': offers no silent escape hatch for this phase', !(req.phase !== 'play' && /stay silent|or ""/.test(sys)) && !(req.phase === 'voting' && /"vote": null/.test(sys)) && !(req.phase === 'play' && /"act": null/.test(sys)));
  check('prompt', f + ': every evidence line and chat line reaches the model', req.evidence.every(e => brief.includes(e)) && (req.phase === 'play' || req.chat.every(c => brief.includes(c.text))));
  check('prompt', f + ': option meanings explained', req.options.every(o => new RegExp('- ' + o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' = ').test(brief)));
  check('prompt', f + ': accused bot is told to answer', !(req.phase !== 'play' && isAccused(req)) || /being accused/.test(brief));
  check('prompt', f + ': system + body under the 4,000-char cap', sys.length + body.length < 4000, `${sys.length}+${body.length}`);
  const d = handleReply(JSON.stringify(dryReply(req)), req);
  check('prompt', f + ': dry-run reply passes the same validation', d.ok, d.ok ? 'ok' : d.reason);
}

// (4) behavior properties
for (const sc of SCENARIOS) {
  const req = norm(JSON.parse(readFileSync(new URL(sc.payload, dir), 'utf8')));
  for (const c of sc.cases) {
    const h = handleReply(typeof c.raw === 'string' ? c.raw : JSON.stringify(c.raw), req);
    let ok, info;
    if (c.expect === 'accept') {
      ok = h.ok; info = h.ok ? 'accept used=' + JSON.stringify(h.grounding.used) : h.reason;
      if (ok) {
        const t = h.turn;
        // properties, not exact strings
        if (req.phase === 'discussion' && !/[A-Za-z]{2,}/.test(t.say)) ok = false;
        if (Object.keys(t.beliefs).some(k => !req.targets.includes(k))) ok = false;
        if (t.vote && t.vote !== 'skip' && t.beliefs[t.vote] !== 'suspect') ok = false;
        if (req.phase === 'voting' && t.vote === null) ok = false;
        if (req.options.length && !req.options.includes(t.act)) ok = false;
        if (req.phase === 'play' && t.say !== '') ok = false;
        if (c.props && !c.props(t, h, req)) ok = false;
      }
    } else {
      ok = !h.ok && h.reason === c.expect && (c.expect.startsWith('behavior:') ? h.unavailable === true : h.unavailable === false);
      info = h.ok ? 'accepted' : h.reason + (h.unavailable ? ' (explicit unavailable)' : '');
    }
    check('behavior', sc.name + ': ' + c.name, ok, info);
  }
}

console.log(`\n${total - fail}/${total} checks passed`);
process.exit(fail ? 1 : 0);
