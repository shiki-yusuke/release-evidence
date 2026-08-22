# release-evidence

> **Status: pre-release scaffold.** The contract this repo implements
> ([`release-evidence/v0`](https://github.com/shiki-yusuke/ai-agent-skills-playbook/tree/main/contracts/release-evidence/v0))
> is itself a DRAFT; v1 of the contract freezes only after this repo's first deploy adapter has
> been exercised against a real deployment.

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
