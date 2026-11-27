// Busy-meeting fixtures beyond what the current game client sends (it packs to <= 4,000 bytes itself):
// v2 requests at the protocol limits (12 targets, 30 chat lines of 280 chars, 40 memory lines), plus genuinely oversized ones.
const T12 = ['Red', 'Blue', 'Green', 'Pink', 'Orange', 'Yellow', 'White', 'Purple', 'Brown', 'Cyan', 'Teal', 'Coral'];
const rooms = ['Cargo Bay', 'Records', 'Med Lab', 'Reactor Core', 'Observatory', 'Hydroponics'];
const long = (k, who) => `Message ${k}: ${who ? who + ', ' : ''}I was in ${rooms[k % 6]} for most of the round doing the long calibration task, then I walked through the hall by ${rooms[(k + 1) % 6]} and saw two people heading toward ${rooms[(k + 2) % 6]} just before the report came in, which seems important.`.slice(0, 280);
const mem = [];
mem.push('You SAW Red kill Cyan in Med Lab (this round).', 'You saw Blue come out of a vent in Cargo Bay (this round).', 'You watched Green do a visual task in Med Lab (this round): they are crew.', 'This round you saw Pink in a different place than what they claimed. It might be a lie, or a mix-up.', 'You were in Records around that time.', 'You last saw Cyan in Med Lab.');
for (let r = 1; r <= 3; r++) mem.push(`In meeting ${r} you voted for ${T12[r]}; ${T12[r]} was not ejected.`);
for (let k = 0; k < 14; k++) mem.push(`In meeting ${1 + (k % 3)}, ${T12[k % 12]} said: "I saw ${T12[(k + 4) % 12]} near ${rooms[k % 6]} and they were acting strange around the vent."`);
mem.push('Public history (a clue, not proof): Orange defended Yellow in 2 previous meetings.', 'Meeting 3 outcome: nobody was ejected (skipped, 6 skip votes).');
for (let k = 0; k < 10; k++) mem.push(k % 2 ? `You glimpsed ${T12[(k + 2) % 12]} in passing in the hall by ${rooms[k % 6]} about ${10 + k * 7}s before the meeting - they may have only been walking through.` : `You saw ${T12[(k + 5) % 12]} in ${rooms[k % 6]} about ${12 + k * 6}s before the meeting.`);
const chat = []; for (let k = 0; k < 30; k++) chat.push({ speaker: T12[k % 12], text: long(k, k % 7 === 0 ? 'Lime' : '') });

export const BUSY = [
  { name: 'v2 at the limits: 12 targets, 30 long chat lines, 40 memories', expect: 'fit',
    body: { v: 2, me: { name: 'Lime', role: 'crew' }, phase: 'discussion', round: 4, dead: ['Cyan', 'Gray'], accused: 'Lime', memories: mem.slice(0, 40), chat, targets: T12 } },
  { name: 'same, voting phase', expect: 'fit',
    body: { v: 2, me: { name: 'Lime', role: 'crew' }, phase: 'voting', round: 4, dead: ['Cyan'], accused: 'Red', memories: mem.slice(0, 40), chat, targets: T12 } },
  { name: 'play decision with 8 options and many memories', expect: 'fit',
    body: { v: 2, me: { name: 'Lime', role: 'saboteur', partners: ['Red'] }, phase: 'play', round: 4, memories: mem.slice(6, 40), targets: T12,
      decision: { event: 'choose_goal', detail: 'Choose what to do next.', options: ['task:Med Lab', 'task:Records', 'task:Cargo Bay', 'go:Observatory', 'go:Hydroponics', 'follow:Blue', 'avoid:Green', 'wander'] } } },
  { name: 'protected core alone exceeds the model cap', expect: 'cannot_fit',
    body: { v: 2, me: { name: 'Lime', role: 'crew' }, phase: 'discussion', round: 9, memories: [...Array(18)].map((_, k) => `You SAW ${T12[k % 12]} kill ${T12[(k + 1) % 12]} in ${rooms[k % 6]} (meeting ${k}). ` + 'x'.repeat(200)), chat: [], targets: T12 } },
  { name: 'raw body over the transport cap', expect: 'body_too_large', raw: 'x'.repeat(24001) },
];
