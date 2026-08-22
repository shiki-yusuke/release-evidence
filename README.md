# release-evidence

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

## Non-goals (v0)

Automatic promotion, automatic rollback, signed integrity, SLSA/SBOM. `actor` has no
autonomous-agent member on purpose.
