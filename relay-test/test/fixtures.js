// Offline fixtures for model-reply handling. No network, no provider.
// expect: 'accept' or the exact rejection reason. Covers the plausible shapes behind the 5/5 live 502s.
const REQ = { botId: 3, meeting: { phase: 'discuss' }, memories: [], chat: [], targets: ['Red', 'Blue', 'Lime'] };
const REQ_OPTS = Object.assign({}, REQ, { ext: { v: 1, options: ['task:Med Lab', 'go:Records', 'wander'] } });
const GOOD = { say: 'I was in Med Lab with Blue.', vote: null, beliefs: { Red: 'unsure' }, plan: 'Stay with Blue near Med Lab.', act: null };
const j = o => JSON.stringify(o);
const big = j(GOOD);

export const FIXTURES = [
  // --- clean / tolerated wrappers (all must still pass full validation)
  { name: 'clean JSON', raw: big, req: REQ, expect: 'accept', via: 'clean' },
  { name: 'pretty-printed JSON', raw: JSON.stringify(GOOD, null, 2), req: REQ, expect: 'accept', via: 'clean' },
  { name: 'fenced ```json', raw: '```json\n' + big + '\n```', req: REQ, expect: 'accept', via: 'fenced' },
  { name: 'fenced ``` no language', raw: '```\n' + big + '\n```', req: REQ, expect: 'accept', via: 'fenced' },
  { name: 'prose before', raw: 'Here is my reply:\n' + big, req: REQ, expect: 'accept', via: 'embedded' },
  { name: 'prose after with braces', raw: big + '\nNote: I used {name} format as asked.', req: REQ, expect: 'accept', via: 'embedded' },
  { name: 'prose + fence + prose', raw: 'Sure!\n```json\n' + big + '\n```\nLet me know.', req: REQ, expect: 'accept', via: 'embedded' },
  { name: 'braces inside strings', raw: j(Object.assign({}, GOOD, { plan: 'Check the {vent} map near Records.' })), req: REQ, expect: 'accept' },
  { name: 'escaped quotes in say', raw: j(Object.assign({}, GOOD, { say: 'Blue said "I was in Med Lab".' })), req: REQ, expect: 'accept' },
  { name: 'provider returned an object', raw: Object.assign({}, GOOD), req: REQ, expect: 'accept', via: 'object' },
  { name: 'act chosen from options', raw: j(Object.assign({}, GOOD, { act: 'go:Records' })), req: REQ_OPTS, expect: 'accept' },
  { name: 'vote skip', raw: j(Object.assign({}, GOOD, { vote: 'skip' })), req: REQ, expect: 'accept' },
  { name: 'extra fields dropped', raw: j(Object.assign({}, GOOD, { reasoning: 'long hidden reasoning', confidence: 0.9 })), req: REQ, expect: 'accept', dropped: ['reasoning', 'confidence'] },
  // --- truncation (max_tokens): never repaired
  { name: 'truncated mid-string', raw: big.slice(0, 40), req: REQ, expect: 'extract:unbalanced' },
  { name: 'truncated before final brace', raw: big.slice(0, -1), req: REQ, expect: 'extract:unbalanced' },
  { name: 'truncated inside fence', raw: '```json\n' + big.slice(0, 60), req: REQ, expect: 'extract:unbalanced' },
  // --- no object / not text / not JSON
  { name: 'prose only', raw: 'I think Red is suspicious, I vote Red.', req: REQ, expect: 'extract:no_object' },
  { name: 'empty string', raw: '', req: REQ, expect: 'extract:no_object' },
  { name: 'undefined response', raw: undefined, req: REQ, expect: 'extract:not_text' },
  { name: 'number response', raw: 42, req: REQ, expect: 'extract:not_text' },
  { name: 'array response', raw: [GOOD], req: REQ, expect: 'extract:not_text' },
  { name: 'JS-style object (single quotes, bare keys)', raw: "{say: 'hi', vote: null, beliefs: {}, plan: 'x', act: null}", req: REQ, expect: 'extract:parse' },
  { name: 'trailing comma', raw: '{"say":"hi","vote":null,"beliefs":{},"plan":"x","act":null,}', req: REQ, expect: 'extract:parse' },
  { name: 'first object is not the turn (example echo)', raw: 'Format: {"say": string}\n' + big, req: REQ, expect: 'extract:parse' },
  // --- schema drift: missing fields
  ...['say', 'vote', 'beliefs', 'plan', 'act'].map(k => { const o = Object.assign({}, GOOD); delete o[k]; return { name: 'missing ' + k, raw: j(o), req: REQ, expect: 'schema:missing_' + k }; }),
  { name: 'empty object', raw: '{}', req: REQ, expect: 'schema:missing_say' },
  // --- schema drift: wrong types / invented values
  { name: 'say is a number', raw: j(Object.assign({}, GOOD, { say: 5 })), req: REQ, expect: 'schema:say' },
  { name: 'say over 200 chars', raw: j(Object.assign({}, GOOD, { say: 'a'.repeat(201) })), req: REQ, expect: 'schema:say' },
  { name: 'say with a link', raw: j(Object.assign({}, GOOD, { say: 'see https://x.example' })), req: REQ, expect: 'schema:say' },
  { name: 'say with markup', raw: j(Object.assign({}, GOOD, { say: '<b>Red</b> did it' })), req: REQ, expect: 'schema:say' },
  { name: 'say leaks JSON', raw: j(Object.assign({}, GOOD, { say: '{"vote":"Red"}' })), req: REQ, expect: 'schema:say' },
  { name: 'say with control char', raw: j(Object.assign({}, GOOD, { say: 'hi\u0007' })), req: REQ, expect: 'schema:say' },
  { name: 'vote for a name not in targets (invented)', raw: j(Object.assign({}, GOOD, { vote: 'Purple' })), req: REQ, expect: 'schema:vote' },
  { name: 'vote wrong case', raw: j(Object.assign({}, GOOD, { vote: 'red' })), req: REQ, expect: 'schema:vote' },
  { name: 'vote as array', raw: j(Object.assign({}, GOOD, { vote: ['Red'] })), req: REQ, expect: 'schema:vote' },
  { name: 'beliefs as array', raw: j(Object.assign({}, GOOD, { beliefs: ['Red'] })), req: REQ, expect: 'schema:beliefs' },
  { name: 'beliefs null', raw: j(Object.assign({}, GOOD, { beliefs: null })), req: REQ, expect: 'schema:beliefs' },
  { name: 'belief about an unknown player', raw: j(Object.assign({}, GOOD, { beliefs: { Purple: 'suspect' } })), req: REQ, expect: 'schema:beliefs_entry' },
  { name: 'belief with a free-text value', raw: j(Object.assign({}, GOOD, { beliefs: { Red: 'very sus' } })), req: REQ, expect: 'schema:beliefs_entry' },
  { name: 'too many beliefs', raw: j(Object.assign({}, GOOD, { beliefs: Object.fromEntries([...Array(7)].map((_, i) => ['P' + i, 'unsure'])) })), req: Object.assign({}, REQ, { targets: [...Array(7)].map((_, i) => 'P' + i) }), expect: 'schema:beliefs_count' },
  { name: 'plan as object', raw: j(Object.assign({}, GOOD, { plan: { next: 'tasks' } })), req: REQ, expect: 'schema:plan' },
  { name: 'act not in options (invented)', raw: j(Object.assign({}, GOOD, { act: 'kill:Red' })), req: REQ_OPTS, expect: 'schema:act' },
  { name: 'act given but no options offered', raw: j(Object.assign({}, GOOD, { act: 'wander' })), req: REQ, expect: 'schema:act' },
  { name: 'top-level array', raw: '[' + big + ']', req: REQ, expect: 'accept', via: 'embedded', note: 'first balanced object inside the array is the turn; it still passes full validation' },
  { name: 'oversized reply', raw: 'x'.repeat(20001), req: REQ, expect: 'extract:too_long' },
];
