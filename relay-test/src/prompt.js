// Prompt builder: a short system prompt per role + phase, and a rendered brief of the bot's situation.
// No escape hatch is offered where the phase does not allow one (no "" say in a meeting discussion, no null vote
// when voting, no null act when options are offered). The model is never told how to say "I can't".
import { describeOption, isAccused } from './contract.js';

const BASE = 'You are {NAME}, a player in Kestrel Station, a social deduction game on a space station. Crew do tasks and vote out the Saboteurs; Saboteurs secretly kill and sabotage. Reply with ONE JSON object and nothing else: no prose, no markdown, no code fences.';

const ROLE = {
  crew: 'You are CREW. You know only YOUR EVIDENCE and the CHAT below. Name players and rooms from your evidence. A glimpse is weak evidence; seeing a kill or a vent is strong evidence.',
  saboteur: 'You are a SABOTEUR. Never reveal it and never accuse your partner. Blend in: give a believable account that stays close to your claimed location, and cast doubt on others when it helps you.'
};

const PHASE = {
  discussion: 'MEETING, DISCUSSION. Keys: "say": 1-2 sentences you say to the group now; required, never empty. Share your strongest evidence (who, where), or answer an accusation against you, or ask one named player a pointed question. "beliefs": for each player your evidence or the chat involves, "suspect", "trust" or "unsure". "vote": null, or the name you intend to vote for. "plan": one short sentence. "act": null.',
  voting: 'MEETING, VOTING. Keys: "vote": required; a name you marked "suspect" in beliefs, or "skip" if nobody is clearly suspicious. "say": one short line giving the reason for your vote. "beliefs": for each player your evidence or the chat involves, "suspect", "trust" or "unsure". "plan": one short sentence. "act": null.',
  play: 'NOT IN A MEETING: nobody hears you. Keys: "act": required; exactly one id from OPTIONS. "say": "". "vote": null. "beliefs": your current view of players involved, "suspect", "trust" or "unsure". "plan": one short sentence.'
};

export function buildSystem(req) {
  return [BASE.replace('{NAME}', req.name), ROLE[req.role], PHASE[req.phase]].join('\n');
}

// view: what fits (chat lines, evidence lines) plus counts of what was left out; defaults to everything.
export function buildBrief(req, view) {
  const v = view || { chat: req.chat, evidence: req.evidence, om: {} }, om = v.om || {};
  const L = [];
  L.push(`YOU: ${req.name} (${req.role === 'saboteur' ? 'secret Saboteur' : 'crew'}). Round ${req.round}, ${req.phase}.`);
  if (req.partners.length) L.push('YOUR PARTNER: ' + req.partners.join(', '));
  L.push('ALIVE OTHERS: ' + req.targets.join(', '));
  if (req.dead.length) L.push('DEAD: ' + req.dead.join(', '));
  if (req.phase !== 'play' && isAccused(req)) L.push(`WARNING: you (${req.name}) are being accused. Answer it.`);
  if (req.roleLines.length) L.push('ROLE NOTES:\n' + req.roleLines.map(x => '- ' + x).join('\n'));
  const evMarks = [['public', 'older public notes'], ['sightings', 'older sightings'], ['votes', 'older records of your votes'], ['other', 'older notes']]
    .filter(([k]) => om[k]).map(([k, w]) => `- (${om[k]} ${w} omitted to fit)`);
  L.push('YOUR EVIDENCE:\n' + (v.evidence.length || evMarks.length ? evMarks.concat(v.evidence.map(x => '- ' + x)).join('\n') : '- nothing specific'));
  if (req.phase !== 'play') {
    const head = om.chat ? [`- (${om.chat} older messages omitted to fit)`] : [];
    L.push('CHAT (oldest first' + (om.shortened ? `; ${om.shortened} long messages shortened, marked …[shortened]` : '') + '):\n' + (v.chat.length || head.length ? head.concat(v.chat.map(c => `- ${c.speaker}: ${c.text}`)).join('\n') : '- (no messages yet)'));
  }
  if (req.detail) L.push('EVENT: ' + req.detail);
  if (req.options.length) L.push('OPTIONS:\n' + req.options.map(o => `- ${o} = ${describeOption(o)}`).join('\n'));
  return L.join('\n');
}

// Evidence classes, from the exact line formats the game writes (index.html memClasses / recordHistory / socialNotes).
// Protected lines are never dropped: direct evidence, this meeting's facts, contradictions.
export function evidenceClass(x) {
  if (/^You SAW .* kill|^You watched .* visual task|come out of a vent|^Your tracker showed|^Vitals showed|different place than what they claimed/i.test(x)) return 'hard';
  if (/^You were in |^You last saw /.test(x)) return 'now';
  if (/^You glimpsed /.test(x)) return 'glimpse';
  if (/^You saw /.test(x)) return 'sight';
  if (/^In meeting \d+ you (voted|skipped)/.test(x)) return 'vote';
  if (/^Public history|^In meeting \d+, .* said:|^Meeting \d+ outcome/.test(x)) return 'public';
  return 'other';
}

// Fit system + rendered brief under cap characters. Lowest-value material goes first, always with a visible marker:
//  1 chat older than the newest 8 that does not mention this bot   5 chat down to the newest 4
//  2 public notes, oldest first                                     6 sightings ("You saw"), oldest first
//  3 glimpses, oldest first                                         7 own vote records, then other notes, oldest first
//  4 long chat lines (except the newest 3) shortened to 140 chars   8 chat down to the newest 1
// Never dropped: identity, role notes, players, accusation warning, protected evidence, event, options.
// Returns { ok, messages, omitted, size } or { ok:false, reason:'cannot_fit', size }.
export function fitMessages(req, cap) {
  const system = buildSystem(req);
  const ev = req.evidence.map((text, i) => ({ text, i, cls: evidenceClass(text) }));
  let chat = req.chat.map((c, i) => ({ c, i }));
  const om = {};
  const view = () => ({ chat: chat.map(x => x.c), evidence: ev.map(x => x.text), om });
  const size = () => system.length + 1 + buildBrief(req, view()).length;
  const fits = () => size() < cap;
  const bump = k => { om[k] = (om[k] || 0) + 1; };
  const meRx = new RegExp('\\b' + req.name + '\\b', 'i');
  const dropEv = (classes, key) => { while (!fits()) { const j = ev.findIndex(x => classes.includes(x.cls)); if (j < 0) return; ev.splice(j, 1); bump(key); } };
  const dropChat = (keep, spare) => { while (!fits() && chat.length > keep) { const j = spare ? chat.findIndex((x, n) => n < chat.length - keep && !meRx.test(x.c.text)) : 0; if (j < 0) return; chat.splice(j, 1); bump('chat'); } };
  if (!fits()) dropChat(8, true);
  if (!fits()) dropEv(['public'], 'public');
  if (!fits()) dropEv(['glimpse'], 'sightings');
  if (!fits()) { for (let n = 0; n < chat.length - 3 && !fits(); n++) { const c = chat[n].c; if (c.text.length > 140) { chat[n] = { c: { speaker: c.speaker, text: c.text.slice(0, 140).replace(/\s+\S*$/, '') + ' …[shortened]' }, i: chat[n].i, short: true }; om.shortened = chat.filter(x => x.short).length; } } }
  if (!fits()) dropChat(4, false);
  if (!fits()) dropEv(['sight'], 'sightings');
  if (!fits()) dropEv(['vote'], 'votes');
  if (!fits()) dropEv(['other'], 'other');
  if (!fits()) dropChat(1, false);
  if (om.shortened) om.shortened = chat.filter(x => x.short).length || undefined; // only lines still shown
  if (!om.shortened) delete om.shortened;
  if (!fits()) return { ok: false, reason: 'cannot_fit', size: size() };
  return { ok: true, messages: [{ role: 'system', content: system }, { role: 'user', content: buildBrief(req, view()) }], omitted: om, size: size() };
}

// Unfitted messages (everything); the worker uses fitMessages.
export function buildMessages(req) {
  return [{ role: 'system', content: buildSystem(req) }, { role: 'user', content: buildBrief(req) }];
}

// Dry-run reply: deterministic, phase-appropriate, and validated exactly like a model reply.
export function dryReply(req) {
  const ev = req.targets.find(t => req.evidence.some(x => new RegExp('\\b' + t + '\\b').test(x)));
  const r = { say: ev ? `Dry run: I have something to say about ${ev}.` : 'Dry run: where was everyone?', vote: null, beliefs: ev ? { [ev]: req.phase === 'voting' ? 'suspect' : 'unsure' } : {}, plan: 'Dry run plan.', act: null };
  if (req.phase === 'voting') r.vote = ev || 'skip';
  if (req.phase === 'play') { r.say = ''; r.act = req.options[0]; }
  return r;
}
