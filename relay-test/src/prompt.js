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

export function buildBrief(req) {
  const L = [];
  L.push(`YOU: ${req.name} (${req.role === 'saboteur' ? 'secret Saboteur' : 'crew'}). Round ${req.round}, ${req.phase}.`);
  if (req.partners.length) L.push('YOUR PARTNER: ' + req.partners.join(', '));
  L.push('ALIVE OTHERS: ' + req.targets.join(', '));
  if (req.dead.length) L.push('DEAD: ' + req.dead.join(', '));
  if (req.phase !== 'play' && isAccused(req)) L.push(`WARNING: you (${req.name}) are being accused. Answer it.`);
  if (req.roleLines.length) L.push('ROLE NOTES:\n' + req.roleLines.map(x => '- ' + x).join('\n'));
  L.push('YOUR EVIDENCE:\n' + (req.evidence.length ? req.evidence.map(x => '- ' + x).join('\n') : '- nothing specific'));
  if (req.phase !== 'play') L.push('CHAT (oldest first):\n' + (req.chat.length ? req.chat.map(c => `- ${c.speaker}: ${c.text}`).join('\n') : '- (no messages yet)'));
  if (req.detail) L.push('EVENT: ' + req.detail);
  if (req.options.length) L.push('OPTIONS:\n' + req.options.map(o => `- ${o} = ${describeOption(o)}`).join('\n'));
  return L.join('\n');
}

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
