// TS types mirroring contracts/release-evidence/v0's two JSON schemas
// (release-evidence-bundle.schema.json, release-event.schema.json). These types describe
// SHAPE only -- they do not enforce the schema's semantic constraints (patterns, closed
// enums tied to sibling fields, the allOf/if-then-else oneOf-omission pairs). Runtime
// validity is always decided by validateBundle()/validateEvent() (bundle.ts / event.ts),
// which run the actual vendored schema validator against these values. Treat a value typed
// `Bundle` or `ReleaseEvent` here as "shaped like one", not "known valid" -- always route
// anything from outside this process (CLI input, ledger reads, fixtures) through validation
// before trusting it as a real attempt record.

export type ArtifactKind = "package" | "static_site" | "container" | "binary" | "other";

export interface ArtifactRef {
  registry: "npm" | "pypi" | "github-pages" | "other";
  package: string;
  version: string;
  distribution?: string;
  registry_url?: string;
  verifiability: "registry_metadata" | "requires_fetch" | "unverifiable";
  unverifiable_reason?: string;
}

export interface BundleArtifact {
  kind: ArtifactKind;
  digest: string; // sha256:<hex>
  /** static_site only (schema-enforced required there, forbidden elsewhere). */
  content_manifest_digest?: string;
  artifact_ref?: ArtifactRef;
}

export interface LaneRef {
  lane_id: string;
  intent_digest: string;
  spec_digest: string;
  consensus_ack_digest: string;
  premise_evidence_digest?: string;
  verification_digest: string;
  matrix_digest?: string;
}

export type LaneRefOmittedCode =
  | "no_lane_scheduled_rebuild"
  | "multiple_contributing_lanes"
  | "legacy_release_predates_contract"
  | "other";

export interface LaneRefOmitted {
  code: LaneRefOmittedCode;
  note: string;
}

export interface Review {
  pr: number;
  head_sha: string;
  decision: "approved" | "commented" | "self_merged";
}

export type ReviewOmittedCode =
  | "scheduled_rebuild_deploys_reviewed_main"
  | "legacy_release_predates_contract"
  | "other";

export interface ReviewOmitted {
  code: ReviewOmittedCode;
  note: string;
}

export interface BundleSource {
  repo: string;
  commit_sha: string;
  tree_digest: string;
  ref?: string;
  resolution: "git_tree";
}

export interface BundleBuild {
  recipe_digest: string;
  recipe_ref?: string;
  toolchain_digest: string;
  toolchain_ref?: string;
}

export interface BundleRollback {
  previous_release_id: string | null;
}

export interface BundleIntegrity {
  level: "digest_only";
  signature: null;
}

/** One attempt's sealed evidence, exactly as defined by release-evidence-bundle.schema.json.
 * Sealed at `prepared`: bundleDigest(bundle) is stable from then on, and a change to any
 * field here (a new tree, a corrected field, a discovered deviation) means a NEW attempt, not
 * an edit to this one -- never mutate a Bundle you have already sealed. */
export interface Bundle {
  schema_version: "release-evidence/v0";
  release_id: string;
  source: BundleSource;
  lane_ref: LaneRef | null;
  lane_ref_omitted?: LaneRefOmitted;
  review: Review | null;
  review_omitted?: ReviewOmitted;
  artifacts: BundleArtifact[];
  build: BundleBuild;
  known_deviations: string[];
  rollback: BundleRollback;
  integrity: BundleIntegrity;
}

export type EventKind =
  | "prepared"
  | "deployed"
  | "verified"
  | "failed"
  | "rolled_back"
  | "attested";
export type Environment = "preview" | "staging" | "production" | null;
export type Actor = "human" | "ci" | "cli";
export type FailurePhase = "deploy" | "verification" | "post_verification";

export interface Attestation {
  kind: "lane_done_overlay";
  digest: string;
  ref?: string;
}

/** One line of the append-only release-events ledger, exactly as defined by
 * release-event.schema.json. The fold unit is the attempt (release_id, bundle_digest); see
 * fold.ts. Never store computed state on an event -- current state is always derived. */
export interface ReleaseEvent {
  schema_version: "release-evidence/v0";
  event_id: string;
  release_id: string;
  kind: EventKind;
  environment: Environment;
  occurred_at: string;
  actor: Actor;
  bundle_digest: string;
  /** failed only. */
  failure_phase?: FailurePhase;
  /** rolled_back only. */
  rollback_to_release_id?: string;
  /** failed and rolled_back only. */
  reason?: string;
  /** deployed|production only, and only on a direct preview_verified -> production jump. */
  staging_skipped?: true;
  /** attested only. */
  attestation?: Attestation;
  notes?: string;
}
