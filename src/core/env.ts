/** The release-evidence/v0 contracts directory (containing release-evidence-bundle.schema.json
 * and release-event.schema.json), owned by ai-agent-skills-playbook. This repo never imports
 * that repo's files by path (D8) -- it reads the schemas at runtime from wherever this env
 * var points, so schema drift is a test failure here rather than a silent fork. */
export function getContractsDir(): string {
  const dir = process.env.RELEASE_EVIDENCE_CONTRACTS_DIR;
  if (!dir) {
    throw new Error(
      "RELEASE_EVIDENCE_CONTRACTS_DIR is not set. Point it at the release-evidence/v0 " +
        "contracts directory in ai-agent-skills-playbook " +
        "(the one containing release-evidence-bundle.schema.json and release-event.schema.json).",
    );
  }
  return dir;
}
