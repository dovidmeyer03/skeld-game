// End-to-end chain, offline: the game's REAL request builders -> the worker's real fetch handler.
//
// The game code is not copied: index.html is loaded in headless Chromium (Playwright) and its own memClasses /
// aiBody / packBody run on a long, busy game state. Nothing can drift out of sync, but this needs Playwright and
// a copy of the game file. Every network request from the page is blocked (no AI, no relay).
//
//   node test/chain.js                       uses `git show packbody-omit-marker:index.html` (Task A applied)
//   GAME=/path/index.html node test/chain.js uses that file instead
// Optional play-phase check: aiDecideBody exists only on branch ai-driven-1, which does NOT have the packBody
// change; it is run from that branch and reported separately.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRequest } from '../src/contract.js';
import { fitMessages, evidenceClass } from '../src/prompt.js';
import { fitAccounts } from './accounts.js';
import { makeEnv, post } from './worker_e2e.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = mkdtempSync(join(tmpdir(), 'chain-'));
function gameFile(branch) {
  if (process.env.GAME && branch === 'packbody-omit-marker') return process.env.GAME;
  const f = join(tmp, branch + '.html');
  writeFileSync(f, execFileSync('git', ['show', branch + ':index.html'], { maxBuffer: 1 << 26 }));
  return f;
}

let fail = 0, total = 0;
const check = (name, ok, info) => { total++; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} | chain | ${name}${info ? ' | ' + info : ''}`); };

// Busy state built inside the real game: 12 players (the game itself seats at most 10; two more agents are added
// to exercise the protocol limit), 40 chat lines incl. an accusation against the bot, 40+ memory lines incl. a
// witnessed kill, a vent sighting, visual tasks, contradictions, vote history, public notes and sightings.
function buildInPage(phase) {
  __K.newGame({ imp: false }); const G = __K.G; G.mode = 'play'; G.t = 900; G.lastMeetT = 700; G.round = 3;
  const A = G.agents; for (const a of A) a.imp = false; A[4].imp = true;
  for (const [id, name, col] of [[10, 'Teal', '#1a8f8a'], [11, 'Coral', '#ff7f6a']]) A.push(Object.assign({}, A[9], { id, name, col, snaps: [], witness: [], visual: [], ventSaw: [], alive: true, imp: false, isPlayer: false, human: false }));
  const bot = A[2], killer = A[4], N = i => A[i].name;
  A[6].alive = false;
  bot.witOld = [...Array(7)].map((_, k) => ({ killer: A[(k % 3) + 7].id, victim: A[(k % 2) + 10].id, t: 100 + k, room: 'Records' }));
  bot.witness = [{ killer: killer.id, victim: A[6].id, t: 850, room: 'Med Lab' }];
  bot.ventOld = [{ id: A[9].id, t: 300, room: 'Observatory' }, { id: A[8].id, t: 320, room: 'Records' }, { id: A[7].id, t: 340, room: 'Hydroponics' }]; bot.ventSaw = [{ id: killer.id, t: 860, room: 'Cargo Bay' }];
  bot.visual = [...Array(6)].map((_, k) => ({ id: A[[1, 3, 5, 7, 8, 10][k]].id, t: 720 + k, type: 'scan', room: 'Med Lab' }));
  bot.contraHist = [{ target: A[5].id, round: 1 }, { target: A[7].id, round: 2 }];
  bot.voteHist = [1, 2, 3].map(r => `In meeting ${r} you voted for ${N(r + 2)}; ${N(r + 2)} was not ejected.`);
  G.social.pub = [...Array(8)].map((_, k) => ({ notes: [`In meeting ${1 + (k % 2)}, ${N(k % 12)} said: "I saw ${N((k + 3) % 12)} near the vent in Cargo Bay right before the lights went out."`], out: `Meeting ${1 + (k % 2)} outcome: nobody was ejected (skipped, 6 skip votes).` }));
  bot.snaps = []; for (let t = 710; t < 899; t += 0.35) bot.snaps.push({ t, room: 'x', seen: [[1, 'Records'], [3, 'Cargo Bay'], [5, 'Med Lab'], [7, 'Observatory'], [8, 'Reactor Core'], [10, 'Records'], [11, 'Hydroponics']] });
  __K.callMeeting('body', A[3], { id: 6, x: 0, y: 0 }); const M = G.M; M.phase = phase;
  M.claims.push({ type: 'contra', sp: bot.id, target: A[11].id });
  for (let k = 0; k < 40; k++) {
    const sp = A[[1, 3, 4, 5, 7, 8, 9, 10, 11][k % 9]];
    if (k === 33) { M.shown = M.lines.length; __K.playerSay(`${bot.name} is sus, I saw ${bot.name} come out of the vent in Cargo Bay.`, killer); M.lines.length = M.shown; continue; } // the game's own chat path records the accusation as a claim (scripted replies discarded)
    M.lines.push({ who: sp.id, text: `Line ${k}: I was doing my long task in Records, then I walked the hallway past Cargo Bay toward Med Lab and did not see anyone near the body before ${N(3)} reported it.` });
  }
  M.shown = M.lines.length;
  const before = { memories: __K.botMemories(bot, M), chat: Math.min(30, M.lines.slice(0, M.shown).filter(l => l.who !== -2 && !l.ghost).length), players: A.length };
  const out = __K.aiBody(bot, M);
  return { out, before, bytes: new TextEncoder().encode(out).length, bot: bot.name };
}

const browser = await chromium.launch();
async function page(file) {
  const ctx = await browser.newContext(); await ctx.route(/^(?!file:)/, r => r.abort());
  const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('file://' + file); await pg.waitForTimeout(300); return { pg, errs };
}

const { pg, errs } = await page(gameFile('packbody-omit-marker'));
for (const phase of ['discuss', 'vote']) {
  const r = await pg.evaluate(buildInPage, phase);
  const body = JSON.parse(r.out), tag = phase === 'discuss' ? 'discussion' : 'voting';
  check(`${tag}: busy input (players, chat, memories)`, r.before.players === 12 && r.before.chat >= 30 && r.before.memories.length >= 40, `${r.before.players} players, ${r.before.chat} chat lines after aiBody's 30-line cap, ${r.before.memories.length} memory lines`);
  // (1) packBody: within budget, marker present with exact counts
  const mk = body.memories.find(x => x.startsWith('Left out to fit:')) || '';
  const keptMem = body.memories.filter(x => x !== mk).length, num = rx => +((mk.match(rx) || [])[1] || 0);
  check(`${tag}: (1) packBody output within 4,000 bytes (production limit 4,096)`, r.bytes <= 4000, r.bytes + ' bytes');
  check(`${tag}: (1) omission marker present with exact counts`, !!mk && num(/(\d+) older chat message/) === r.before.chat - body.chat.length && num(/(\d+) older note/) === r.before.memories.length - keptMem, `"${mk}" (chat ${r.before.chat}->${body.chat.length}, memories ${r.before.memories.length}->${keptMem})`);
  // (2) worker accepts; (6) dry-run turn validates
  const res = await post(makeEnv(), r.out);
  check(`${tag}: (2) worker accepts the real request`, res.status === 200, `${res.status} ${res.json.reason || ''}`);
  check(`${tag}: (6) dry-run turn validates`, res.status === 200 && !res.json.unavailable && typeof res.json.say === 'string' && res.json.say.length > 0, res.json.say);
  // (3) fitted model input under 4,000; (4) protected evidence verbatim; (5) worker omissions marked in brief + response
  const req = normalizeRequest(body).req, fit = fitMessages(req, 4000), brief = fit.ok ? fit.messages[1].content : '';
  check(`${tag}: (3) fitted model input under 4,000 chars`, fit.ok && fit.size < 4000, fit.ok ? fit.size + ' chars' : fit.reason);
  const prot = req.evidence.filter(e => ['hard', 'now', 'marker'].includes(evidenceClass(e)));
  const missing = prot.filter(e => !brief.includes(e)).concat(/being accused/.test(brief) ? [] : ['(accusation warning)']).concat(brief.includes(mk) ? [] : ['(client marker)']);
  check(`${tag}: (4) protected evidence reaches the model verbatim`, prot.length >= 8 && !missing.length && /You SAW .* kill/.test(brief) && /come out of a vent/.test(brief), missing.length ? 'MISSING ' + JSON.stringify(missing) : `${prot.length} protected lines incl. the kill, the vent, the accusation warning and the client marker`);
  check(`${tag}: (5) worker-side omissions explicit in brief and response`, fit.ok && fitAccounts(req, fit) && JSON.stringify(res.json.omitted) === JSON.stringify(fit.omitted), 'omitted ' + JSON.stringify(fit.omitted));
}
check('game page raised no errors', errs.length === 0, errs.join('; '));

// Play-phase decision from ai-driven-1 (that branch lacks the packBody marker change; reported separately).
{
  const p2 = await page(gameFile('ai-driven-1'));
  const out = await p2.pg.evaluate(() => {
    __K.newGame({ imp: false }); const G = __K.G; G.mode = 'play'; G.t = 50; for (const a of G.agents) a.imp = false; const bot = G.agents[4]; bot.imp = true; const t = G.agents[6];
    return __K.aiDecideBody(bot, { kind: 'kill_chance', detail: `You can kill now. Nearby: ${t.name} (90 away). Others who could see you: none.`, opts: ['kill:' + t.name, 'wait'] });
  });
  const res = await post(makeEnv(), out);
  check('ai-driven-1 aiDecideBody (play decision, branch without Task A): worker accepts, act chosen from options', res.status === 200 && /^kill:|^wait$/.test(res.json.act || ''), `${res.status} act=${res.json.act}`);
}

await browser.close();
console.log(`\n${total - fail}/${total} chain checks passed`);
process.exit(fail ? 1 : 0);
