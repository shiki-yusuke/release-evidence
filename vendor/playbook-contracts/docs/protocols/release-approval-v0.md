# release-approval/v0

> **Status: DRAFT (draft_revision 1) — NOT FROZEN.** Part of the Evidence-Closed Delivery
> Shadow Evidence Contracts (Milestone F). No reference implementer exists yet. Freezing
> follows this repo's freeze-after-exercise discipline — not before a real approval (shadow
> or live) exercises this contract against a real deploy adapter, same bar `release-evidence/v0`
> was held to.

Normative protocol for a **release-approval event**: the append-only ledger of the ONLY
promotion authority in the Evidence-Closed Delivery Authority DAG. A human (or an authorized
emergency principal, via `break_glass_approve`) binds exact digests — the receipt being
approved, that receipt's own semantic content, the release bundle, the selection manifest, and
the target environment — to an approval, rejection, or revocation. No `promotion-receipt/v0`
verdict, however favorable, can substitute for this event; `human_release_approval` is not, and
never will be, a predicate `promotion-receipt/v0` evaluates.

Conformance fixtures: [`contracts/release-approval/v0/`](../../contracts/release-approval/v0/)
— run `node contracts/release-approval/v0/verify-fixtures.mjs` (zero dependencies, no network).

## `kind`: four events, one exact-binding shape, no exemptions

`approval_granted | approval_rejected | approval_revoked | break_glass_approve`. **Every kind**
carries the same `subject` shape — `{receipt_digest, receipt_semantic_digest, bundle_digest,
selection_manifest_digest, target}` — required, with no field ever omitted regardless of kind.
This is the point of the contract: there is no code path, including the emergency one, where an
approval can exist without being bound to an exact receipt, bundle, selection manifest, and
target. `approval_granted` and `break_glass_approve` additionally require `expires_at`;
`approval_revoked` additionally requires an exact `revoked_approval_event_id` naming the event
it revokes.

## `break_glass_approve`: the exception that changes nothing about the binding

Break-glass is a kind of **human approval event**, never a machine verdict rewritten to look
like a pass. `bypassed_predicate_ids` (non-empty, duplicate-free — `uniqueItems: true` — drawn
from `promotion-receipt/v0`'s own `predicate_id` closed set — never `human_release_approval`,
which is not a member of that set at all) names exactly which predicates this emergency
approval chose to override, and `incident_ref` names the incident that justified it. **Every id
in `bypassed_predicate_ids` must actually appear among the referenced receipt's own
`predicates[]`** (checked by the composite fixture, not expressible in this single-event
schema): bypassing a predicate the receipt never evaluated is meaningless, and this also catches
a phase mismatch — `deployed_artifact_readback` is a valid closed-set member, but it can never
appear in a `pre_promotion` receipt's predicates, so bypassing it against one is rejected.

**Artifact binding, target, and expiry are not exempted for break-glass** — the schema makes
this structurally impossible, not merely discouraged: `expires_at` is required exactly as for
`approval_granted`, and `subject` is the same shape every other kind carries.
`recorded_after_side_effect: true` (optional) lets an operator honestly record that the ledger
append happened after the promotion side effect already occurred (e.g. the ledger itself was
unavailable at the moment of the emergency action) — the event stays truthfully marked rather
than silently backdated. The design intent from the source plan: break-glass must "not erase the
exception, not disguise it as a pass, and not hide that it was recorded after the fact."

## `approval_granted` is valid only against a ready receipt (R22)

`approval_granted` may bind **only** to a receipt whose `verdict` is `ready_for_approval`. An
`approval_granted` event bound to a receipt whose verdict is `ineligible` or `abstained` is
rejected by the composite check (sol architect ask-1/R22): a receipt that has not cleared every
machine-checkable predicate has nothing for an ordinary approval to ratify. **Only
`break_glass_approve` may cross this line** — that is precisely why it exists as a distinct kind
with its own mandatory audit fields (`incident_ref`, `bypassed_predicate_ids`) rather than being
folded into `approval_granted`: the exception must stay visible, never silently available to the
ordinary path.

## `principal`: pseudonymous by construction

`principal_id` matches `^[a-z0-9][a-z0-9_-]{0,63}$` — a pattern that rejects `@` and whitespace
at the schema level, so an email address or a free-text human name cannot even be written here,
before the personal-dimension scan ever runs. `issuer` and `role_snapshot` record the
authenticated identity provider and the role the principal held *at approval time* (a snapshot,
because roles can change later without invalidating the historical record of who approved
what, under what authority, when).

## `event_id`: recomputed, not asserted

`event_id` must equal `sha256:` + the JCS (RFC 8785) sha256 of the event with `event_id` itself
removed — the same convention `release-evidence/v0` already established. `verify-fixtures.mjs`
recomputes it independently for every event and rejects a mismatch.

**A duplicate `event_id` inside a conformance ledger fixture is always rejected** (sol architect
must-5/R24), whether or not the two occurrences are byte-identical — a producer must never
append the same event twice, and a conformance fixture proves the ledger contract by refusing
to accept that it ever would. Two entries sharing an `event_id` but carrying *different* payload
is a **hard conflict**: since `event_id` is a deterministic hash of the payload, at least one of
the two entries' declared `event_id` cannot equal its own recomputed hash, so this case is
already caught as an `event_id_mismatch` on whichever entry is wrong — no separate check is
needed. What this contract does **not** specify is a *consumer's* runtime behavior on ingesting
an append-only log that happens to contain a byte-identical repeated line (e.g. from an
at-least-once delivery retry) — a consumer MAY treat that as an idempotent no-op rather than an
error. That is a real-world operational allowance for readers, and it is explicitly **not** a
statement about what this contract's own fixtures accept: a duplicate `event_id`, identical
payload or not, fails conformance here.

## Timestamps: syntactically valid is not enough

`occurred_at`/`expires_at`'s UTC-`Z` pattern accepts strings that are syntactically well-formed
but calendar-nonsensical (e.g. `"2026-99-99T00:00:00Z"`). `verify-fixtures.mjs` additionally
requires both to `Date.parse` to a real date/time when present, and requires `expires_at` to be
**strictly after** `occurred_at` whenever both appear on the same event. The composite check
adds one more ordering rule no single event can express on its own: an approval event's
`occurred_at` must be strictly after the referenced receipt's own `evaluated_at` — an approval
cannot predate the evaluation it approves.

## Cross-record truth: the composite fixture is the ONLY fixture type (must-3)

A bare `release-approval` event, by itself, cannot prove it is bound to anything real — its
digests are just strings until checked against the receipt and bundle they claim to describe.
An earlier revision of this contract also had a standalone `"ledger"` fixture type (an array of
events with no receipt or findings attached); a sol architect review retired it (must-3): every
R19-scoped conformance ledger is now a **`composite`** fixture,
`{findings: [...review-findings/v1 records], bundles: [...optional embedded release-evidence/v0
bundles], receipt: {...one promotion-receipt/v0}, approval_events: [...release-approval/v0
events]}`. `verify-fixtures.mjs`'s composite check:

1. Re-validates every embedded record and the receipt using **their own contracts' checkers**
   (imported directly from `review-findings/v1` and `promotion-receipt/v0`'s own
   `verify-fixtures.mjs` — never reimplemented here, so the three verifiers can never silently
   drift apart on what "valid" means).
2. Validates every embedded `bundles[]` entry against **`release-evidence/v0`'s own schema**
   (read-only reference — `contracts/release-evidence/**` is never modified by this contract),
   **plus a hand-written supplement for that schema's `lane_ref`/`review` union shapes** (sol
   architect review round 3, blocker): `contracts/shared/schema-validator.mjs` does not evaluate
   `oneOf` at all, and those two properties are the only place in the bundle schema that relies on
   `oneOf` alone with no sibling `allOf`/`if`-`then` enforcement — so, unsupplemented, a value like
   `lane_ref: 42` would pass straight through. `verify-fixtures.mjs` reproduces each `oneOf`
   branch's required fields and types by hand for exactly those two properties — **plus** the
   personal-dimension scan, then indexes valid bundles **by their own JCS digest**, not by
   `release_id`: `release-evidence/v0`'s own fold unit is `(release_id, bundle_digest)`, so one
   release can legitimately have several embedded attempts at different digests side by side.
   **Two embedded bundles sharing the same digest are a duplicate embed and rejected** (sol
   architect review round 2, blocker-1) — an arbitrary object can no longer be embedded and
   treated as real evidence merely because some digest can be computed from it; the bundle has to
   actually BE a valid release-evidence/v0 bundle (schema shape, union shape, and no personal
   dimension), and each attempt is embedded once. A bundle's own SEMANTIC MUSTs (artifacts
   sorted+unique, hash-width match, etc.) remain `release-evidence/v0`'s own verifier's
   responsibility — not re-run here.
3. Requires the receipt's own `subject.bundle_digest` to resolve to one of those embedded bundles
   (sol architect review round 2, blocker-2) — mutual agreement between `receipt.subject` and
   `approval.subject` alone (checked next) is internal consistency, not evidence resolution; an
   unresolvable `bundle_digest` means the whole approval chain is anchored to nothing real, and is
   rejected before any of the finer-grained checks below even run. Then checks every
   `approval_events[]` entry for duplicate `event_id`.
4. Recomputes the receipt's REAL JCS sha256 and requires every approval event's
   `subject.receipt_digest` to resolve to it. A digest that merely repeats a string proves
   nothing — the same discipline `release-evidence/v0` already applies to `bundle_digest`
   (sol must-2 there).
5. Requires `receipt_semantic_digest` / `bundle_digest` / `selection_manifest_digest` / `target`
   to match the embedded receipt's **current** values exactly. Any drift is a **stale approval
   binding** — for example, the bundle was replaced by a new attempt after this approval's
   receipt was evaluated, and the approval no longer describes anything real. The same pass also
   checks the approval-precedes-evaluation and approval_granted-requires-ready-receipt rules
   above, and — for `break_glass_approve` — that every `bypassed_predicate_ids` entry actually
   names a predicate the receipt evaluated.
6. For `approval_revoked` events: `revoked_approval_event_id` must resolve, **within the same
   ledger**, to an `approval_granted` or `break_glass_approve` event (dangling and wrong-kind
   targets are both rejected); the revoke's `subject` must be **semantically** equal to the target
   event's `subject` — compared via `canonicalize()` (RFC 8785 JCS), not raw `JSON.stringify()`,
   so two subjects that agree on every field but were written with keys in a different order
   compare equal (a real `JSON.stringify`-based false-reject this contract's own review round 2
   caught and fixed); and the revoke's `occurred_at` must be strictly after the target's own
   `occurred_at` (R19 extension). A revoke that predates what it claims to revoke, or that
   silently changes which artifact/receipt/target it's talking about mid-revocation, is
   structurally impossible to express in a passing fixture.
7. For every `satisfied`/`contradicted` predicate in the receipt, resolves each
   `evidence_refs[]` entry of a resolvable kind and requires **at least one to actually
   resolve**:
   - `review_finding`: the anchor (`<record_id>#<finding_id>` or `<record_id>#scope`) must
     resolve against the embedded `findings[]` (a `#scope` anchor is valid only against a record
     whose `outcome` is `none_observed_in_recorded_scope`; any other malformed or dangling anchor
     is rejected), and the reference's `digest` must equal that record's **actual, whole-record**
     JCS sha256 — not `subject.digest`. Editing a finding's `claim`/`severity`/`outcome` after
     the reference was recorded changes this digest even if `subject.digest` (bound to the
     scanned tree) does not, which is exactly the "a fix produces a new digest, and the old
     finding does not follow it forward" rule `review-findings/v1` states in prose, made
     mechanical here (R23).
   - `release_evidence`: resolves against an embedded bundle **by digest** (step 2 above), with a
     `release_id` cross-check — a ref whose digest resolves to an embedded bundle carrying a
     *different* `release_id` is rejected as `release_evidence_ref_release_id_mismatch`. **A
     bundle that is not embedded in this fixture is not itself an error** — the reference simply
     doesn't count as resolved (a friendlier `release_evidence_digest_mismatch` diagnostic is
     still given when *some* embedded bundle shares the ref's `release_id` at a different digest).
     A predicate backed *only* by such an unresolved reference is rejected as unresolved
     (must-2c): "unresolved" never silently becomes "trust it anyway."
   - `other` references never count toward resolution and are never themselves flagged;
     `promotion-receipt/v0`'s own verifier already requires a resolvable-kind reference to exist
     structurally, so an `other`-only predicate fails there first.

Only the composite fixture type can exercise checks 2–7, because they are inherently
cross-contract: a bare receipt or a bare event, checked alone, has nothing real to resolve
against.

## What v0 deliberately leaves out

- **No full approval-priority state machine.** This contract enforces the per-kind field
  requirements (R14–R17), the digest-binding checks, the approval_granted-requires-ready rule
  (R22), and the revocation-resolution rule above (R19 extension); it does not yet encode a
  fully general ordering rule across arbitrary `approval_granted → approval_revoked →
  break_glass_approve` sequences beyond what those checks already require. A richer state
  machine (mirroring `release-evidence/v0`'s attempt-folding transition graph) is v1 work,
  informed by a first real multi-event case.
- **No automatic promotion.** This ledger only records human (or authorized emergency) approval
  events; the actual promotion side effect and its own `promotion_result_recorded` event are
  outside this contract's scope.
- **No re-run of `release-evidence/v0`'s own SEMANTIC checks on embedded `bundles[]`.** Each
  embedded bundle IS validated against that contract's schema plus the personal-dimension scan
  (see step 2 above), but bundle-level semantic MUSTs (`artifacts[]` sorted+unique,
  `commit_sha`/`tree_digest` hash-width agreement, `rollback` target resolution, etc.) are that
  contract's own verifier's job — a composite fixture proves digest resolution, not full bundle
  conformance.

## Verification

`node contracts/release-approval/v0/verify-fixtures.mjs` checks every fixture against
`release-approval-event.schema.json` plus: `event_id` recomputation, real-calendar-date and
expiry-ordering checks, duplicate `event_id` detection, the composite cross-record checks above,
the broadened numeric-confidence scan (matches any key whose lowercased name *contains*
`"confidence"`), and the personal-dimension scan (`contracts/shared/personal-dimensions.mjs`).
See the fixtures directory's `expected-results.json` for the declared outcome of each fixture.
