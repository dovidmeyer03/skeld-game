// Model-reply handling for skeld-game-relay-test. Pure functions, no I/O: tested offline by test/run.js.
//
// Two separate steps, on purpose:
//   1. extractCandidate(raw): find ONE candidate JSON object in the reply (tolerant about wrapping).
//   2. validateTurn(obj, req): the full schema + safety check. Extraction is not acceptance: every
//      candidate must pass this, whatever extraction had to strip to find it.
// Nothing is ever repaired or invented: a truncated object, a missing field or a name the request did not
// offer is a rejection. Rejections carry a reason code and shape facts only, never the model's text.

export const LIMITS = { say: 200, plan: 160, beliefs: 6, raw: 20000 };
export const BELIEF_VALUES = ['trust', 'suspect', 'unsure'];
export const FIELDS = ['say', 'vote', 'beliefs', 'plan', 'act'];

const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;

// Shape facts for diagnostics (safe to log/return: no content).
export function shapeOf(raw) {
  if (raw == null) return { type: String(raw) };
  if (typeof raw !== 'string') return { type: Array.isArray(raw) ? 'array' : typeof raw };
  return { type: 'string', len: raw.length, fenced: /```/.test(raw), braces: (raw.match(/\{/g) || []).length, startsWithBrace: /^\s*\{/.test(raw) };
}

// Remove markdown code fences (```json ... ``` or ``` ... ```), keeping their content in place.
export function stripFences(s) {
  return s.replace(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?/g, '').replace(/```/g, '');
}

// First balanced top-level {...} in s, honouring JSON strings and escapes. Returns the substring, or a reason.
export function firstObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return { reason: 'no_object' };
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return { text: s.slice(start, i + 1) }; }
  }
  return { reason: 'unbalanced' }; // e.g. cut off at max_tokens: never repaired
}

// raw: whatever the provider returned as the reply (normally out.response).
export function extractCandidate(raw) {
  const shape = shapeOf(raw);
  if (isPlain(raw)) return { ok: true, obj: raw, shape, via: 'object' };      // provider already parsed it
  if (typeof raw !== 'string') return { ok: false, reason: 'not_text', shape };
  if (raw.length > LIMITS.raw) return { ok: false, reason: 'too_long', shape };
  const s = stripFences(raw);
  const f = firstObject(s);
  if (!f.text) return { ok: false, reason: f.reason, shape };
  let obj;
  try { obj = JSON.parse(f.text); } catch (_) { return { ok: false, reason: 'parse', shape }; }
  if (!isPlain(obj)) return { ok: false, reason: 'not_object', shape };
  return { ok: true, obj, shape, via: s.trim() === f.text ? (shape.fenced ? 'fenced' : 'clean') : 'embedded' };
}

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;
const UNSAFE = /<\s*\/?\s*[a-z!]|https?:\/\/|www\.|```|\{\s*"/i; // markup, links, fences, leaked JSON

function okText(v, max) { return typeof v === 'string' && v.length <= max && !CTRL.test(v) && !UNSAFE.test(v); }

// req: the client's request object (needs targets[], optional meeting.phase, optional ext.options[]).
// Returns { ok:true, turn } with exactly the five fields, or { ok:false, reason }.
export function validateTurn(obj, req) {
  if (!isPlain(obj)) return { ok: false, reason: 'schema:not_object' };
  for (const k of FIELDS) if (!(k in obj)) return { ok: false, reason: 'schema:missing_' + k };
  const targets = Array.isArray(req && req.targets) ? req.targets.filter(t => typeof t === 'string') : [];
  const options = req && isPlain(req.ext) && Array.isArray(req.ext.options) ? req.ext.options.filter(t => typeof t === 'string') : null;

  const say = obj.say;
  if (!okText(say, LIMITS.say)) return { ok: false, reason: 'schema:say' };

  const vote = obj.vote;
  if (!(vote === null || vote === 'skip' || (typeof vote === 'string' && targets.includes(vote)))) return { ok: false, reason: 'schema:vote' };
  // a vote is allowed in either phase; the client decides when it counts

  const b = obj.beliefs;
  if (!isPlain(b)) return { ok: false, reason: 'schema:beliefs' };
  const bk = Object.keys(b);
  if (bk.length > LIMITS.beliefs) return { ok: false, reason: 'schema:beliefs_count' };
  for (const k of bk) if (!targets.includes(k) || !BELIEF_VALUES.includes(b[k])) return { ok: false, reason: 'schema:beliefs_entry' };

  if (!okText(obj.plan, LIMITS.plan)) return { ok: false, reason: 'schema:plan' };

  const act = obj.act;
  if (options && options.length) { if (!(act === null || (typeof act === 'string' && options.includes(act)))) return { ok: false, reason: 'schema:act' }; }
  else if (act !== null) return { ok: false, reason: 'schema:act' };

  // extra top-level fields are dropped (never passed on); only the five contract fields leave the worker
  return { ok: true, turn: { say, vote, beliefs: Object.fromEntries(bk.map(k => [k, b[k]])), plan: obj.plan, act } };
}

// Full pipeline used by the worker.
export function handleReply(raw, req) {
  const c = extractCandidate(raw);
  if (!c.ok) return { ok: false, reason: 'extract:' + c.reason, shape: c.shape };
  const v = validateTurn(c.obj, req);
  if (!v.ok) return { ok: false, reason: v.reason, shape: c.shape, via: c.via };
  return { ok: true, turn: v.turn, via: c.via };
}
