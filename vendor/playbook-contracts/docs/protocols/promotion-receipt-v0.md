# promotion-receipt/v0

> **Status: DRAFT (draft_revision 1) — NOT FROZEN.** Part of the Evidence-Closed Delivery
> Shadow Evidence Contracts (Milestone F). No reference implementer exists yet; receipt
> evaluation is intended to be fully deterministic (zero LLM calls) whenever it is
> eventually implemented. Freezing follows this repo's freeze-after-exercise discipline —
> not before a real promotion (shadow or live) exercises this contract.

Normative protocol for a **promotion-receipt**: a deterministic, machine-evaluated verdict over
every predicate a release must satisfy **except human approval**. A receipt carries **no
promotion authority by itself** — authority belongs exclusively to `release-approval/v0`,
whose event binds to this receipt's exact digest. This is the middle link of the
Evidence-Closed Delivery Authority DAG:

```
review-findings/v1  →  promotion-receipt/v0  →  release-approval/v0
   (records what          (evaluates every            (the ONLY authority —
    was observed,          predicate except            a human, or an
    no authority)          human approval,              authorized emergency
                           no authority)                 principal, binds
                                                          exact digests)
```

Conformance fixtures: [`contracts/promotion-receipt/v0/`](../../contracts/promotion-receipt/v0/)
— run `node contracts/promotion-receipt/v0/verify-fixtures.mjs` (zero dependencies, no network).

## Naming: `verdict`, never `decision`

This contract's outcome field is `verdict`, and the word `decision` does not appear anywhere
in its schema. This is deliberate, not incidental: `contracts/decision/v1` already exists and
means something entirely different — a **human's** design decision, made through
`decision_channel`, with `rationale` and `accepted_assumptions`. A `promotion-receipt` is the
opposite kind of thing: a **machine's** deterministic evaluation of a predicate vector, with no
rationale to record because there is no judgment being exercised — only recorded evidence being
checked against closed rules. The source plan's own naming history makes the same point: an
earlier draft of this contract was called `decision-receipt/v0` and was renamed specifically to
avoid this collision (Codex sol Round 3 arbitration). If you are looking for "why did a human
approve this," that is `release-approval/v0`'s event, never this record.

## `verdict`: exactly three values, and `eligible` is not one of them

`ready_for_approval | ineligible | abstained` — closed at the schema level. Earlier design
rounds used `eligible`, but that value implied the receipt itself could grant eligibility to
promote, which is an authority circularity this contract must not have: a receipt only ever
says "I have evaluated everything except human approval, and here is what I found." Whether
that state is *actually* eligible for promotion is `release-approval/v0`'s call, made by a
human (or an authorized emergency principal via `break_glass_approve`) binding to this exact
receipt. `break_glass_authorized` is likewise not a receipt verdict — break-glass is a kind of
**approval event**, never a machine verdict; the predicate vector inside a receipt always
records its real, unmodified status even when a human later chooses to bypass some of it.

`release-approval/v0` additionally restricts *which* approval kind may bind to a non-ready
receipt (sol architect ask-1/R22, enforced there, not here): `approval_granted` is valid only
against a receipt whose `verdict` is `ready_for_approval`; only `break_glass_approve` may bind
to an `ineligible` or `abstained` receipt, and it must carry the audit fields (`incident_ref`,
`bypassed_predicate_ids`) that make the exception visible rather than silent.

## Verdict derivation is enforced by the verifier, not asserted by the fixture

Given a receipt's `predicates[]`, restricted to those with `applicability: "applicable"`:

1. If **any** applicable predicate has `status: "contradicted"` → the verdict **must** be
   `ineligible`.
2. Else, if **any** applicable predicate has `status: "unknown"` → the verdict **must** be
   `abstained`.
3. Else (every applicable predicate is `satisfied`) → the verdict **must** be
   `ready_for_approval`.

`verify-fixtures.mjs` recomputes this derivation independently and rejects any fixture whose
declared `verdict` does not match it — a fixture cannot simply assert a favorable verdict while
carrying an unfavorable predicate vector. `not_applicable` predicates never influence the
derivation (their `status` is schema-forced to `unknown`, but they are excluded from the
"applicable" filter above, so an inapplicable predicate can never itself cause `abstained`).

## `predicate_id`: closed per phase, complete per phase, and `human_release_approval` exists in neither

- `evaluation_phase: "pre_promotion"` → predicates are drawn only from `artifact_identity`,
  `review_admissibility`, `verification_coverage`, `preview_verified`, `rollback_target_valid`,
  `privilege_boundary`.
- `evaluation_phase: "post_deploy"` → predicates are drawn only from
  `deployed_artifact_readback`.
- **`human_release_approval` is not a member of either set, or of this contract's
  `predicate_id` enum at all.** Human approval is never something this receipt evaluates — it
  is the entire reason `release-approval/v0` exists as a separate authority. Mixing the two
  sets in one receipt, or naming `human_release_approval` as a predicate, is rejected at the
  schema level.

**A receipt must carry its ENTIRE phase's predicate set, exactly once each — no fewer, no
duplicates** (sol architect must-1, R21): a `pre_promotion` receipt is rejected unless it
contains all six `pre_promotion` predicate_ids; a `post_deploy` receipt is rejected unless it
contains `deployed_artifact_readback`. This is enforced by `verify-fixtures.mjs`, not the
schema (a single array item's schema cannot see its siblings). Additionally, **the three
always-on `pre_promotion` predicates (`artifact_identity`, `review_admissibility`,
`verification_coverage`) and post_deploy's own `deployed_artifact_readback` can never be
`not_applicable`.** This closes an escape hatch a design round flagged: marking every predicate
`not_applicable` leaves zero *applicable* predicates, and the verdict derivation above then
defaults to `ready_for_approval` by vacuous truth (no applicable predicate is ever
`contradicted` or `unknown` if there are no applicable predicates at all). Forcing these four
predicates to always be evaluated removes that vacuous-pass path entirely.

A predicate whose `status` is `satisfied` or `contradicted` must carry at least one
`evidence_refs[]` entry of a **resolvable kind** — `review_finding` or `release_evidence`.
`kind: "other"` is auxiliary information only: an `other`-only reference can never, by itself,
back a `satisfied` or `contradicted` status (sol architect must-2a). This half of the rule is
checkable without a ledger and is enforced by this contract's own `verify-fixtures.mjs`; whether
the cited evidence *actually resolves* to something real is `release-approval/v0`'s composite
fixture's job (see below).

## `evidence_refs`: what this contract can check alone, and what it can't

Each `evidence_refs[]` entry is `{kind, ref, digest}`.

- `kind: "review_finding"` names a `review-findings/v1` record as
  `"<record_id>#<finding_id>"` (must resolve to a real finding in that record) or
  `"<record_id>#scope"` (valid only when that record's `outcome` is
  `none_observed_in_recorded_scope`). `digest` is bound to the **WHOLE record's** JCS (RFC 8785)
  sha256 (sol architect must-2b/R23) — **not** `subject.digest`. This distinction matters:
  editing a finding's `claim`, `severity`, or `outcome` after the fact changes the record's own
  digest even though `subject.digest` (bound to the scanned tree, not the record's content) can
  stay the same. A reference recorded against the pre-edit digest is stale the instant the
  content changes (TEST-12).
- `kind: "release_evidence"` names a `release-evidence/v0` release/bundle by `release_id`.
- `kind: "other"` is opaque and never resolved by any verifier in this repo.

**This contract's own `verify-fixtures.mjs` does not resolve `evidence_refs` against a real
review-findings record or a real release-evidence bundle** — a bare receipt fixture does not
carry either alongside it; it can only check the *structural* rule above (a resolvable-kind ref
must exist). The *actual* resolution — recomputing the real record/bundle digest and confirming
the reference's anchor and digest both check out — is `release-approval/v0`'s composite ledger
fixture's job, which bundles review-findings records, an optional array of embedded
release-evidence bundles, one receipt, and approval events together (see that protocol's
TEST-06/TEST-09/TEST-12). A `release_evidence` reference to a bundle that isn't embedded in a
given composite fixture is not itself an error — it simply doesn't count as resolved, and a
predicate backed *only* by such a reference is rejected as unresolved there (must-2c). A receipt
that references a stale or non-existent digest will pass this contract's own fixture check and
fail in the composite instead.

## `semantic_digest`: what TOCTOU actually compares

`semantic_digest` is `sha256:` + the JCS (RFC 8785) sha256 of this receipt with `evaluated_at`,
`receipt_id`, and `semantic_digest` itself removed. `verify-fixtures.mjs` recomputes it and
rejects a mismatch. Time is deliberately excluded: the compare-and-promote step
`release-approval/v0` performs immediately before promotion re-evaluates the current state and
compares its semantic digest against the one an approval bound to — a change to *when* the
receipt happened must never itself invalidate an otherwise-unchanged approval, but a change to
*what* the receipt found must.

## `effective_risk` and `policy_digest` are frozen at evaluation start

Both are recorded values, not values the receipt derives from its own verdict — a receipt that
lowered its own risk classification after seeing a favorable predicate vector would be a
self-consistency loop the source plan explicitly rules out (Codex sol Round 2 arbitration).

## Caveats this contract is honest about

- **`subject.selection_manifest_digest` is opaque in v0.** The selection-manifest contract this
  digest is meant to pin does not exist yet (an open question carried forward from the source
  plan, Codex sol Round 3). This receipt only carries the value; a consumer defines its own
  shape and how to recompute it. Do not assume this digest means the same thing across two
  different consumers until a selection-manifest contract exists to say so.
- **`privilege_boundary`'s static scan is a necessary condition, not a sufficient one.** Even
  when every other predicate is `satisfied`, a `privilege_boundary: satisfied` verdict reflects
  only what a decidable, static configuration scan (SHA-pinned actions, no `pull_request_target`
  misuse, no privileged-secret exposure to untrusted event bodies, fork isolation, minimal
  `permissions`, etc.) can prove. It cannot prove the absence of a compromised action internally,
  a tampered pinned commit, or a prompt-injection payload smuggled through a field the scan does
  not interpret semantically. Treat a `satisfied` privilege_boundary predicate as "the
  configuration does not exhibit any of the known-bad shapes," not as "this workflow is secure."

## What v0 deliberately leaves out

- **No cross-record resolution of `evidence_refs` in this contract's own verifier** (see above).
- **No approval, revocation, or expiry state.** All of that is `release-approval/v0`'s.
- **No LLM-generated rationale or explanation text.** A receipt's predicates are evaluated
  deterministically; there is nothing here for a model to explain.

## Verification

`node contracts/promotion-receipt/v0/verify-fixtures.mjs` checks every fixture against
`promotion-receipt.schema.json` plus: predicate-set completeness and always-applicable
enforcement (above, R21), the structural half of resolvable-evidence-kind (above, R9),
real-calendar-date validity for `evaluated_at` (a value that matches the UTC-Z pattern but does
not `Date.parse` to a real date/time, e.g. `"2026-99-99T00:00:00Z"`, is rejected), verdict
derivation (above), `semantic_digest` recomputation (above), the broadened numeric-confidence
scan (matches any key whose lowercased name *contains* `"confidence"`), and the
personal-dimension scan (`contracts/shared/personal-dimensions.mjs`). See the fixtures
directory's `expected-results.json` for the declared outcome of each fixture.
