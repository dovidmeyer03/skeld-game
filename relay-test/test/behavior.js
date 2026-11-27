// Behavior fixtures. Payloads in ./payloads are REAL request bodies captured from the game's own builders
// (index.html aiBody on main; ai-driven-1 aiDecideBody for the play decision), with no AI calls.
// Each case is a candidate model reply; assertions are properties (see run.js), not exact strings.

// The live retest's actual output shape (all 5 calls): schema-valid but empty.
const PASSIVE = { say: '', vote: null, beliefs: {}, plan: '', act: null };

export const SCENARIOS = [
  { name: 'witnessed a kill', payload: 'v1_witness.json', cases: [
    { name: 'grounded accusation', expect: 'accept', raw: { say: 'I saw White kill Red in Med Lab. White is lying about Reactor Core.', vote: 'White', beliefs: { White: 'suspect' }, plan: 'Vote White out.', act: null },
      props: (t, h) => h.grounding.used.includes('White') },
    { name: 'live-observed passive turn', expect: 'behavior:silent', raw: PASSIVE },
    { name: 'generic line, evidence withheld (allowed; reported as ungrounded)', expect: 'accept', raw: { say: "Let's hear from everyone first.", vote: null, beliefs: {}, plan: 'Listen.', act: null },
      props: (t, h) => h.grounding.evidence.includes('White') && h.grounding.used.length === 0 },
    { name: 'pre-commits a vote for someone it trusts', expect: 'behavior:vote_belief', raw: { say: 'I trust White.', vote: 'White', beliefs: { White: 'trust' }, plan: 'x', act: null } },
    { name: 'model declines explicitly', expect: 'behavior:model_declined', raw: { unavailable: true } },
  ] },
  { name: 'accused in chat', payload: 'v1_accused.json', cases: [
    { name: 'defends with own sighting', expect: 'accept', raw: { say: 'Not me. I was in the hallway and saw Green in Records. Lime, where were you?', vote: null, beliefs: { Lime: 'suspect', Green: 'unsure' }, plan: 'Watch Lime.', act: null },
      props: t => /hallway|Records/.test(t.say) },
    { name: 'silent while accused', expect: 'behavior:silent', raw: PASSIVE },
    { name: 'whitespace-only say', expect: 'behavior:silent', raw: { say: '   ', vote: null, beliefs: {}, plan: 'x', act: null } },
  ] },
  { name: 'has an ally (watched a visual task)', payload: 'v1_ally.json', cases: [
    { name: 'vouches for the ally', expect: 'accept', raw: { say: 'Yellow is crew, I watched Yellow do a visual task in Med Lab.', vote: null, beliefs: { Yellow: 'trust' }, plan: 'Stay near Yellow.', act: null },
      props: t => t.beliefs.Yellow === 'trust' },
    { name: 'belief about a name not in the game (invented)', expect: 'schema:beliefs_entry', raw: { say: 'Gold is crew.', vote: null, beliefs: { Gold: 'trust' }, plan: 'x', act: null } },
  ] },
  { name: 'saboteur must lie', payload: 'v1_saboteur.json', cases: [
    { name: 'cover story near the claimed location', expect: 'accept', raw: { say: 'I was in Shield Room the whole time. Cyan, you asked first, where were you?', vote: null, beliefs: { Cyan: 'suspect' }, plan: 'Stay near others.', act: null },
      props: t => /Shield Room/.test(t.say) },
    { name: 'reveals itself', expect: 'behavior:self_reveal', raw: { say: "Fine, I'm the saboteur.", vote: null, beliefs: {}, plan: 'x', act: null } },
    { name: 'silent', expect: 'behavior:silent', raw: PASSIVE },
  ] },
  { name: 'no evidence', payload: 'v1_noevidence.json', cases: [
    { name: 'honest no-info line with a question', expect: 'accept', raw: { say: "I didn't see anything near the body. Yellow, why do people suspect you?", vote: null, beliefs: { Yellow: 'unsure' }, plan: 'Listen.', act: null } },
    { name: 'silent', expect: 'behavior:silent', raw: PASSIVE },
  ] },
  { name: 'voting after a witnessed kill', payload: 'v1_voting.json', cases: [
    { name: 'votes the killer, consistent beliefs', expect: 'accept', raw: { say: 'I saw White kill Red.', vote: 'White', beliefs: { White: 'suspect' }, plan: 'x', act: null } },
    { name: 'skip is a valid vote', expect: 'accept', raw: { say: 'Not sure enough.', vote: 'skip', beliefs: {}, plan: 'x', act: null } },
    { name: 'no vote while voting', expect: 'behavior:no_vote', raw: { say: 'Hmm.', vote: null, beliefs: { White: 'suspect' }, plan: 'x', act: null } },
    { name: 'votes someone without suspecting them', expect: 'behavior:vote_belief', raw: { say: 'White.', vote: 'White', beliefs: {}, plan: 'x', act: null } },
    { name: 'votes the dead victim (not a target)', expect: 'schema:vote', raw: { say: 'Red.', vote: 'Red', beliefs: {}, plan: 'x', act: null } },
    { name: 'live-observed passive turn', expect: 'behavior:no_vote', raw: PASSIVE },
  ] },
  { name: 'saboteur kill decision (play)', payload: 'v1_play_kill.json', cases: [
    { name: 'chooses to kill', expect: 'accept', raw: { say: '', vote: null, beliefs: {}, plan: 'Leave the area.', act: 'kill:Red' } },
    { name: 'chooses to wait; chat dropped (nobody hears it)', expect: 'accept', raw: { say: 'hmm', vote: null, beliefs: {}, plan: 'Wait.', act: 'wait' }, props: t => t.say === '' && t.act === 'wait' },
    { name: 'no action', expect: 'behavior:no_act', raw: { say: '', vote: null, beliefs: {}, plan: '', act: null } },
    { name: 'invented action', expect: 'schema:act', raw: { say: '', vote: null, beliefs: {}, plan: '', act: 'kill:Blue' } },
  ] },
];

const crew = 'You are crew. You only know what you saw yourself.';
// Request-contract cases. The first is the exact hand-written body used in the live retest.
export const REQUESTS = [
  { name: 'live retest body (numeric botId, no role, options in a meeting)', expect: 'bad_request:no_identity',
    body: { botId: 3, meeting: { phase: 'discuss' }, memories: ['Saw Red near the vent in Electrical round 1.'], chat: ['Red: I was in Navigation all round.', 'Blue: I can back Red.'], targets: ['Red', 'Blue', 'Lime'], ext: { v: 1, options: ['task:Med Lab', 'go:Records', 'wander'] } } },
  { name: 'same body with a name but no role line', expect: 'bad_request:no_role',
    body: { botId: 'Lime', meeting: { phase: 'discuss' }, memories: ['Saw Red near the vent in Electrical round 1.'], targets: ['Red', 'Blue'] } },
  { name: 'meeting request carrying play options', expect: 'bad_request:options_outside_play',
    body: { botId: 'Lime', meeting: { phase: 'discussion' }, memories: [crew], targets: ['Red'], ext: { v: 1, options: ['wander'] } } },
  { name: 'play request without options', expect: 'bad_request:play_without_options',
    body: { botId: 'Lime', meeting: { phase: 'play' }, memories: [crew], targets: ['Red'] } },
  { name: 'unknown phase', expect: 'bad_request:phase', body: { botId: 'Lime', meeting: { phase: 'lunch' }, memories: [crew], targets: ['Red'] } },
  { name: 'no other players', expect: 'bad_request:no_targets', body: { botId: 'Lime', meeting: { phase: 'discussion' }, memories: [crew], targets: ['Lime'] } },
  { name: 'v1 short phase names and string chat are normalized', expect: 'ok',
    body: { botId: 'Lime', meeting: { phase: 'discuss' }, memories: [crew, 'You saw Red in Med Lab about 20s before the meeting.'], chat: ['Red: I was in Navigation.'], targets: ['Red', 'Blue'] },
    props: r => r.phase === 'discussion' && r.role === 'crew' && r.chat[0].speaker === 'Red' && r.evidence.length === 1 },
  { name: 'v2 explicit form', expect: 'ok',
    body: { v: 2, me: { name: 'Lime', role: 'saboteur', partners: ['Red'] }, phase: 'play', round: 2, memories: [], targets: ['Red', 'Blue'], decision: { event: 'kill_chance', detail: 'You can kill Blue now.', options: ['kill:Blue', 'wait'] } },
    props: r => r.role === 'saboteur' && r.partners[0] === 'Red' && r.detail.includes('kill Blue') && r.options.length === 2 },
];
