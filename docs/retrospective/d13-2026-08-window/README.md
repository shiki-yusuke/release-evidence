# Retrospective dry-run: D13 baseline window (2026-08-08 to 2026-08-22)

> **Not a KPI input. Not a baseline input.** Nothing in this directory may be used as, or
> folded into, any F/G/H KPI or the D13 baseline. The D13 baseline document
> (`ai-agent-skills-playbook` `docs/evidence-closed-delivery-frozen-decisions.md`, section
> "D13 baseline") is **not changed** by this dry-run; it is only cited below.

## Purpose

Run the F shadow evaluator *after the fact* over the 11 releases that make up the frozen D13
baseline window, to see which of them can be evaluated at all from the records that actually
exist. This is a dry-run of the procedure, not a measurement.

## Rules

1. **Preflight first, in its own namespace.** A release whose bundle, selection manifest,
   policy snapshot, `effective_risk`, or contract pin is not on record is `not_evaluable`. The
   evaluator is not called for it and no receipt exists (`receipt: "no_receipt_emitted"`).
   `not_evaluable` is a preflight status (`evaluable` / `not_evaluable`) and is never mixed with
   the evaluator's own `evaluation_status` (`evaluated` / `unknown` / `invalid_input`).
2. **Only real, complete inputs are evaluated.** A real release goes to the evaluator only when
   every input exists in the real records. Missing inputs are recorded as missing; they are
   never filled in from current vendored values, estimates, or later records. The abstain path
   is shown with **synthetic** fixtures, never by adding records to a real release.
3. **No KPI / baseline use.** See the note at the top.

## Result

**The evaluator was run against 0 real releases.** All 11 are `not_evaluable`.

| # | release | repo | ref (tag @ commit) | ledger events | bundle | preflight | reasons |
|---|---|---|---|---:|---|---|---|
| 1 | `spec-lane@0.4.0` | shiki-yusuke/spec-lane | v0.4.0 @ 4260ac4 | 0 | absent | not_evaluable | all 5 |
| 2 | `spec-lane@0.5.0` | shiki-yusuke/spec-lane | v0.5.0 @ 1261bf7 | 0 | absent | not_evaluable | all 5 |
| 3 | `spec-lane@0.5.1` | shiki-yusuke/spec-lane | v0.5.1 @ 1ff3301 | 0 | absent | not_evaluable | all 5 |
| 4 | `spec-lane@0.5.2` | shiki-yusuke/spec-lane | v0.5.2 @ 222c3fc | 0 | absent | not_evaluable | all 5 |
| 5 | `spec-lane@0.6.0` | shiki-yusuke/spec-lane | v0.6.0 @ 7407075 | 0 | absent | not_evaluable | all 5 |
| 6 | `spec-lane@0.7.0` | shiki-yusuke/spec-lane | v0.7.0 @ a7392a5 | 0 | absent (prose clean-room verify record only) | not_evaluable | all 5 |
| 7 | `evidence-docs@0.1.0` | shiki-yusuke/evidence-docs | v0.1.0 @ f633fee | 0 | absent | not_evaluable | all 5 |
| 8 | `evidence-docs@0.2.0` | shiki-yusuke/evidence-docs | v0.2.0 @ 7f29921 | 0 | absent | not_evaluable | all 5 |
| 9 | `agent-cost@0.1.0` | shiki-yusuke/agent-cost | v0.1.0 @ a6126be | 0 | absent | not_evaluable | all 5 |
| 10 | `release-evidence@0.1.0` | shiki-yusuke/release-evidence | v0.1.0 @ 6669433 | 0 | absent | not_evaluable | all 5 |
| 11 | `agent-metrics-dashboard@32572501427-1` | shiki-yusuke/agent-metrics-harvester | (no tag) @ 543dcc9 | 3 (prepared, deployed/production with preview_skipped, verified/production) | present: `release-evidence/bundles/bundle-63392d1a635e68f6.json`, `sha256:63392d1a635e68f670f07dcb717ad7e1437f8282be82a1dd8c0ab2c6a664c9e1` | not_evaluable | 4 (all but `bundle_absent`) |

"all 5" = `bundle_absent`, `selection_manifest_absent`, `policy_snapshot_absent`,
`effective_risk_unrecorded`, `contract_pin_unrecorded`.

Why #11 is still `not_evaluable`: its sealed bundle and ledger events are real, but the
evaluator input also needs `subject.selection_manifest_digest`, `policy.effective_risk`, and
`contract_pin.playbook_commit` (`src/shadow/input.ts`), and **no record of any of them exists**
for this release (or any other) on the harvester's `metrics-data` ref. There is no selection
manifest, no policy snapshot or policy digest, no effective risk, and no contract pin. Those
fields are not filled in here or in `releases.json` -- they are recorded as absent.

The machine-readable record is [`releases.json`](releases.json) (`d13-retrospective/v0`).

## Sources and how they were checked

- Records read: agent-metrics-harvester, git ref `origin/metrics-data`, commit
  `58ed3f36b16932550795a27211ef19c7c74b8d8e` (also stored as `verification.commit` on every
  release in `releases.json`). The only paths on that ref are `README.md`,
  `agent-metrics-store.jsonl`, `aggregates/*.jsonl`, `release-evidence/release-events.jsonl`, and
  `release-evidence/bundles/{bundle,toolchain}-*`.
- Verification method `harvester_ledger_and_bundles`, implemented by
  [`scripts/retrospective-d13-preflight.mjs`](../../../scripts/retrospective-d13-preflight.mjs):

  ```bash
  node scripts/retrospective-d13-preflight.mjs \
    --harvester <agent-metrics-harvester clone> \
    --releases docs/retrospective/d13-2026-08-window/releases.json
  ```

  It reads only the git ref (`rev-parse`, `ls-tree`, `show`; never the working tree) and
  recomputes: ledger event count per `release_id`; bundle presence by `release_id` in the bundle
  body, with the bundle's JCS sha256 checked against the recorded digest, the ledger events'
  `bundle_digest`, and the source repo and commit; and the absence of manifest / policy /
  effective risk / contract pin records. Absence is checked two ways: by tree path, and by
  inspecting every JSON / JSONL record on the ref for the keys `selection_manifest_digest`,
  `policy_snapshot`, `policy_digest`, `effective_risk`, `playbook_commit`, `contract_pin`. Any
  difference from `releases.json` exits 1; a missing or unreadable harvester exits 2. It neither
  imports nor spawns the evaluator.
- `test/retrospective-d13.test.ts` runs the script when `RELEASE_EVIDENCE_HARVESTER_DIR` is set.

Tag / commit note: the `ref.commit` values are the commits recorded for this dry-run. In the
local clones checked on 2026-10-19, `spec-lane` v0.4.0 to v0.7.0 and `agent-cost` v0.1.0 resolve
to *different* commit IDs with the same tree, message, and date as the recorded ones. This looks
like a history rewrite, but the cause is not established. The preflight does not depend on these
values for #1 to #10, which have no ledger events or bundles under any ID.

## Abstain path (synthetic only)

No real release in this window reached the evaluator, so the abstain path is shown with the
existing **synthetic** replay packs (not real releases; see `docs/replay-pack-format.md` "Sample
packs"):

| synthetic pack | expected `evaluation_status` | expected `candidate_receipt.verdict` |
|---|---|---|
| `test/fixtures/replay-packs/lane-ref-omitted/` | `evaluated` | `abstained` |
| `test/fixtures/replay-packs/lane-backed/` | `evaluated` | `abstained` |

`test/retrospective-d13.test.ts` replays both through `release-evidence-shadow replay` and
checks them against their `expected.json`. No new fixture was added, and none of the 11 real
releases has a replay pack.

## Cited from the D13 baseline (citation only, not recomputed or reused)

The frozen D13 baseline lists 11 releases in this window and notes that only 1 of 11 has a
machine-recorded release-evidence chain. This dry-run cites that statement and does not
produce, replace, or update any baseline value.
