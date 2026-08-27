# review-findings/v1

> **Status: DRAFT (draft_revision 1) — NOT FROZEN.** Part of the Evidence-Closed Delivery
> Shadow Evidence Contracts (Milestone F). No reference implementer exists yet; lane's
> intended role is vendor + verify only (never a model call from this contract). Freezing
> follows this repo's freeze-after-exercise discipline (see `release-evidence/v0`'s own
> Status note) — not before a real reviewer emits a real record and a real receipt consumes it.

Normative protocol for a **review-findings record**: an immutable observation of what a
reviewer found (or explicitly did not find, or could not determine) in one recorded
`scan_scope` of one subject digest. Grounded in the Evidence-Closed Delivery plan's
Authority DAG (`review-findings → promotion-receipt → release-approval`) — this contract
carries **no promotion authority whatsoever**. It only records what was observed; it never
decides anything.

Conformance fixtures: [`contracts/review-findings/v1/`](../../contracts/review-findings/v1/)
— run `node contracts/review-findings/v1/verify-fixtures.mjs` (zero dependencies, no network).

## Naming: `reviewer` → `assessor`

The source spec's EARS requirements name this field `reviewer`. This schema uses `assessor`
instead, naming the exact same concept (what kind of thing produced the finding — never a
person), because `contracts/shared/personal-dimensions.mjs`'s forbidden-key set already
contains `reviewer`: a record with a top-level `reviewer` object would fail the mandatory
personal-dimension scan on every single accepting fixture, permanently. `decision/v1` hit the
identical collision with `reviewer`/`critic_engine` and resolved it the same way — see that
protocol's own note on `engine_ref`/`critic`/`decision_channel`. This is a builder-time
correction to the spec, not a semantic change to what the field means.

## Identity: subject digest binds the scan, not the repository

`subject.digest` is a `sha256:`-prefixed digest binding `repository_ref` + the normalized
`scan_scope` (paths, commit range, lenses) at scan time — **not** recomputed by this
contract's own verifier (there is no bundle-style artifact here to recompute it from; unlike
`promotion-receipt/v0`'s `semantic_digest` or `release-approval/v0`'s `event_id`, which
*are* recomputed). It identifies which subject a scan covered; it is a **distinct value** from the whole-record JCS
sha256 that a consuming contract's `evidence_refs[]` actually binds to (`release-approval/v0`
calls this the record's `record_digest` — see that protocol's evidence-ref resolution section).
The whole record, not `subject.digest` alone, is what changes the instant a finding's
`claim`/`severity`/`outcome` is edited (TEST-12) — a `record_digest` binding therefore catches a
content edit that leaves `subject.digest` untouched. Either way, a record's findings are valid
evidence only for the exact digest that identifies them: when a fix changes the scanned tree,
the next scan produces a **different `subject.digest`**, and the old record's findings do not
silently migrate forward to it — they are stale for the new subject by construction.
`release-approval/v0`'s composite ledger fixture is where a `promotion-receipt/v0` predicate's
citation of a review-findings record is actually resolved (see that protocol's TEST-09).

## `outcome`: three honest states, one dishonest non-option

- `findings_observed` — at least one finding; `abstention` is null.
- `none_observed_in_recorded_scope` — findings is `[]`; `abstention` is null. This can **only**
  mean "scanned this recorded scope and found nothing" — `scan_scope.paths` and `.lenses` are
  both non-empty by schema (`minItems: 1`), so a record cannot claim `none_observed` while
  secretly having scanned nothing. There is no fourth state for "didn't look" masquerading as
  "looked and it was clean."
- `abstained` — findings is `[]`; `abstention: {code, params}` is required. Use this when the
  scan itself could not complete or could not reach a verdict — never silently fold it into
  `none_observed`.

## `assessor.independence`: structured, never scored

`independence` is a `{code, params}` record — the exact shape
`contracts/shared/derive-independence.mjs` already emits (e.g. `{code:
"different_provider", params: {...}}`). It is never a numeric score. `model_cohort` is `null`
exactly for `kind: human | deterministic_tool` and a non-empty string exactly for
`kind: model | hybrid` (schema-enforced both directions).

`model_cohort` **MUST NOT** be an execution ID or a person's name — but be precise about what
"MUST NOT" means here (sol architect should-5): the schema and `verify-fixtures.mjs` can
mechanically enforce this only at the *key* level (the personal-dimension scanner's forbidden
keys) and via *pattern* checks on specific fields (e.g. `release-approval/v0`'s
`principal_id`). Neither can inspect an arbitrary free-text *value* and tell a cohort label
apart from a session ID or a name typed into the wrong field. Producers are responsible for not
writing personal or execution-specific content into `model_cohort`'s value; this contract
enforces the shape, not the semantics, of that promise.

## Findings: one verifiable claim each, no confidence

Each finding's `category` and `severity` are closed sets (9 × 4 — see the schema for the
literal enums); `claim` is a single verifiable statement, never a bundle of unrelated
observations. Each `locations[]` entry requires a `path`; `start_line`/`.end_line` are `≥1`
integers **or** `null` — null-not-zero: a genuinely unknown line is `null`, never `0`.
`verify-fixtures.mjs` additionally enforces two cross-field rules a schema-level
`type: ["integer","null"]` cannot express on its own: `start_line` and `end_line` must be
**both** `null` or **both** recorded (never one without the other), and when both are recorded,
`end_line >= start_line`. `evidence_gate` names what would have to hold for this finding to be
*promoted* to evidence (`oracle_kind`, `oracle_ref`, a `{code, params}` `predicate`, and
`required_verdict: "proven"` — always `"proven"`, because a finding can never self-declare that
it has already been proven).

**No numeric confidence field exists anywhere in this schema**, and none may be smuggled into
the two intentionally-open `{code, params}` bags (`assessor.independence.params`,
`findings[].evidence_gate.predicate.params`) either — `verify-fixtures.mjs` scans both for any
key whose **lowercased name contains** `"confidence"` (not only an exact match — e.g.
`confidenceScore` is caught too) carrying a numeric value, and rejects it. `additionalProperties:
false` cannot reach inside an open bag by design, which is exactly why this scan exists. The
same broadened scan is copied identically into `promotion-receipt/v0`'s and
`release-approval/v0`'s own `verify-fixtures.mjs` (`contracts/shared` cannot be touched).

## Timestamps: syntactically valid is not enough

`recorded_at`'s `^\d{4}-\d{2}-\d{2}T...Z$` pattern accepts strings that are syntactically
well-formed but calendar-nonsensical (e.g. `"2026-99-99T00:00:00Z"`). `verify-fixtures.mjs`
additionally requires `Date.parse(recorded_at)` to succeed — a value the pattern lets through
but that resolves to no real date/time is rejected.

## Append-only correction

`supersedes_record_id` names the record this one corrects, if any. Superseding never edits or
deletes the prior record — the old record remains exactly as it was recorded, correct for the
subject digest it named.

## Relationship to `promotion-receipt/v0`

A `review-findings/v1` record has no opinion about promotion. `promotion-receipt/v0`'s
`review_admissibility` predicate is the only place a record's findings become inputs to a
promotion decision, and even there, admissibility is evaluated deterministically against
recorded scope and outcome — never by re-running or re-scoring the review.

## What v1 deliberately leaves out

- **No cross-record referential integrity within this contract's own fixtures.** Whether a
  `record_id` named elsewhere (a `supersedes_record_id`, or a `promotion-receipt`'s
  `evidence_refs[].ref`) resolves to a real record is checked only where that OTHER contract's
  own verifier has the full picture — `release-approval/v0`'s composite fixture, for the
  `promotion-receipt` case.
- **No finding→evidence promotion mechanism.** `evidence_gate` names the required verdict; the
  actual oracle call and the accept/reject decision belong to the consuming contract or tool,
  not to this record.
- **No auto-fix loop.** This contract records what a review observed once. Milestone I
  (auto-fix) is a separate, gated, not-yet-implemented mechanism per the source plan.

## Verification

`node contracts/review-findings/v1/verify-fixtures.mjs` checks every fixture against
`review-findings.schema.json` plus: `finding_id` uniqueness within one record (a single-record
schema cannot see its own siblings), the location line-range consistency and real-calendar-date
checks described above, the broadened numeric-confidence scan, and the personal-dimension scan
(`contracts/shared/personal-dimensions.mjs`). See the fixtures directory's
`expected-results.json` for the declared outcome of each fixture.
