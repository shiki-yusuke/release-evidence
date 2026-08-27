# replay pack format (release-evidence-shadow)

A **replay pack** is a directory that bundles everything `release-evidence-shadow replay` needs
to deterministically re-evaluate one release (real or synthetic), plus enough human-readable
context to make the result reviewable by a person. It is a test/documentation convention, not a
new CLI feature -- the CLI still only ever takes a single `--input <file>` flag
(`src/shadow-cli/main.ts`); a replay pack is just a directory that groups one
`shadow-evaluation-input/v0` document with the metadata a human (or a test) needs around it.

## Layout

```
<pack-name>/
  input.json      required. A single shadow-evaluation-input/v0 document (src/shadow/input.ts) --
                  the sealed bundle, every exact record the evaluation may consult, evaluation_cut,
                  policy, and contract_pin, ALL INLINE. ExactRecord.content is embedded JSON, never
                  a path to another file in the pack: resolution is by content digest, never by
                  filesystem layout (spec.md "決定論" / "path/ID では解決しない"). Run with:

                    release-evidence-shadow replay --input <pack-name>/input.json --out <out-file>

  README.md       required. Human-readable provenance and review guidance: which real release (or
                  synthetic scenario) this replays, why it was captured, and what a human should
                  look for when reviewing the result (sol design log step 12: "実 release corpus
                  を再走行し、unknown 分布と false allow を人間確認"). Not read by any code.

  expected.json   optional. Machine-checkable expectations for automated tests exercising this
                  pack (evaluation_status, candidate_receipt.verdict, and/or specific
                  predicate_observations statuses/reasons) -- NOT part of the input the evaluator
                  consumes and never validated against shadow-evaluation-input/v0's schema. Same
                  spirit as this repo's vendored contracts' own fixtures/expected-results.json
                  files: a test-only expectations manifest sitting next to the real artifact it
                  describes.
```

Nothing else is defined by this format -- a pack MAY carry additional files (raw exports the pack
was assembled from, notes, etc.) as long as they don't collide with the three names above; nothing
reads a pack directory's contents except `input.json` (by the CLI) and, when present,
`expected.json` (by tests).

## Building a pack from a real release

1. Assemble the release's `release_evidence_bundle` exact record from its real, sealed
   release-evidence/v0 bundle content (verbatim -- do not hand-edit fields other than what's
   necessary to redact secrets).
2. Assemble every other exact record the pre_promotion predicates can currently use: the
   `selection_manifest` the bundle's `subject.selection_manifest_digest` names, the
   `verification_record` `lane_ref.verification_digest` names (when `lane_ref` is not omitted),
   and any `release_event` records for this release's preview/rollback-target history that were
   recorded at or before the evaluation_cut you are replaying at.
3. Compute each record's `digest` via the same content-address function the resolver checks
   against (`recordContentDigest`, `src/shadow/serialize.ts` -- `sha256:` + JCS canonical bytes'
   sha256 hex digest). Never hand-write a digest.
4. Set `evaluation_cut` to the real wall-clock instant the replay represents (never "now") --
   any record whose `observed_at` is after this cut is silently excluded from the evaluation, by
   design (hindsight-leakage guard).
5. Set `policy.digest` / `policy.effective_risk` / `contract_pin.playbook_commit` to the real
   values frozen for that release's evaluation, not placeholders, when replaying a real corpus.
   The two sample packs under `test/fixtures/replay-packs/` are synthetic and carry no real
   policy snapshot at all, so they set `policy.digest: null` with a documented
   `absent_reason: {code: "policy_snapshot_absent", ...}` (round C's honest "no snapshot for this
   evaluation" declaration, `src/shadow/input.ts` -- never a placeholder digest that merely fails
   to resolve) alongside a representative `effective_risk` and `contract_pin.playbook_commit`.
6. Write a `README.md` explaining the release's provenance and, if the pack is meant to be
   reviewed by a human (sol step 12), what "looks right" for this specific release.

## Sample packs

`test/fixtures/replay-packs/{lane-ref-omitted,lane-backed}/` are synthetic packs exercised by
`test/shadow-replay-pack.test.ts` as a CLI-level end-to-end conformance check of this format
itself (not a real-corpus replay). Both derive their `release_evidence_bundle` content from the
same real, vendored, schema-valid bundle embedded in
`vendor/playbook-contracts/release-approval/v0/fixtures/accept-composite-happy.json`'s
`bundles[0]` -- see each pack's own `README.md` for what varies and why.

## Real-corpus replay (not done by this chunk)

Replaying an actual release corpus through this format -- and having a human review the resulting
`unknown` distribution and check for any false `satisfied`/`ready_for_approval` allow -- is a
manual, human-in-the-loop step this chunk does not perform (sol design log step 12; see
`docs/spec/I-2026-08-27-f-shadow-evaluator/implement-notes.md`'s "PR 前に人間がやること").
