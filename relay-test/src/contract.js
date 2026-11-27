// Request contract for skeld-game-relay-test. Pure functions, tested offline (test/run.js).
//
// Accepts two shapes and normalizes both to one internal form:
//  - v1: exactly what the game client sends today (index.html aiBody / ai-driven-1 aiDecideBody):
//      { botId: "<own name>", meeting: { phase: "discussion"|"voting"|"play", round, accused, dead[] },
//        memories: ["You are crew..." | "You are secretly a Saboteur...", ...evidence], chat: [{speaker,text}],
//        targets: [names], ext?: { v:1, want:[...], event?, options?: ["task:Med Lab", ...] } }
//  - v2: the explicit form proposed for the next client: { v:2, me:{name, role, partners?}, phase, round,
//        dead[], accused, memories[], chat[{speaker,text}], targets[], decision?:{event, detail, options[]} }
// A request the model cannot act on sensibly is rejected here (400, before any budget is reserved):
// no identity, no role, options outside the play phase, play phase without options, empty targets.

const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o);
const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
const NAME_RX = /^[A-Za-z][A-Za-z0-9 _-]{0,13}$/;

const PHASES = { discussion: 'discussion', discuss: 'discussion', voting: 'voting', vote: 'voting', play: 'play' };

// What each option id means, so the model is choosing between actions, not opaque strings.
export function describeOption(id) {
  const [verb, ...rest] = String(id).split(':'); const arg = rest.join(':');
  switch (verb) {
    case 'task': return `walk to ${arg} and do your task there`;
    case 'go': return `walk to ${arg}`;
    case 'follow': return `follow ${arg} and keep them in sight`;
    case 'avoid': return `move away from ${arg}`;
    case 'wander': return 'walk around without a fixed goal';
    case 'kill': return `kill ${arg} now (only if nobody else can see you)`;
    case 'wait': return 'do not kill now';
    case 'sabotage': return arg === 'melt' ? 'start a reactor meltdown sabotage' : arg === 'o2' ? 'start an oxygen sabotage' : `start the ${arg} sabotage`;
    case 'not_now': return 'do not sabotage now';
    case 'report': return 'report the body you found (calls a meeting)';
    case 'stay_quiet': return 'leave the body unreported';
    case 'call_meeting': return 'ring the emergency bell to call a meeting';
    case 'keep_quiet': return 'do not call a meeting';
    default: return 'option ' + id;
  }
}

function roleFromMemories(mem) {
  for (const m of mem) {
    if (/^You are secretly a Saboteur/i.test(m)) return 'saboteur';
    if (/^You are crew/i.test(m)) return 'crew';
  }
  return null;
}
const ROLE_LINE = /^(You are crew|You are secretly a Saboteur|Your claimed location|You actually went to|Notes from earlier meetings)/i;

export function normalizeRequest(o) {
  if (!isPlain(o)) return { ok: false, reason: 'bad_request:not_object' };
  const v2 = o.v === 2;
  const memories = (Array.isArray(o.memories) ? o.memories : []).filter(x => typeof x === 'string').map(x => x.slice(0, 300)).slice(0, 40);
  const name = v2 ? (isPlain(o.me) ? o.me.name : null) : o.botId;
  if (typeof name !== 'string' || !NAME_RX.test(name)) return { ok: false, reason: 'bad_request:no_identity' };
  const role = v2 ? (isPlain(o.me) ? o.me.role : null) : roleFromMemories(memories);
  if (role !== 'crew' && role !== 'saboteur') return { ok: false, reason: 'bad_request:no_role' };
  const m = v2 ? o : (isPlain(o.meeting) ? o.meeting : {});
  const phase = PHASES[m.phase];
  if (!phase) return { ok: false, reason: 'bad_request:phase' };
  const targets = (Array.isArray(o.targets) ? o.targets : []).filter(t => typeof t === 'string' && NAME_RX.test(t) && t !== name).slice(0, 12);
  if (!targets.length) return { ok: false, reason: 'bad_request:no_targets' };
  const chat = (Array.isArray(o.chat) ? o.chat : []).map(c => {
    if (isPlain(c)) return { speaker: str(c.speaker, 20) || '?', text: str(c.text, 280) };
    if (typeof c === 'string') { const i = c.indexOf(':'); return i > 0 && i < 20 ? { speaker: c.slice(0, i).trim(), text: c.slice(i + 1).trim().slice(0, 280) } : { speaker: '?', text: c.slice(0, 280) }; }
    return null;
  }).filter(c => c && c.text).slice(-30);
  const dec = v2 ? (isPlain(o.decision) ? o.decision : null) : (isPlain(o.ext) ? o.ext : null);
  let options = dec && Array.isArray(dec.options) ? dec.options.filter(x => typeof x === 'string' && x.length <= 40).slice(0, 8) : [];
  if (options.length && phase !== 'play') return { ok: false, reason: 'bad_request:options_outside_play' };
  if (phase === 'play' && !options.length) return { ok: false, reason: 'bad_request:play_without_options' };
  const event = dec ? str(dec.event, 40) : '';
  // v1 play decisions carry the event text as the 'EVENT: ...' memory line
  const detail = v2 ? str(dec && dec.detail, 300) : (memories.find(x => x.startsWith('EVENT: ')) || '').slice(7);
  return {
    ok: true,
    req: {
      name, role, phase,
      round: Number.isInteger(m.round) && m.round > 0 ? m.round : 1,
      dead: (Array.isArray(m.dead) ? m.dead : []).filter(t => typeof t === 'string').slice(0, 12),
      accused: typeof m.accused === 'string' ? m.accused.slice(0, 14) : '',
      partners: v2 && isPlain(o.me) && Array.isArray(o.me.partners) ? o.me.partners.filter(t => typeof t === 'string').slice(0, 2) : [],
      roleLines: memories.filter(x => ROLE_LINE.test(x)),
      evidence: memories.filter(x => !ROLE_LINE.test(x) && !x.startsWith('EVENT: ')),
      chat, targets, options, event, detail
    }
  };
}

// Names (from targets) that the bot's own evidence or the chat ties to something; used for grounding checks.
export function evidenceNames(req) {
  const own = req.evidence.filter(x => !/^Public history/i.test(x)).join('\n');
  return req.targets.filter(t => new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(own));
}
// Is the bot itself accused in the meeting (by the meeting summary or by a chat line naming it with an accusation)?
export function isAccused(req) {
  if (req.accused === req.name) return true;
  const rx = new RegExp('\\b' + req.name + '\\b', 'i');
  return req.chat.some(c => c.speaker !== req.name && rx.test(c.text) && /\b(sus|suspicious|vent|kill|killed|lying|liar|lie|saboteur|impostor|vote)\b/i.test(c.text));
}
