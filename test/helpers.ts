// Shared test helpers. RELEASE_EVIDENCE_CONTRACTS_DIR must point at the release-evidence/v0
// contracts directory in ai-agent-skills-playbook; any test that calls into schema validation
// (validateBundle/validateEvent, and anything built on top of them) needs it, and is skipped
// with an explicit message when it is not set rather than failing opaquely.

export const CONTRACTS_DIR = process.env.RELEASE_EVIDENCE_CONTRACTS_DIR;
export const HAS_CONTRACTS_DIR = Boolean(CONTRACTS_DIR);

if (!HAS_CONTRACTS_DIR) {
  console.warn(
    "RELEASE_EVIDENCE_CONTRACTS_DIR is not set -- schema-backed tests (bundle/event/ledger/conformance) will be skipped. " +
      "Set it to the release-evidence/v0 contracts dir in ai-agent-skills-playbook to run them.",
  );
}
