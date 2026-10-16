# Promotion ledger protocol (`release-evidence-promotion/0`) — normative

Status: implemented in `src/promotion/**`, exercised only against a local bare git remote and an
injected fake GitHub API. The [integration items](#integration-items-unconfirmed) below have not
been checked against the real API.

## 1. Purpose

Bind every GitHub Pages production send to exactly one human approval: **one approval = at most
one promotion**, and one promotion = at most one send request. The adapter refuses (and stays
locked) whenever it cannot prove that.

## 2. Authority vs. ledger

- **Authority** = `release-approval/v0` events (playbook contract, unchanged), placed by a human
  on `main` at `release-approval/<repository-slug>/events.jsonl` (`<repository-slug>` =
  `owner--repo`). Each line is a *candidate*; the file order on `main` has no effect.
- **Promotion ledger** = `promotion-events.jsonl` on the ref `refs/heads/promotion-ledger`. It is
  **not authority**: it records which authority event was consumed, by which promotion, and what
  the provider reported. Its schema (`src/promotion/schema/promotion-event.schema.json`) is
  defined by this repo.
- Order of effect = order of lines in the ledger. An authority event takes effect only once it
  is copied verbatim into an `authority_ingested` line (with its `main` commit/path/line pin).
- Principals are whatever the approval event's `principal` claims say. The git author of a
  commit (authority or ledger) is never evidence of anything.

## 3. Linearization point

Every write is one commit on the ledger ref, made by `casCommit` (`src/promotion/git-cas.ts`):

1. fetch the ref; full validation of the ledger history (single-parent commits, tree = the ledger
   file only, each commit an append-only extension of its parent, every line schema-valid) and
   fold — any problem is exit 1;
2. the command's callback derives events from that fold (ingest → late-effect scan →
   preconditions → its own events); events from an earlier attempt are never reused, and the
   provider facts an event records (`send`: source run + both artifacts; `finalize`: statuses +
   live read-back; `reconcile`: candidate + statuses, every deployment page, the Pages listing,
   provider time) are fetched again inside the callback on every attempt — `finalize`'s poll
   only waits for a terminal state, the values written come from the callback;
3. a single-parent commit (parent = fetched head) built with `hash-object`/`mktree`/`commit-tree`
   (the working tree is never touched). Its message ends with a `Promotion-Cas-Nonce: <hex>`
   trailer, 16 random bytes per `casCommit` call: two processes that fold the same head with the
   same provider time, inputs and git dates would otherwise build the byte-identical commit, and
   the loser of the lease would find "its" OID on the remote;
4. `git push --force-with-lease=<ref>:<fetched head>`. A non-zero push is classified after a
   re-fetch of the ref, never retried blindly:
   - **landed** — our commit **OID** is the remote head or on its first-parent chain (git failed
     after the ref moved): treated as a successful push, continue with 5. The same tree or the
     same events under another OID is someone else's commit, never ours;
   - **lease rejected** — not landed and git reported `stale info` / `[rejected]` /
     `fetch first` / `non-fast-forward`, or the remote's own ref-transaction compare failed for a
     push racing past the advertisement (`cannot lock ref '<ref>': reference already exists` /
     `is at <oid> but expected <oid>`): go back to 1, at most `max_cas_retries` times;
   - **uncertain** — anything else (network, authentication, a ruleset `[remote rejected]`, or
     the re-fetch itself failing): exit 5, no retry (the operator inspects the ref).

   Exit 4 means exactly: every attempt was a lease rejection, and a final fetch confirmed that
   none of our commits is on the remote. If that final fetch fails or finds one, exit 5;
5. re-fetch and require our commit on the remote head's first-parent chain with the exact tree
   and bytes we built; otherwise exit 5 (history rewritten or a writer outside this path).

The ledger-side linearization point is the fast-forward that lands `authorized` (consumption) and,
separately, the one that lands `effect_send` (the send right). Terminal truth is only ever what
the provider (GitHub Deployments API) reports.

## 4. Per-promotion state machine

`promotion_id = {run_id, run_attempt}` of the **source** (build) run. Another `run_attempt` is
another promotion.

| path | sequence |
|---|---|
| normal | `authorized(approval_granted)` → `effect_send` → `effect_requested(deployment_id)` → `terminal(operation_completed, same deployment_id)` |
| unknown response | `authorized` → `effect_send` → [`effect_requested(deployment_id: null)`] → `terminal(abandoned_no_effect)` or `terminal(via=reconcile, operation_completed)` |
| break_glass after the fact | `authorized(break_glass_approve, recorded_after_side_effect: true, external_effect)` → `terminal(operation_completed, deployment_id == external_effect.deployment_id)`; `effect_send`/`effect_requested` forbidden |

Everything else is a fold problem (e.g. terminal right after authorized, abandoned without
`effect_send`, abandoned when a deployment id is known, `effect_send` without `authorized`, a
second `effect_send`, a second terminal). A `break_glass_approve` *without*
`recorded_after_side_effect` follows the normal path.

Provider state → `outcome` (schema and fold): `success → completed`;
`failure | error | inactive → failed`. `pending | queued | in_progress` and any state not in the
table cannot be written as a terminal. `desired_state_observed.matches` (live
`release-manifest.json` read-back) is recorded separately and never changes `outcome`.

## 5. Consumption rules

- An `approval_event_id` appears in at most one `authorized` in the whole ledger (all targets).
- `authorize` takes `--evidence-archive <zip>` (required): the zip of the
  `release-evidence-out-<run_id>-<run_attempt>` artifact of the source run attempt. It resolves
  that artifact by exact name in the run's artifacts (unique, `expired=false`), requires the
  sha256 of the zip bytes to equal the artifact's Actions API `digest`, and only then extracts
  the top-level `bundle.json` and `receipt.json` **from those same bytes** (no extracted
  directory on disk is read). The zip reader (`src/promotion/zip.ts`, no dependency) accepts
  stored / deflate entries only and refuses zip64, encryption, duplicate names, `..` / absolute /
  backslash names, symlinks, central-directory vs local-header disagreement, data descriptors
  that do not repeat the central directory's crc/sizes (these structural checks run over every
  entry), and -- for the two entries it actually extracts -- inflation beyond the declared size,
  CRC32 mismatch, and entries over 16 MiB (entries it does not extract are never inflated, so
  their payload is not CRC- or size-checked); a refusal is exit 3. Because the digest check needs
  the artifact listing, that one provider call precedes the ledger-only early refusal.
- `authorize` consumes only if, in ledger order after ingest: the approval is of the requested
  kind, same target, not revoked, not consumed; `subject.bundle_digest` = JCS sha256 of
  `bundle.json`; `subject.receipt_digest` = JCS sha256 of `receipt.json`; a `promotion_id` field
  in the receipt (present once the B1 revision of `promotion-receipt` is vendored) equals the
  promotion exactly; the source run attempt is
  `completed/success` and its `head_sha` = the bundle's `source.commit_sha`;
  `expires_at − now > expiry_safety_window_s` (equal is refused).
- A revoke ingested **before** consumption refuses it. A revoke of an already consumed approval
  is ingested together with a `revoked_after_consume` line; the promotion's outcome is unchanged.

### Expiry is not atomic

`now` is the GitHub API `Date` header, never the runner clock. It is fetched at evaluation and
again as the last step before the push; both must leave more than the safety window. This
narrows, but does not close, the gap between "checked" and "landed" — the push itself is not
time-bounded. The safety window is the margin that absorbs it; it is not a strict guarantee.

## 6. Lock

A target is **locked** iff it has an `authorized` promotion without a terminal, or a
`late_effect_detected` without `late_effect_resolved`. `authorize` refuses on a locked target;
`send` refuses if anything other than the promotion itself locks it. `lock-status` reports
`{locked, reasons, open_promotions, pending_late_effects}` and always exits 0 (an invalid ledger
reads as `locked: true, reasons: ["ledger_invalid"]`).

## 7. Send and crash windows

`send` = CAS(`effect_send`) → re-read of the ledger → one POST `/pages/deployments` →
CAS(`effect_requested`). The `effect_send` `event_id` also covers the CAS call's nonce, and
before the POST `send` re-reads the remote ledger and requires the promotion's `effect_send` to be
exactly the line it wrote (same `event_id`); otherwise exit 3 and no POST. Once `effect_send`
landed, no path POSTs again: a rerun of `send` is exit 3. Timeout / network error /
5xx / id-less 2xx = `effect_requested(deployment_id: null, response_observed: false)`, exit 6; a
4xx is `deployment_id: null, response_observed: true`, exit 6. If the process dies between any two
steps, the promotion stays open (locked) until `reconcile`.

The Pages artifact is the executor attempt's own: name
`github-pages-<executor.run_id>-<executor.run_attempt>`, exactly one in
`listRunArtifacts(executor.run_id)`, `expired=false`, `workflow_run.id = executor.run_id`, its id
= `--pages-artifact-id` and its digest = the archive bytes. An artifact of another attempt of the
same executor run is refused.

Name, owner run and API digest say nothing about *what* is served, so before the `effect_send`
CAS `send` also reads those same archive bytes the way `actions/upload-pages-artifact` lays them
out — a zip with a top-level `artifact.tar` (uncompressed tar, ≤ 256 MiB) — extracts the tar into
a temporary directory (always removed) and recomputes the content manifest with
`src/manifest/manifest.ts` (`release-manifest.json` excluded as usual). It must equal
`authorized.resolved.source_artifact.content_manifest_digest`; otherwise exit 3, nothing written,
no POST. The tar reader (`src/promotion/tar.ts`) accepts ustar / GNU headers with valid checksums,
GNU long names (`L`) and pax `path` (`x`), regular files and directories only; symlinks, hard
links, devices, unknown typeflags, `..` / absolute / backslash paths, duplicates, size overruns
and a malformed end of archive are refused.

Entry names must read the same in every common decoder (bsdtar, GNU tar, Python `tarfile`), so
each entry has exactly **one** name source. The nominal precedence is pax `path` > GNU long name
(`L`) > ustar `prefix`/`name`, but a mixture is not resolved by it — it is refused (exit 3):
an entry carrying both an `L` and a pax `path` (in either order); a pax global header (`g`); a
GNU long link name (`K`); two `L` or two `x` headers for one entry; an `L` / `x` not followed by
a regular file or directory entry; a pax key repeated within one header. An `L` alone, an `x`
alone, or an `L` with a path-less `x` (e.g. only `mtime`) name the entry as usual. Names (tar
header fields, `L` bodies, pax records and zip entry names alike) are decoded as strict UTF-8
with the BOM kept (`TextDecoder(..., { fatal: true, ignoreBOM: true })`): invalid UTF-8 is
refused, and a name containing U+FEFF is refused rather than silently stripped.

Artifact ids (source / evidence / Pages) are kept as decimal strings and compared as strings.
`authorize` and `send` refuse (exit 3, before any write or POST) an id that is not a safe integer
(`Number.isSafeInteger`, ≤ 2^53 − 1 = 9007199254740991), so the POST body's numeric
`artifact_id` is always exactly the id that was checked. `effect_send.pages_artifact` records
`{id, name, archive_digest, content_manifest_digest}`, and the fold requires that
`content_manifest_digest` to equal the authorized one.

`request_fingerprint` = JCS sha256 of `{artifact_id, pages_build_version}` — the POST body as
sent (`artifact_id` as the JSON number, built by the same function as the POST) **without**
`oidc_token`. The token is read from a file and never written to stdout, logs, or the
ledger. `pages_build_version = <head_sha>:<run_id>:<run_attempt>`.

## 8. Reconcile

`reconcile` needs `--confirmed-full-listing --observed-at --actor-login` (a human attests they
checked the full listing). A human-entered deployment *state* is never accepted.

Attribution rule (`matchesPromotion`, `src/promotion/provider.ts`): a deployment *carries a marker*
when a `pages_build_version`-shaped string `<sha>:<run_id>:<run_attempt>` appears in its `ref`,
`description` or `payload`.

- **marker** — every marker it carries equals this promotion's `pages_build_version`: the
  deployment is this promotion's. Only this (or the id the promotion's own POST returned in
  `effect_requested`) can produce a terminal.
- **mismatch** — it carries a marker of any other promotion (another attempt of the same run
  included): never this promotion's, and it does **not** fall through to the fallback.
- **fallback** — no marker at all, but `{environment, sha, created_at ≥ send_at − lookback}` fit.
  A fallback fit is a *suspicion*, never an attribution: it blocks `abandoned_no_effect` and is
  detected as a late effect (both only add locks), but never closes a promotion.

A deployment id belongs to at most one promotion in the whole ledger: once `effect_requested`,
`terminal`, `authorized.external_effect` or a `late_effect_*` records it, an event that would tie
it to a different promotion is a fold problem (`deployment_attributed_elsewhere`).

1. **candidate terminal** — `--candidate-deployment-id` (or the id from `effect_requested`):
   `getDeployment` + statuses; it must be the `effect_requested` id or a **marker** match, not
   recorded for anyone else, and terminal → `terminal(via=reconcile, operation_completed)`
   (`reconcile.listing` = null). A marker of another promotion (`candidate_mismatch`), a
   marker-less candidate (`candidate_without_marker`), or one already recorded elsewhere
   (`candidate_attributed_elsewhere`) is exit 6, nothing written, lock kept.
2. **confirmed absence** — no candidate: list all deployments (every page) since
   `send_at − reconcile_lookback_s` plus the Pages deployment listing. Zero marker / fallback
   matches (deployments the ledger records for *another promotion* are explained and skipped) ∧
   listing complete (Pages listing `checked` or `unsupported`) ∧ `now − send_at ≥ settle_window_s`
   → `terminal(abandoned_no_effect)` with the listing summary and criteria.
3. **ambiguous** — any match without a candidate, more than one, incomplete listing (including
   the late-effect scan's), a non-terminal candidate, or the settle window still open → exit 6,
   **no event written**. This is decided inside the CAS callback: if a deployment appears between
   a lost lease and the retry, the retry sees it and exits 6 instead of writing
   `abandoned_no_effect`.

**If the marker never shows up on real deployments** (integration item below), candidate
reconcile cannot succeed for an unknown send: a marker-less deployment is exit 6 forever, and so
is confirmed absence while that deployment is in the window — waiting for the provider to report
it terminal does not help, because a fallback fit cannot be attributed. The promotion then stays
open and the target locked until the marker question is settled (or a human repairs the ledger
outside this CLI). Only sends whose POST returned an id (`effect_requested.deployment_id`) can be
finalized / reconciled without the marker.

"Latest status" = `created_at` descending, then status `id` descending compared as `BigInt`
(ids beyond `Number.MAX_SAFE_INTEGER` keep every digit: unsafe integer literals in API responses
are parsed as strings). A status id that is not `^[0-9]+$` makes the listing unusable — no
latest, so no terminal can be written from it (exit 6 with `problems`).

The deployments listing (`GET /deployments?environment=github-pages`, `per_page=100`, used by the
late-effect scan and confirmed-absence reconcile) relies on GitHub returning it newest first. It
walks pages until one reaches back before `since` (every later page is older: complete), or until
a page has no `Link: rel="next"` (complete). A page out of `created_at` descending order, an
unparseable `created_at`, an error, or the 1,000-page safety valve make it incomplete (late-effect
scan: exit 3 `late_effect_scan_incomplete`; reconcile: exit 6 `listing_incomplete`). A long
deployment history therefore no longer locks a target whose recent window is small.
`Link` is parsed per RFC 8288 (quoted-string parameter values, commas inside them, token or quoted
`rel`, several relation types); a header that cannot be parsed makes the listing incomplete.
`created_at` / `updated_at` (and `since`) must be strict RFC 3339 instants (`T`, seconds, `Z` or
`±hh:mm`) whose calendar date and time exist as written; any other value makes the listing
incomplete (an invalid `since` is a caller error, exit 3).

## 9. Late effects (residual risk)

`abandoned_no_effect` can be wrong (the provider showed the deployment late), and an unknown
send of one attempt can surface while another promotion has already been closed. `authorize`,
`send` (its `effect_send` step), `finalize` and promotion-mode `reconcile` list every deployment
of the environment created since the earliest `send_at − reconcile_lookback_s` of the target's
sent promotions, and append `late_effect_detected` (which locks the target) for each one **no
promotion has recorded** — except one whose marker is exactly an *open* promotion's (that
promotion already locks the target; `finalize` / `reconcile` attribute it). Fallback fits and
foreign deployments are detected too: detection only adds locks. `matched_promotion_id` is set
only from an exact marker (of a terminal promotion), else `null`. That detection (with the ingest
before it) is committed **even if the command is then refused** for the lock it causes, so the
lock is durable (for `reconcile`, an incomplete scan listing is exit 6). `reconcile
--late-effect-event-id` resolves it once the deployment is terminal (`attributed_to_promotion`
only on an exact marker of the matched promotion, else `external_unattributed`). Terminals are
never rewritten. A deployment that appears after the last write command is not detected until
the next one.

## 10. Digests

- `archive_digest`: sha256 of the zip archive bytes (Actions API `artifact.digest`, compared to
  the real bytes when `--archive-path` / `--pages-artifact-archive` is given).
- `effect_send.pages_artifact.content_manifest_digest`: the content manifest `send` recomputed
  from the Pages archive's `artifact.tar` (§7); equal to the authorized one.
- `source_artifact.evidence_artifact = {id, name, archive_digest}`: the evidence artifact the
  receipt and bundle were extracted from. `archive_digest` (required, never `null`) is the
  Actions API `digest` that the `--evidence-archive` bytes matched before extraction, so the
  receipt and bundle bytes are attributed to the artifact through the API digest of the very zip
  they came from, not through a name.
- `content_manifest_digest` (in this ledger): JCS sha256 of the content manifest recomputed from
  the extracted site (`src/manifest/manifest.ts`), which must equal the sealed bundle's
  `static_site` `artifacts[].digest`. The site's own `release-manifest.json` must also read back
  consistently and its bytes must hash to the bundle's `content_manifest_digest`.

The two are different objects: same content can ship in different archives, and the archive
digest says nothing about what the site serves. The site is extracted outside the CLI
(`actions/download-artifact` → `--site-dir`); the evidence artifact is read by the CLI from its
API-digest-matched zip (§5).

## 11. Operating conditions ("no writer but the workflow")

The CAS protects ordering only among writers that use it. Required around it:

- a dedicated credential that can push only the ledger ref, used only by the allowed workflow(s);
- a ruleset on `refs/heads/promotion-ledger`: fast-forward only, push restricted to that
  credential, **no admin bypass**;
- the CLI checks that the ledger checkout's `origin` equals `remote_url` and writes only the fixed
  ref `refs/heads/promotion-ledger` (exit 2 otherwise);
- the authority checkout must be on `main` (`HEAD == refs/heads/main`), read from git objects.

## 12. Exit codes

0 ok · 1 ledger invalid · 2 usage / config · 3 precondition unmet (nothing written, except a
late-effect detection, §9) · 4 CAS retries exhausted (every push lease-rejected, final fetch
shows none of ours, §3) · 5 read-back mismatch or push outcome uncertain (§3) · 6 non-terminal
(lock continues).

## 13. Composite verifier

The vendored `release-approval/v0/verify-fixtures.mjs` exports no function (its checks run only
through its CLI `main()`), so **the composite verifier is not called** (waiting on a playbook-side
export). `src/promotion/authority.ts` applies the schema, the personal-dimension scan, R18
`event_id` recomputation, real calendar dates, `expires_at > occurred_at`, unique `event_id`,
revoke resolution within the same target (matching subject, strictly later), and
`subject.target == "production"`. The approval subject carries an environment tier, not a
repository: the repository binding is the authority file the event was read from.

## Integration items (unconfirmed)

- **Highest priority — whether a Pages deployment appears in `/deployments` with
  `pages_build_version` in `ref`/`payload`/`description`.** Attribution depends on it: without
  the marker, the `{environment, sha, created_at ≥ send_at − lookback}` fallback only detects and
  locks, so an unknown send can never be closed by `reconcile` (§8). Confirm on a real
  repository before relying on reconcile. All matching goes through `matchesPromotion`
  (`src/promotion/provider.ts`), replaceable via `PromoteDeps.matchesPromotion`.
- `POST /repos/{o}/{r}/pages/deployments` response fields (`id`, `status_url`) and id type.
- The Pages artifact archive layout (zip with a top-level uncompressed `artifact.tar`, as
  `actions/upload-pages-artifact` writes it) and the tar dialect it produces (GNU / ustar).
- `GET /pages/deployments` listing: not documented; 404 is treated as `unsupported`.
- Actions artifact `digest` format (`sha256:<hex>` assumed).
- `promotion-receipt/v0` has no promotion id. During this migration period
  `authorized.resolved.receipt_promotion_id` is `null` and the id is recorded separately as
  `derived_promotion_id = {run_id, run_attempt, derived_from: "artifact_name"}`, synthesized from
  the name `release-evidence-out-<run_id>-<run_attempt>` (unique within the source run's
  artifacts, `expired=false`) of the artifact whose API digest matched the zip the receipt was
  extracted from. Once the receipt carries `promotion_id` (B1 revision vendored), it must equal
  the promotion exactly or `authorize` refuses; then `receipt_promotion_id` holds that value and
  `derived_promotion_id` is `null`. The fold requires exactly one of the two to be non-null and
  equal to `promotion_id` (`promotion_id_attribution`, `receipt_promotion_id_mismatch`,
  `derived_promotion_id_mismatch`).
- Why the source artifact must come from the source run attempt itself (not "latest" or another
  run): the approval binds bundle and receipt digests; only the named artifact of the attempt
  that produced them is guaranteed to hold those bytes, and a re-run attempt is a separate
  promotion. The Pages artifact must be uploaded by the executor run (`workflow_run.id`).

## Remaining work on the harvester side

- `promote.yml`: authorize → upload Pages artifact → send → finalize, with the dedicated
  credential and the ruleset above.
- a `workflow_dispatch` for `reconcile` (human inputs: `observed_at`, `actor_login`,
  `confirmed_full_listing`, optional candidate / late-effect id).
- remove `deploy-pages` from the scheduled run (it must not send outside this path).
- rename build artifacts to `site-dist-<run_id>-<run_attempt>` and
  `release-evidence-out-<run_id>-<run_attempt>`; pass the latter to `authorize` as
  `--evidence-archive` **without extracting it**: do not run `gh run download` or
  `actions/download-artifact` and re-zip the result (a re-zipped archive never matches the API
  digest); fetch the bytes from the artifact's Actions API `archive_download_url` and pass that
  file unchanged.
- set `actions/upload-pages-artifact`'s `name` to
  `github-pages-${{ github.run_id }}-${{ github.run_attempt }}` (the executor run), which `send`
  requires by exact name.
