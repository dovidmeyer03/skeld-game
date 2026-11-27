// Offline runner: node test/run.js  (no network, no provider). Exit code 1 on any failure.
// Suites: (1) extraction + strict schema (unchanged expectations), (2) request contract, (3) prompt properties,
// (4) behavior properties on candidate replies for real game payloads. Offline fixtures cannot prove live behavior.
import { readFileSync, readdirSync } from 'node:fs';
import { handleReply } from '../src/turn.js';
import { normalizeRequest, isAccused } from '../src/contract.js';
import { buildSystem, buildBrief, dryReply, fitMessages, evidenceClass } from '../src/prompt.js';
import { BUSY } from './busy.js';
import { makeEnv, post } from './worker_e2e.js';
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
  const fit = fitMessages(req, 4000);
  check('prompt', f + ': fitted model input under 4,000 chars', fit.ok && fit.size < 4000, fit.ok ? `${fit.size} chars, omitted ${JSON.stringify(fit.omitted)}` : fit.reason);
  check('prompt', f + ': real payload end to end: every line reaches the model, or is explicitly marked', fit.ok && fitAccounts(req, fit));
  const d = handleReply(JSON.stringify(dryReply(req)), req);
  check('prompt', f + ': dry-run reply passes the same validation', d.ok, d.ok ? 'ok' : d.reason);
}

// (3b) fitting: busy meetings
function fitAccounts(req, fit) {
  const brief = fit.messages[1].content, om = fit.omitted;
  // protected material always present
  for (const e of req.evidence) if (['hard', 'now'].includes(evidenceClass(e)) && !brief.includes(e)) return false;
  for (const t of req.targets) if (!brief.includes(t)) return false;
  for (const o of req.options) if (!brief.includes(`- ${o} = `)) return false;
  if (req.detail && !brief.includes(req.detail)) return false;
  // every evidence line is either shown verbatim or counted in a visible marker
  const shown = req.evidence.filter(e => brief.includes('- ' + e)).length;
  const counted = (om.public || 0) + (om.sightings || 0) + (om.votes || 0) + (om.other || 0);
  if (shown + counted !== req.evidence.length) return false;
  for (const [k, w] of [['public', 'older public notes'], ['sightings', 'older sightings'], ['votes', 'older records of your votes'], ['other', 'older notes']])
    if (!!om[k] !== brief.includes(`(${om[k]} ${w} omitted to fit)`)) return false;
  if (req.phase !== 'play') {
    const shownChat = req.chat.filter(c => brief.includes(`- ${c.speaker}: ${c.text}`)).length;
    const shortened = (brief.match(/^- .* …\[shortened\]$/gm) || []).length; // chat lines only (the header also names the marker)
    if (shortened !== (om.shortened || 0)) return false;
    if (shownChat + shortened + (om.chat || 0) !== req.chat.length) return false;
    if (!!om.chat !== /older messages omitted to fit/.test(brief)) return false;
    if (req.chat.length && !brief.includes(req.chat[req.chat.length - 1].text)) return false; // newest message always intact
  }
  return true;
}
for (const bz of BUSY) {
  if (bz.expect === 'body_too_large') continue; // checked through the worker below
  const req = norm(bz.body), fit = fitMessages(req, 4000);
  if (bz.expect === 'cannot_fit') { check('busy', bz.name, !fit.ok && fit.reason === 'cannot_fit', fit.ok ? 'fitted' : `413 ${fit.reason} (${fit.size} chars)`); continue; }
  check('busy', bz.name + ': fits under 4,000', fit.ok && fit.size < 4000, fit.ok ? `${fit.size} chars` : fit.reason);
  check('busy', bz.name + ': nothing silently lost', fit.ok && fitAccounts(req, fit), fit.ok ? 'omitted ' + JSON.stringify(fit.omitted) : '');
  if (fit.ok && req.phase !== 'play') {
    const brief = fit.messages[1].content, me = req.chat.filter(c => new RegExp('\\b' + req.name + '\\b').test(c.text));
    check('busy', bz.name + ': messages addressed to the bot survive longer than others', me.filter(c => brief.includes(c.text.slice(0, 60))).length / Math.max(1, me.length) >= req.chat.filter(c => brief.includes(c.text.slice(0, 60))).length / req.chat.length);
    check('busy', bz.name + ': accusation warning kept', !/WARNING/.test(buildBrief(req)) || /WARNING/.test(brief));
  }
  if (fit.ok) { const d = handleReply(JSON.stringify(dryReply(req)), req); check('busy', bz.name + ': dry-run turn validates', d.ok, d.ok ? 'ok' : d.reason); }
}

// (3c) end to end through the worker's fetch handler (offline stubs, dry run): real payloads + busy + oversize
{
  const env = makeEnv();
  const all = readdirSync(dir).filter(x => x.endsWith('.json')).map(f => ({ name: f, body: readFileSync(new URL(f, dir), 'utf8'), expect: 200 }))
    .concat(BUSY.map(b => ({ name: b.name, body: b.raw || JSON.stringify(b.body), expect: b.expect === 'fit' ? 200 : 413, reason: b.expect === 'fit' ? null : b.expect })));
  for (const c of all) {
    env.BUDGET = makeEnv().BUDGET; // fresh dry-run budget per case: this checks routing/fitting, not the cap
    const r = await post(env, c.body);
    const ok = r.status === c.expect && (c.expect !== 200 || (!r.json.unavailable && r.json.omitted !== undefined)) && (!c.reason || r.json.reason === c.reason);
    check('worker', c.name, ok, `${r.status} ${r.json.reason || (r.json.unavailable ? 'unavailable' : 'turn')} omitted=${JSON.stringify(r.json.omitted || {})}`);
  }
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
