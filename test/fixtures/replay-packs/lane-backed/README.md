# replay pack: lane-backed

Format: see `docs/replay-pack-format.md`.

## Scenario

The same release identity/artifacts/build/rollback-target as the `lane-ref-omitted` pack's
vendored base bundle (`vendor/playbook-contracts/release-approval/v0/fixtures/accept-composite-
happy.json`'s `bundles[0]`), but with `lane_ref` and `review` populated instead of omitted -- the
vendored fixture corpus has no accept fixture with a populated `lane_ref` (every embedded bundle
in `release-approval/v0`'s fixtures uses the `lane_ref_omitted` placeholder), so this pack derives
a lane-backed variant from that same base rather than lifting one verbatim. `input.json` also adds
a `verification_record` (resolved via `lane_ref.verification_digest`), a `verified`/`preview`
`release_event` for this release, and a `deployed`/`production` `release_event` for the rollback
target (`spec-lane@0.6.0`).

**Deliberately incomplete event history (terra review round C, 2026-08-27):** neither the
`verified`/`preview` event nor the `deployed`/`production` event is preceded by the `prepared`
(and, for the first, `deployed`/`preview`) event a real release-evidence/v0 ledger would have --
each is an orphaned event that does not fold legally through the D5 transition graph
(`src/core/fold.ts`'s `foldAttempt`, the same graph `preview_verified`/`rollback_target_valid`'s
satisfied branches now require a legal fold through before trusting an event as evidence, see
`src/shadow/evaluate.ts`'s `foldAttemptEvents`). This pack is kept exactly as-is (rather than
extended into a fully legal chain) specifically to demonstrate this fix: a schema-valid record
that individually parses is not, by itself, legitimate satisfied evidence.

## What a human reviewing this replay should look for

- `artifact_identity` / `review_admissibility` / `verification_coverage` should be `satisfied`;
  `preview_verified` / `rollback_target_valid` should be `unknown` (see above -- their events are
  deliberately orphaned in this pack). If a real corpus replay shows `artifact_identity` /
  `review_admissibility` / `verification_coverage` as anything other than `satisfied`, or shows
  `preview_verified` / `rollback_target_valid` as `satisfied` WITHOUT this release's own event
  history actually forming a legal, complete lifecycle, treat that as a signal worth investigating
  (either the corpus's records are genuinely incomplete, or this evaluator has a bug).
- `privilege_boundary` stays `unknown` unconditionally (no static scan implemented) and `verdict`
  stays `abstained` (never `ready_for_approval`) for the same structural reason as every other
  replay this evaluator produces today -- expected, not this pack's own defect.

See `expected.json` for the exact machine-checked shape.
