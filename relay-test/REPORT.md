# relay-test: reply handling and grounded turns (offline only)

No provider calls, deploys or credentials were used for anything in this report. Offline fixtures **cannot prove live behavior**: they prove what the worker sends to the model and what it accepts or rejects. The model's behavior needs a future live test.

Run `node test/run.js` (Node 18+, no network). It has 191 checks:

| Suite | Checks |
|---|---|
| Extraction and schema | 49 |
| Request contract | 8 |
| Prompt properties, across 9 real payloads | 81 |
| Busy-meeting fitting | 14 |
| End to end through the worker's own `fetch` handler (offline in-memory stubs, dry run) | 14 |
| Behavior | 25 |

Of the earlier 138 checks:
- **131 are unchanged.**
- **7 were redefined:** the per-payload "system + raw body < 4,000" check became "fitted model input < 4,000", because the cap moved (see *Input budget*).

`node test/old_compare.js` replays the first deployed build's logic.

## Live history

| Retest | Result | What it showed |
|---|---|---|
| 1 | 5/5 `502 bad_model_output` | The old worker read only a string `response` |
| 2 | 5/5 `200` via `"object"` | Workers AI returns an already-parsed object for this model, which fully explains retest 1. Every turn was schema-valid but empty: `say:""`, `vote:null`, `beliefs:{}`, `act:null`; `plan` empty or generic |

## Why the turns were empty (ranked, with evidence)

> **Scope of this finding.** The five passive live turns answered an **invalid hand-written payload**: no identity (`botId: 3`), no role, and movement options inside a meeting. They do **not** show that the game's real bots are passive, and they say **nothing about game readiness**. The real game payload has not been sent to a live model yet. Do not generalize these five turns.


1. **The request did not match the game's contract, and lacked identity and role.** Strong evidence: comparing the hand-written body with what the game actually sends (payloads captured from its own `aiBody` / `aiDecideBody`, now in `test/payloads/`):

| | Game client (v1) | Live retest body |
|---|---|---|
| Identity | `botId: "<own name>"`, e.g. `"Pink"` | `botId: 3`: the bot did not know who it was |
| Role | First memory line: "You are crew…" / "You are secretly a Saboteur… claimed location…" | Missing: no role |
| Phase | `discussion` / `voting` / `play`, plus `round`, `accused`, `dead` | `discuss` |
| Chat | `{speaker,text}` objects | Plain strings |
| Options | Only on **play**-phase decisions (`ext.event`, `ext.options`), explained by an `EVENT:` memory line | Movement options (`task:Med Lab`, `go:Records`, `wander`) inside a **meeting**, with no meaning given: the model was asked to pick an action that made no sense in that phase |

   The new contract rejects that exact body with `400 bad_request:no_identity` **before** any budget is reserved. It is a test fixture.
2. **The prompt's own escape hatches.** Strong evidence: the previous prompt explicitly offered `"say": "" … to stay silent`, `"vote": … null`, `"beliefs": {} if none` and `"act": … otherwise null`. It also said "Never invent sightings" while the bot had no stated identity. The cheapest valid answer was exactly what came back.
3. **No grounding.** The model got no explanation of the phase (what a discussion turn is for), of the act options, or of who is accused.
4. **Model capability** (8B, fp8). Unverified: it can only be judged once causes 1–3 are fixed, and that needs a live test.

## What changed

- **Request contract** (`src/contract.js`):
  - The game's current **v1** payload is accepted as-is; identity comes from `botId` and role from the role memory line.
  - An explicit **v2** form is also accepted: `{v:2, me:{name, role, partners?}, phase, round, dead, accused, memories, chat, targets, decision?:{event, detail, options}}`.
  - Requests the model cannot act on are refused with **400 before reservation** (they cost nothing):
    - `no_identity`, `no_role`, `phase`, `no_targets`;
    - `options_outside_play`, `play_without_options`.
  - Every option id has a plain meaning, e.g. `kill:Red` = "kill Red now (only if nobody else can see you)".
- **Prompt** (`src/prompt.js`):
  - The system prompt is built per role and phase, at most 858 characters.
  - The situation is rendered as a brief: the bot's name and role, alive and dead players, an "accused: answer it" warning, role notes, its own evidence, chat, the event, and options with their meanings.
  - **No silent escape hatch:**

| Phase | Required | Other rules |
|---|---|---|
| Discussion | `say` (never empty) | Share evidence, answer an accusation, or ask a named player |
| Voting | `vote` (a "suspect" or `"skip"`) | `say` gives the reason |
| Play | `act` (one of the options) | `say` is `""` |

   - Saboteur prompt: never reveal it, never accuse your partner, and keep the account close to the claimed location.
   - The model is **not** offered an "I can't" option.
- **Validation** (`src/turn.js`) has two layers:
  - **Schema** (`schema:*`, unchanged and strict) → `502 bad_model_output`.
  - **Behavior** (`behavior:*`) → an explicit, recognizable fallback: `200 {"unavailable": true, "reason": "behavior:…"}`, never a fake turn. The client should switch that bot to scripted play and can show it. The reasons are:
    - `silent`: no words in `say` during discussion. This is the live retest's output shape.
    - `no_vote`: `null` vote while voting.
    - `vote_belief`: a vote, cast or pre-committed, for someone not marked `"suspect"`.
    - `no_act`: play phase with no action.
    - `self_reveal`: a saboteur says it is one or that it killed.
    - `betrays_partner`: a v2 request listed partners and the turn votes for or suspects one.
    - `model_declined`: the model sent `{"unavailable":true}` (not advertised to it).
  - Play phase: `say` and `vote` are dropped. Nobody hears chat outside a meeting and no vote exists, so nothing is invented.
  - **Not enforced:** naming the bot's own evidence. Per the standing rule, the model owns interpretation of evidence, including withholding it. Instead every accepted turn carries a `grounding` diagnostic: `{evidence: [names in its own evidence], used: [those it actually mentioned, believed, voted for or targeted]}`.
- **Dry-run** replies are built per phase and pass the same validation, which is checked for every real payload.

## Accept vs reject on the real payloads (properties, not strings)

| Scenario | Accepted (example) | Explicit unavailable | Rejected (502) |
|---|---|---|---|
| Witnessed a kill | Names the killer and room, suspects them | Passive turn (`silent`); vote for someone it trusts (`vote_belief`); `model_declined` | — |
| Witnessed a kill, generic line | Accepted, with `grounding.used = []` reported | — | — |
| Accused in chat | Defends with own sighting, questions accuser | Silent; whitespace-only | — |
| Ally (watched a visual task) | Vouches; `beliefs[ally] = trust` | — | Belief about a name not in the game |
| Saboteur | Cover story at the claimed location | `self_reveal`; silent | — |
| No evidence | Honest "didn't see anything" plus a pointed question | Silent | — |
| Voting | Votes the killer with consistent beliefs; `skip` | `no_vote` (incl. the passive turn); `vote_belief` | Vote for the dead victim (not a target) |
| Play kill decision | `kill:Red`, or `wait` (chat dropped) | `no_act` | Invented `kill:Blue` |

All 49 earlier extraction and schema fixtures keep their expectations. Their request was updated to the game's real shape (identity + role line); the two option fixtures now use the play phase.

## Input budget: design (decided here)

**Problem:** the game client packs each AI request to at most **4,000 bytes** (`packBody` in `index.html`, so it also fits the production worker's 4,096-byte body limit). The test worker's first cap, *system prompt + raw body < 4,000*, would have answered real busy meetings with 413.

**Choice:** cap what the **model** receives, not the transport.
- **`MAX_INPUT_CHARS` = 4,000 on the model input:** system prompt + rendered brief, measured after rendering. This keeps the per-call cost bound the cap was for.
- **`MAX_BODY_CHARS` = 24,000 on the raw request:** above the largest body the contract can use (30 chat × 280, 40 memories × 300, 12 targets, 8 options). It only bounds parsing; the model never sees the raw body.
- **No client change is needed:** real game traffic (≤ 4,000 bytes) always passes the transport cap.

**Fitting (`fitMessages`):** the rendered brief is reduced, lowest-value material first, until system + brief < 4,000. Every step leaves a **visible marker in the brief**, and the response tells the caller in `omitted: {chat, public, sightings, votes, other, shortened}`.

| Order | What is reduced | Marker |
|---|---|---|
| 1 | Chat older than the newest 8 that does not mention the bot | "(N older messages omitted to fit)" |
| 2 | Public notes ("Public history…", "In meeting N, X said…", "Meeting N outcome…"), oldest first | "(N older public notes omitted to fit)" |
| 3 | Glimpses ("You glimpsed…"), oldest first | "(N older sightings omitted to fit)" |
| 4 | Long chat lines (except the newest 3) shortened to about 140 chars | "…[shortened]" on the line, and a count in the chat header |
| 5 | Chat down to the newest 4 | "(N older messages omitted to fit)" |
| 6 | Sightings ("You saw … in …"), oldest first | "(N older sightings omitted to fit)" |
| 7 | Own vote records, then other notes, oldest first | "(N older records of your votes omitted to fit)" / "(N older notes omitted to fit)" |
| 8 | Chat down to the newest 1 | "(N older messages omitted to fit)" |

**Never reduced:**
- the bot's identity, role notes, players, dead and the accusation warning;
- protected evidence: "You SAW … kill", a visual task, a vent, tracker, vitals, alibi contradictions, "You were in…", "You last saw…";
- the event and the options with their meanings;
- the newest chat message.

If even that core exceeds the cap, the worker returns `413 {reason: "cannot_fit", size, limit}` **before** any reservation. That is the explicit overflow path, and it is tested with 18 long witnessed-kill lines.

**Why this order:** it follows the classes the game itself writes (`memClasses`) and its own packing order (`packBody` trims old chat first, then public notes and sightings, and keeps role and hard evidence). Messages addressed to the bot are kept longer than others.

**Measured on real and busy payloads:**

| Payload | Model input (chars) | Omitted |
|---|---|---|
| The 7 ordinary captured game payloads | 1,138–1,624 | nothing |
| Busy game payloads (captured from `aiBody`/`packBody` at ~3,830 bytes, round 4–5, 23 memories) | about 3,890 | 5 public notes |
| Synthetic v2 at the protocol limits (12 targets, 30 × 280-char chat, 35 memories) | 3,904 | 20 chat lines, 16 public notes and 5 sightings, with 7 lines shortened. All protected evidence, all 12 players, and the newest and bot-addressed messages are intact |

**Remaining silent loss, outside the worker:** the game client's own `packBody` already drops old chat and notes **silently** to fit its 4,000 bytes. Those lines never reach the worker, so the worker cannot mark them.
- **Recommended client change (not made; `index.html` was not touched):** when `packBody` trims, add one memory line such as "N older chat messages and M older notes were left out."
- It stays within the production worker's limits.

## Known gaps / needs a future live test

- **Whether the model now produces useful turns:** non-empty, grounded, consistent. Measure:
  - the share of `200` turns vs `unavailable` (with reasons) vs `502`;
  - the `grounding.used` rate when evidence is present;
  - whether voting turns pick consistent targets.
- **Input fitting:** the omission markers are visible to the model, but whether this model handles them well is untested.
- **Unverified prompt effects:** whether this model follows the per-phase rules, whether `beliefs` stays within 6 entries, and whether saboteur cover stories stay plausible.
- **Truncation:** at `max_tokens` 400 with the richer prompt, truncation is still possible and would show as `extract:unbalanced`.
- **Not attempted:** JSON mode / `response_format` (untested; a failure would still spend a reservation).
