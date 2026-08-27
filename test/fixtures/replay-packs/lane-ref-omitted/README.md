# replay pack: lane-ref-omitted

Format: see `docs/replay-pack-format.md`.

## Scenario

A non-lane release (`spec-lane@0.7.0`) with no `lane_ref` and no recorded review decision.
`input.json`'s `release_evidence_bundle` record is lifted byte-for-byte from the vendored
`vendor/playbook-contracts/release-approval/v0/fixtures/accept-composite-happy.json`'s
`bundles[0]` (a real, schema-valid release-evidence/v0 bundle the playbook itself vendors and
accepts) -- confirmed by its `recordContentDigest` matching that fixture's
`receipt.subject.bundle_digest` exactly
(`sha256:b7f0be414a5c004eef01975ccc3e2ccdc3bff47c064796543c9b2a82e19a198f`).

No `verification_record` or `release_event` records are included -- this pack deliberately
represents the "we have the bundle and nothing else yet" replay case.

## What a human reviewing this replay should look for

- `verification_coverage` and `review_admissibility` come out `unknown` (not `not_applicable`) --
  a lane-omitted / review-omitted release still gets an honest "we don't know", never a silent
  pass. If a real corpus replay of a non-lane release ever shows `satisfied` here, that is a bug.
- `privilege_boundary` is `unknown` unconditionally (no static scan is implemented yet) -- expect
  this on every real-corpus replay pack until that predicate is implemented, not just this one.
- `verdict` is `abstained`, never `ready_for_approval` -- this evaluator cannot currently produce
  `ready_for_approval` at all (privilege_boundary always applicable+unknown blocks it). This is
  expected, not a defect to chase in this pack specifically.

See `expected.json` for the exact machine-checked shape.
