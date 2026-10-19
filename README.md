# release-evidence

> Seal a release bundle before deployment, carry the same digest through each environment,
> and verify what actually reached production.

A successful CI job does not prove that production received the artifact you reviewed.
`release-evidence` provides a fail-closed CLI and append-only ledger for binding a deployment
to the exact source, build inputs, artifacts, review evidence, and content manifest that were
approved.

## See the core proof in 60 seconds

From a checkout with Node.js 22 and pnpm 10:

```bash
pnpm install --frozen-lockfile
pnpm run build
node dist/src/cli/main.js manifest test/fixtures
```

Actual output from the current fixture directory:

```json
{
  "digest": "sha256:b3cbf8ff1cc62fe4e5baf4ec05f4e410a63d2ae3e3410cd73b6e55c6e98964a4",
  "manifest": {
    "concurrent-append-worker.mjs": "sha256:cdcab2ccf5f63434cfb44522b13e24bbc2025b003bd570c9ee381858cb7928c9"
  }
}
```

The manifest maps every relative path to its content digest; the top-level digest seals that
canonical mapping. A deploy adapter can place the manifest in a static site, read it back from
the live URL, recompute the digest, and compare it with the sealed release bundle.

## What the CLI enforces

- `prepare` validates and seals a Release Evidence Bundle before deployment.
- `record` checks `preview → staging → production` transitions against the current ledger and
  refuses an invalid transition without changing it.
- `manifest` computes or writes a canonical static-site content manifest.
- `status` derives current state by folding the ledger; `audit` checks the complete collection
  against its real bundles.

Run `node dist/src/cli/main.js --help` for the full command surface. The package is currently a
source-distributed reference implementation (`private: true`), not a published npm package.
The v0 ledger assumes a single writer: concurrent `record` processes are not serialized, so
route writes through one process rather than treating the file as a multi-writer database.

## Promotion ledger (single-consumption)

`release-evidence promote <lock-status|ingest|authorize|send|finalize|reconcile>` binds each
GitHub Pages production send to exactly one `release-approval/v0` approval. Approvals placed on
`main` are candidates; they take effect in the order they are ingested into an append-only
promotion ledger on `refs/heads/promotion-ledger`, written only through a
`git push --force-with-lease` compare-and-swap. An approval is consumed once (`authorized`), the
send right is used once (`effect_send`), and the outcome is closed only by what the GitHub
Deployments API reports (or by a human-confirmed reconcile). A target stays locked while any
promotion is open or a late effect is unresolved.

The normative protocol, exit codes, operating conditions, and the integration items not yet
confirmed against the real API are in [docs/promotion-protocol.md](docs/promotion-protocol.md).

## Deployment evidence already exercised

> **Status: exercised against a real deployment.** The contract this repo implements
> ([`release-evidence/v0`](https://github.com/shiki-yusuke/ai-agent-skills-playbook/tree/main/contracts/release-evidence/v0))
> is **FROZEN** (2026-08-22): the freeze gate was this repo's GitHub Pages adapter shipping the
> [agent-metrics dashboard](https://shiki-yusuke.github.io/agent-metrics-harvester/)'s real
> production deploy, whose live `release-manifest.json` content digest was independently
> recomputed and matched the sealed bundle. That deploy's ledger and verbatim bundle live in
> agent-metrics-harvester's `metrics-data` branch (and, as fixtures, in the contract itself).
> The dashboard workflow now records evidence on every scheduled run.

Deployment state machine v1 (the platform design's **D5**):

- assemble a **Release Evidence Bundle** before any deploy — source tree digest, lane artifact
  digests, review provenance, artifact digests, build recipe/toolchain digests;
- carry that bundle's digest through `preview → (staging) → production` as an **append-only
  event ledger** whose current state is always derived by folding, never stored;
- **build once, promote the same digest everywhere** — a changed tree means a new bundle means
  `prepare` starts over;
- deploy adapters (first: GitHub Pages static sites — a canonical path→sha256 manifest is
  placed into the site and read back after deploy).

Contracts are owned by `ai-agent-skills-playbook` (schema + fixtures + verifier); this repo
consumes them by file/CLI only — no cross-repo imports (design rule D8).

## Retrospective dry-run (D13 window)

[`docs/retrospective/d13-2026-08-window/`](docs/retrospective/d13-2026-08-window/README.md)
runs the shadow evaluator's preflight after the fact over the 11 releases of the D13 baseline
window (2026-08-08 to 2026-08-22), using only the harvester's `metrics-data` records. All 11 are
`not_evaluable`: no selection manifest, policy snapshot, effective risk, or contract pin was
recorded for any of them. The evaluator ran against 0 real releases. The abstain path is shown
only with the synthetic replay packs. Re-check with `scripts/retrospective-d13-preflight.mjs`.
This dry-run is not a KPI or baseline input.

## Non-goals (v0)

Automatic promotion, automatic rollback, signed integrity, SLSA/SBOM. `actor` has no
autonomous-agent member on purpose.

## License

MIT. See [LICENSE](LICENSE).
