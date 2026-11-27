// skeld-game-relay-test: bounded real-AI first test (Stage 0). Separate from the production relay.
// Only route: POST /room/TESTAI1/ai  headers: X-Test-Key, X-Host-Token; body = client AI request JSON.
// Everything else is 404. Order of checks: route 404 -> method 405 -> test key 403 -> host token 403 ->
// size 413 -> JSON 400 -> budget reservation (429 when exhausted, 409 if another call is in flight) -> provider.
// Requests rejected before the reservation cost nothing.

const ROOM = 'TESTAI1';
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast'; // the only model this worker can call
const BUDGET_CAP = 5;          // code constant; per mode (budget:dryrun, budget:real); no route can change or reset it
const MAX_INPUT_CHARS = 4000;  // system prompt length + request body length must stay below this
const MAX_TOKENS = 400;        // output cap on the model call
const TIMEOUT_MS = 8000;       // provider timeout; the reservation is kept on timeout
const LOCK_MS = 20000;         // sequential only: one call in flight; a stuck lock expires after this
const TOKEN_RX = /^[A-Za-z0-9_-]{16,128}$/;

import { handleReply } from './turn.js';
import { normalizeRequest } from './contract.js';
import { buildMessages, buildSystem, dryReply } from './prompt.js';

// longest system prompt any role/phase can produce (for the pre-read Content-Length check)
const MAX_SYSTEM = Math.max(...['crew', 'saboteur'].flatMap(role => ['discussion', 'voting', 'play'].map(phase => buildSystem({ name: 'XXXXXXXXXXXXXX', role, phase }).length)));

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// constant-time compare for the test key
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
async function sha256(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/room/' + ROOM + '/ai') return json(404, { error: 'not_found' });
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    // missing/empty TEST_KEY binding -> every request is 403
    if (!env.TEST_KEY || !same(req.headers.get('X-Test-Key') || '', env.TEST_KEY)) return json(403, { error: 'forbidden' });
    const tok = req.headers.get('X-Host-Token') || '';
    if (!TOKEN_RX.test(tok)) return json(403, { error: 'forbidden' });
    const room = env.ROOMS.get(env.ROOMS.idFromName(ROOM));
    const hostOk = await (await room.fetch('https://do/check', { method: 'POST', body: await sha256(tok) })).json();
    if (!hostOk.ok) return json(403, { error: 'forbidden' });

    const len = +req.headers.get('content-length');
    if (len && MAX_SYSTEM + len >= MAX_INPUT_CHARS) return json(413, { error: 'too_large', limit: MAX_INPUT_CHARS - MAX_SYSTEM - 1 });
    const body = await req.text();
    if (MAX_SYSTEM + body.length >= MAX_INPUT_CHARS) return json(413, { error: 'too_large', limit: MAX_INPUT_CHARS - MAX_SYSTEM - 1 });
    let reqObj; try { reqObj = JSON.parse(body); if (!reqObj || typeof reqObj !== 'object' || Array.isArray(reqObj)) throw 0; } catch (_) { return json(400, { error: 'bad_json' }); }
    // a request the model cannot act on (no identity, no role, options outside play, ...) is refused before any reservation
    const nr = normalizeRequest(reqObj);
    if (!nr.ok) return json(400, { error: 'bad_request', reason: nr.reason });
    const nreq = nr.req, messages = buildMessages(nreq);

    // Reserve BEFORE any provider invocation. Never refunded.
    const dry = env.DRYRUN === '1';
    const budget = env.BUDGET.get(env.BUDGET.idFromName('budget'));
    const r = await (await budget.fetch('https://do/reserve', { method: 'POST', body: dry ? 'dryrun' : 'real' })).json();
    if (!r.ok) {
      if (r.reason === 'busy') return json(409, { error: 'busy', detail: 'sequential requests only' });
      return json(429, { error: 'quota_exhausted', quota: 'exhausted', mode: r.mode, used: r.used, cap: BUDGET_CAP });
    }
    try {
      // dry run feeds the fixed reply through the same extraction + validation as a real one
      const raw = dry ? JSON.stringify(dryReply(nreq)) : await callModel(env, messages);
      const h = handleReply(raw, nreq);
      // well-formed but useless/inconsistent for this phase: an explicit fallback signal, never a fake turn
      if (!h.ok && h.unavailable) return json(200, { unavailable: true, reason: h.reason, via: h.via, dryrun: dry, mode: r.mode, used: r.used, cap: BUDGET_CAP });
      // rejection: reason code + shape facts only; the model's text is never returned or stored
      if (!h.ok) return json(502, { error: 'bad_model_output', reason: h.reason, shape: h.shape, via: h.via, mode: r.mode, used: r.used, cap: BUDGET_CAP });
      return json(200, Object.assign({}, h.turn, { grounding: h.grounding, via: h.via, dryrun: dry, mode: r.mode, used: r.used, cap: BUDGET_CAP }));
    } catch (e) {
      const to = e && e.message === 'timeout';
      return json(to ? 504 : 502, { error: to ? 'timeout' : 'provider_error', mode: r.mode, used: r.used, cap: BUDGET_CAP });
    } finally {
      await budget.fetch('https://do/unlock', { method: 'POST' }); // releases the in-flight lock only; the count stays
    }
  }
};

async function callModel(env, messages) {
  const run = env.AI.run(MODEL, {
    messages,
    max_tokens: MAX_TOKENS
  });
  const out = await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))]);
  // normally { response: string }; anything else is handed on as-is and classified by handleReply
  return out && typeof out === 'object' && 'response' in out ? out.response : out;
}

// Call budget: separate counters budget:dryrun and budget:real, cap BUDGET_CAP each. Reservation is one storage
// transaction (read, check, increment + lock). There is no operation that lowers or resets a counter.
export class BudgetCounter {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const op = new URL(req.url).pathname;
    if (op === '/reserve') {
      const mode = (await req.text()) === 'real' ? 'real' : 'dryrun';
      const key = 'budget:' + mode;
      const res = await this.state.storage.transaction(async txn => {
        const used = (await txn.get(key)) || 0;
        if (used >= BUDGET_CAP) return { ok: false, reason: 'quota', mode, used };
        const lock = (await txn.get('lock')) || 0;
        if (lock && Date.now() - lock < LOCK_MS) return { ok: false, reason: 'busy', mode, used };
        await txn.put({ [key]: used + 1, lock: Date.now() });
        return { ok: true, mode, used: used + 1 };
      });
      return json(200, res);
    }
    if (op === '/unlock') { await this.state.storage.put('lock', 0); return json(200, { ok: true }); }
    return json(404, { error: 'not_found' });
  }
}

// TESTAI1 host token: the test client generates it, like the real game. The first valid request claims the room
// with that token; only its SHA-256 hash is stored. Later requests must carry the same token. No route resets it.
export class TestRoom {
  constructor(state) { this.state = state; }
  async fetch(req) {
    if (new URL(req.url).pathname !== '/check') return json(404, { error: 'not_found' });
    const h = await req.text();
    const ok = await this.state.storage.transaction(async txn => {
      const stored = await txn.get('hostTokenHash');
      if (!stored) { await txn.put('hostTokenHash', h); return true; }
      return stored === h;
    });
    return json(200, { ok });
  }
}
