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

// req: the NORMALIZED request (contract.js normalizeRequest): name, role, phase, targets[], options[], evidence[].
// Two layers:
//  - schema:*   the reply is malformed or names things the request never offered -> rejected (502 in the worker).
//  - behavior:* the reply is well-formed but useless or self-inconsistent for this phase -> an explicit,
//               recognizable "unavailable" result (never passed off as a turn, never silently defaulted).
// Returns { ok:true, turn, grounding } | { ok:false, reason }.
const REVEAL = /\b(i am|i'm|im)\s+(a |the |one of the )?(saboteurs?|impostors?|imposters?)\b|\bi (killed|murdered)\b/i;
const hasWords = s => /[A-Za-z]{2,}/.test(s);
const mentions = (text, n) => new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text);

export function validateTurn(obj, req) {
  if (!isPlain(obj)) return { ok: false, reason: 'schema:not_object' };
  if (obj.unavailable === true) return { ok: false, reason: 'behavior:model_declined' };
  for (const k of FIELDS) if (!(k in obj)) return { ok: false, reason: 'schema:missing_' + k };
  const targets = req.targets, options = req.options || [];

  const say = obj.say;
  if (!okText(say, LIMITS.say)) return { ok: false, reason: 'schema:say' };

  const vote = obj.vote;
  if (!(vote === null || vote === 'skip' || (typeof vote === 'string' && targets.includes(vote)))) return { ok: false, reason: 'schema:vote' };

  const b = obj.beliefs;
  if (!isPlain(b)) return { ok: false, reason: 'schema:beliefs' };
  const bk = Object.keys(b);
  if (bk.length > LIMITS.beliefs) return { ok: false, reason: 'schema:beliefs_count' };
  for (const k of bk) if (!targets.includes(k) || !BELIEF_VALUES.includes(b[k])) return { ok: false, reason: 'schema:beliefs_entry' };

  if (!okText(obj.plan, LIMITS.plan)) return { ok: false, reason: 'schema:plan' };

  const act = obj.act;
  if (options.length) { if (!(act === null || (typeof act === 'string' && options.includes(act)))) return { ok: false, reason: 'schema:act' }; }
  else if (act !== null) return { ok: false, reason: 'schema:act' };

  // ---- behavior (phase-aware)
  const beliefs = Object.fromEntries(bk.map(k => [k, b[k]]));
  let turn = { say, vote, beliefs, plan: obj.plan, act };
  if (req.role === 'saboteur' && REVEAL.test(say)) return { ok: false, reason: 'behavior:self_reveal' };
  if (req.partners && req.partners.length && (req.partners.includes(vote) || req.partners.some(p => beliefs[p] === 'suspect'))) return { ok: false, reason: 'behavior:betrays_partner' };
  if (req.phase === 'play') {
    if (act === null) return { ok: false, reason: 'behavior:no_act' };
    turn = Object.assign(turn, { say: '', vote: null }); // nobody hears chat outside a meeting; no vote exists. Dropped, not invented.
  } else {
    if (req.phase === 'discussion' && !hasWords(say)) return { ok: false, reason: 'behavior:silent' };
    if (req.phase === 'voting' && vote === null) return { ok: false, reason: 'behavior:no_vote' };
    // a vote (cast, or pre-committed during discussion) must match the bot's own stated beliefs
    if (vote !== null && vote !== 'skip' && beliefs[vote] !== 'suspect') return { ok: false, reason: 'behavior:vote_belief' };
  }
  // grounding: which evidence names the turn actually uses (diagnostic only)
  const evid = evidenceNamesOf(req);
  const used = evid.filter(n => mentions(turn.say, n) || n in beliefs || turn.vote === n || (turn.act || '').endsWith(':' + n));
  // Not a rejection: the model owns interpretation of evidence, including weighing or withholding it (owner rule).
  // grounding.used = [] with evidence present is reported so a live test can measure it.
  return { ok: true, turn, grounding: { evidence: evid, used } };
}

function evidenceNamesOf(req) {
  const own = (req.evidence || []).filter(x => !/^Public history/i.test(x)).join('\n');
  return req.targets.filter(t => mentions(own, t));
}

// Full pipeline used by the worker (req = normalized request).
export function handleReply(raw, req) {
  const c = extractCandidate(raw);
  if (!c.ok) return { ok: false, reason: 'extract:' + c.reason, shape: c.shape };
  const v = validateTurn(c.obj, req);
  if (!v.ok) return { ok: false, unavailable: v.reason.startsWith('behavior:'), reason: v.reason, shape: c.shape, via: c.via };
  return { ok: true, turn: v.turn, grounding: v.grounding, via: c.via };
}
