# Reply-handling hardening (offline only)

No provider calls, deploys or credentials were used. Run the suite with `node test/run.js` (Node 18+, no network). `node test/old_compare.js` shows how the deployed build would have handled each fixture.

## What the live 502s can and cannot have been

The deployed worker (7c3610a) did **no schema validation**. Its handling was:
- read `out.response`, but only if it was a string;
- `JSON.parse` the span from the first `{` to the last `}`;
- fill any missing field with a default.

So `{}` would have been accepted, and all five `bad_model_output` replies were **extraction or parse failures**, not schema failures. `test/old_compare.js` shows that the old logic **accepted** fenced JSON and prose before the JSON, so neither alone explains the failures.

The live 502s must have come from one or more of these:
- `response` was not a string: the provider returned an object (already parsed JSON), `undefined`, or another shape;
- truncation at `max_tokens` (no closing brace);
- no JSON in the reply at all;
- trailing prose that contained braces after the JSON;
- invalid JSON syntax (single quotes, bare keys, trailing commas);
- an example object echoed before the real one.

Nothing was retained, so which of these happened is **unverified**.

## New handling (`src/turn.js`)

1. **Extraction** (tolerant):
   - a plain object returned by the provider is used as-is;
   - otherwise code fences are stripped and the **first balanced top-level `{…}`** is taken, respecting JSON strings and escapes, and parsed.
   - It never repairs anything: a truncated object, invalid syntax, or a first object that isn't the turn are all rejected.
   - Only the first object is ever tried.
2. **Validation** (strict; every candidate, however it was found, must pass):

| Field | Required check |
|---|---|
| All | All five fields present |
| `say` | String of at most 200 characters, with no control characters, markup, links, code fences or embedded JSON |
| `vote` | `null`, `"skip"`, or exactly one of the request's `targets` (case-sensitive) |
| `beliefs` | Plain object, at most 6 entries; every key is in `targets` and every value is `trust`, `suspect` or `unsure` |
| `plan` | String, at most 160 characters, same text rules as `say` |
| `act` | `null`, or exactly one of `ext.options`; must be `null` when no options were offered |

   Extra top-level fields are **dropped** (the old worker dropped them too); only the five contract fields ever leave the worker.
3. **Diagnostics without content:** a rejection returns `reason` (for example `extract:unbalanced` or `schema:vote`) plus `shape`:
   - type and length;
   - whether the reply was fenced, how many `{` it contained, and whether it starts with `{`.

   The model's text is never returned or stored. A future live call will show *which* shape occurred.
4. **Prompt changes** (`SYSTEM_PROMPT`, 583 characters, which leaves at most 3,416 characters for the request body):
   - "Output ONLY one JSON object: no prose, no markdown, no code fences";
   - all keys marked required;
   - at most 3 beliefs and a plan of at most 100 characters, to lower the risk of truncation.

   The validator is deliberately a little wider than the prompt asks for (6 beliefs, 160-character plan), so a slightly long but otherwise valid turn isn't rejected. It stays strict on everything that matters.
   - **Unchanged:** `max_tokens` 400, the 8 s timeout, and the model.
   - **The dry-run reply** goes through the same extraction and validation as a real one.

## Accept vs reject (49 fixtures, all as expected)

**Accepted** (after full validation):
- clean JSON, pretty-printed JSON;
- fenced with or without a language tag;
- prose before the JSON;
- prose after, even prose containing braces;
- prose + fence + prose;
- braces or escaped quotes inside strings;
- a provider-returned object;
- `act` taken from the offered options;
- `vote: "skip"`;
- extra fields, which are dropped;
- a turn wrapped in an array (its first object still passes full validation).

**Rejected:**

| Reason | Cases |
|---|---|
| `extract:unbalanced` | Truncation: mid-string, before the final brace, inside a fence |
| `extract:no_object` | Prose only, empty string |
| `extract:not_text` | `undefined`, number, array |
| `extract:parse` | JS-style object (single quotes, bare keys), trailing comma, an example object echoed before the real one |
| `schema:missing_*` | Each missing field, empty object |
| `schema:say` | Wrong type, over 200 characters, link, markup, embedded JSON, control character |
| `schema:vote` | Invented name, wrong case, array |
| `schema:beliefs*` | Array, null, unknown player, free-text value, too many entries |
| `schema:plan` | Wrong type |
| `schema:act` | Invented action, or `act` given when no options were offered |
| `extract:too_long` | Reply over 20,000 characters |

## Still unverifiable without a future live test

- **Actual failure cause:** which of the shapes above the model really produced (the new `reason`/`shape` fields will say).
- **Prompt effect:** whether the new prompt and the smaller beliefs/plan really cut prose, fences and truncation for `@cf/meta/llama-3.1-8b-instruct-fp8-fast`.
- **Success rate:** how often a real reply passes the strict validation, especially `vote` and `beliefs` names, which must exactly match `targets`.
- **JSON mode:** whether Workers AI JSON mode (`response_format`) is supported for this model and would help. It is deliberately **not** enabled: untested, and a failure would still use up a reservation.
- **Response object shape:** what this model actually returns in `out.response` (string or object).
