// The promotion ledger's ONLY write path. Linearization point = a fast-forward of the ledger
// ref, made atomic by `git push --force-with-lease=<ref>:<expected>`: a commit only lands if the
// remote head is still the one this process folded and evaluated preconditions against. A lost
// race re-runs everything (fetch -> fold -> buildEvents) against the new head -- events built
// for a stale head are never reused. Internal only: no public command can append an arbitrary
// event; each command supplies a buildEvents callback that derives events from the fold.
//
// History rules checked on every read (a violation is "ledger invalid", exit 1): every commit
// has at most one parent, every tree holds exactly the ledger file, and each commit's ledger is
// a byte prefix-extension of its parent's (append-only). After a successful push the remote is
// re-fetched and our commit must be on the remote head's first-parent chain with the exact tree
// we built; otherwise someone rewrote history or wrote outside this path (exit 5).
//
// A non-zero push is classified, never blindly retried: re-fetch first; (a) our commit is the
// remote head or on its first-parent chain -> it landed (read-back as usual, success); (b) not
// landed and git reported a lease rejection (`stale info` / `[rejected]` / `fetch first` /
// `non-fast-forward`, or the remote's ref-transaction compare failing: `cannot lock ref`) -> retry; (c) anything else (network, auth, ruleset, or the re-fetch
// itself failing) -> exit 5 "outcome uncertain", no retry. Exit 4 therefore means: every attempt
// was a lease rejection, and a final fetch confirmed none of our commits is on the remote.
//
// "Our commit" is identified by OID only, and every casCommit call puts a fresh random nonce in
// the commit message (`Promotion-Cas-Nonce: <hex>` trailer, also handed to buildEvents so event
// ids can carry it). Without it two processes that fold the same head with the same provider
// time and git dates build the byte-identical commit, and the loser of the lease would find "its"
// OID on the remote and believe its own push landed.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { PromotionConfig } from "./config.js";
import { type PromotionFoldResult, foldPromotionLedger } from "./fold.js";
import { EXIT, PromotionError, type PromotionEvent } from "./types.js";

export interface GitOptions {
  cwd: string;
  input?: string;
  env?: Record<string, string>;
}

/** Runs git and resolves with stdout; rejects (with stderr in the message) on non-zero exit. */
export type GitRunner = (args: string[], opts: GitOptions) => Promise<string>;

export const execGit: GitRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      // stdin is only opened when there is input to write: git exits without reading stdin for
      // most commands, and ending a pipe the child already closed raises EPIPE on Linux (an
      // unhandled 'error' event on child.stdin, which took the whole CLI down with exit 1).
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf-8"));
      else {
        // stdout too: `push --porcelain` reports per-ref status ("[rejected] (stale info)") there.
        const msg = Buffer.concat(err).toString("utf-8").trim();
        const stdout = Buffer.concat(out).toString("utf-8").trim();
        reject(
          new Error(
            `git ${args[0]} failed (exit ${code}): ${msg}${stdout ? ` | stdout: ${stdout}` : ""}`,
          ),
        );
      }
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code !== "EPIPE") reject(e); // EPIPE: git exited first; its exit code decides
      });
      child.stdin.end(opts.input);
    }
  });

const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "release-evidence promotion",
  GIT_AUTHOR_EMAIL: "promotion-ledger@invalid",
  GIT_COMMITTER_NAME: "release-evidence promotion",
  GIT_COMMITTER_EMAIL: "promotion-ledger@invalid",
};
const FETCHED_REF = "refs/promotion-cas/head";
export const NONCE_TRAILER = "Promotion-Cas-Nonce";

export interface LedgerRepo {
  git: GitRunner;
  repoDir: string;
  config: PromotionConfig;
}

/** The ledger checkout's `origin` must be exactly the configured remote (exit 2 otherwise). */
export async function verifyRemote(repo: LedgerRepo): Promise<void> {
  let url: string;
  try {
    url = (await repo.git(["remote", "get-url", "origin"], { cwd: repo.repoDir })).trim();
  } catch (err) {
    throw new PromotionError(
      EXIT.usage,
      `ledger repo has no origin remote: ${(err as Error).message}`,
    );
  }
  if (url !== repo.config.remote_url) {
    throw new PromotionError(
      EXIT.usage,
      `ledger repo origin "${url}" does not match config remote_url "${repo.config.remote_url}"`,
    );
  }
}

/** Fetches the ledger ref; null when it does not exist on the remote yet. */
export async function fetchHead(repo: LedgerRepo): Promise<string | null> {
  const { git, repoDir, config } = repo;
  const listed = (await git(["ls-remote", "origin", config.ref], { cwd: repoDir })).trim();
  if (listed.length === 0) return null;
  await git(["fetch", "--no-tags", "--quiet", "origin", `+${config.ref}:${FETCHED_REF}`], {
    cwd: repoDir,
  });
  return (await git(["rev-parse", "--verify", `${FETCHED_REF}^{commit}`], { cwd: repoDir })).trim();
}

export interface LedgerSnapshot {
  head: string | null;
  text: string;
  events: unknown[];
  problems: string[];
}

/** Reads the ledger at `head` and checks the whole history shape (see header). */
export async function readLedgerAt(repo: LedgerRepo, head: string | null): Promise<LedgerSnapshot> {
  if (head === null) return { head, text: "", events: [], problems: [] };
  const { git, repoDir, config } = repo;
  const problems: string[] = [];
  const show = async (oid: string): Promise<string | null> => {
    try {
      return await git(["show", `${oid}:${config.ledger_path}`], { cwd: repoDir });
    } catch {
      return null;
    }
  };
  const history = (await git(["rev-list", "--parents", head], { cwd: repoDir }))
    .trim()
    .split("\n")
    .map((l) => l.split(" "));
  const contentCache = new Map<string, string | null>();
  const contentOf = async (oid: string) => {
    if (!contentCache.has(oid)) contentCache.set(oid, await show(oid));
    return contentCache.get(oid) ?? null;
  };
  for (const [commit, ...parents] of history) {
    if (!commit) continue;
    if (parents.length > 1)
      problems.push(`history: commit ${commit} has ${parents.length} parents`);
    const names = (await git(["ls-tree", "--name-only", commit], { cwd: repoDir }))
      .split("\n")
      .filter((n) => n.length > 0);
    if (names.length !== 1 || names[0] !== config.ledger_path) {
      problems.push(
        `history: commit ${commit} tree must contain only ${config.ledger_path}, has [${names.join(", ")}]`,
      );
    }
    const parent = parents[0];
    if (parents.length === 1 && parent) {
      const before = (await contentOf(parent)) ?? "";
      const after = (await contentOf(commit)) ?? "";
      if (!after.startsWith(before)) {
        problems.push(`history: commit ${commit} is not an append-only extension of ${parent}`);
      }
    }
  }
  const text = (await contentOf(head)) ?? "";
  if (text.length > 0 && !text.endsWith("\n")) problems.push("ledger: last line is not terminated");
  const events: unknown[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.length === 0) return;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      problems.push(`ledger line ${i + 1}: not valid JSON (${(err as Error).message})`);
    }
  });
  return { head, text, events, problems };
}

/** fetch + full validation + fold, no write. Throws exit 1 on an invalid ledger. */
export async function loadLedger(
  repo: LedgerRepo,
): Promise<{ snapshot: LedgerSnapshot; fold: PromotionFoldResult }> {
  const snapshot = await readLedgerAt(repo, await fetchHead(repo));
  const fold = foldPromotionLedger(snapshot.events);
  const problems = [...snapshot.problems, ...fold.problems];
  if (problems.length > 0) {
    throw new PromotionError(EXIT.ledgerInvalid, "promotion ledger is invalid", { problems });
  }
  return { snapshot, fold };
}

export interface CasContext {
  head: string | null;
  attempt: number;
  /** This casCommit call's random nonce (32 hex chars), also in the commit message trailer. */
  nonce: string;
  fold: PromotionFoldResult;
  events: unknown[];
}

export interface CasHooks {
  /** Test seam: runs after the commit is built and before the push (simulate a racing writer). */
  beforePush?: (attempt: number) => Promise<void>;
  /** Test seam: runs after a successful push and before the read-back verification. */
  afterPush?: (commit: string) => Promise<void>;
}

export interface CasResult {
  committed: boolean;
  commit: string | null;
  events: PromotionEvent[];
  fold: PromotionFoldResult;
  attempts: number;
}

export async function casCommit(
  repo: LedgerRepo,
  buildEvents: (ctx: CasContext) => Promise<PromotionEvent[]>,
  hooks: CasHooks = {},
): Promise<CasResult> {
  const { git, repoDir, config } = repo;
  const pushFailures: string[] = [];
  const ourCommits: string[] = [];
  const nonce = randomBytes(16).toString("hex");
  for (let attempt = 1; attempt <= config.max_cas_retries; attempt++) {
    const { snapshot, fold } = await loadLedger(repo);
    const events = await buildEvents({
      head: snapshot.head,
      attempt,
      nonce,
      fold,
      events: snapshot.events,
    });
    if (events.length === 0)
      return { committed: false, commit: null, events, fold, attempts: attempt };

    const after = foldPromotionLedger([...snapshot.events, ...events]);
    if (after.problems.length > 0) {
      throw new PromotionError(EXIT.precondition, "built events are not legal on the ledger", {
        problems: after.problems,
      });
    }
    const text = `${snapshot.text}${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
    const blob = (
      await git(["hash-object", "-w", "--stdin"], { cwd: repoDir, input: text })
    ).trim();
    const tree = (
      await git(["mktree"], { cwd: repoDir, input: `100644 blob ${blob}\t${config.ledger_path}\n` })
    ).trim();
    const message = `promotion-ledger: ${events.map((e) => e.kind).join(", ")}\n\n${NONCE_TRAILER}: ${nonce}`;
    const parentArgs = snapshot.head ? ["-p", snapshot.head] : [];
    const commit = (
      await git(["commit-tree", tree, ...parentArgs, "-m", message], {
        cwd: repoDir,
        env: COMMIT_IDENTITY,
      })
    ).trim();

    ourCommits.push(commit);
    await hooks.beforePush?.(attempt);
    try {
      await git(
        [
          "push",
          "--porcelain",
          "--quiet",
          `--force-with-lease=${config.ref}:${snapshot.head ?? ""}`,
          "origin",
          `${commit}:${config.ref}`,
        ],
        { cwd: repoDir },
      );
    } catch (err) {
      const pushError = (err as Error).message;
      const landed = await landedOnRemote(repo, [commit], pushError);
      if (landed === null) {
        if (!LEASE_REJECTED.test(pushError)) {
          throw uncertain("push failed without a lease rejection", commit, pushError);
        }
        pushFailures.push(`attempt ${attempt}: ${pushError}`);
        continue; // lost the race: re-fetch, re-fold, rebuild from scratch
      }
      // (a) the push took effect although git reported failure: fall through to read-back.
    }

    await hooks.afterPush?.(commit);
    await verifyLanded(repo, commit, tree, text);
    return { committed: true, commit, events, fold: after, attempts: attempt };
  }
  const stray = await landedOnRemote(repo, ourCommits, pushFailures.at(-1) ?? "");
  if (stray !== null) {
    throw uncertain("a commit of ours is on the remote after rejected pushes", stray, "");
  }
  throw new PromotionError(
    EXIT.casExhausted,
    `CAS retries exhausted (${config.max_cas_retries}): every push was a lease rejection and a final fetch shows none of our commits on the remote`,
    { push_failures: pushFailures },
  );
}

// Client-side lease/fast-forward refusals, plus the receiving side's own compare failing in its
// ref transaction when two pushes race past the advertisement ("[remote rejected] ... cannot lock
// ref '<ref>': reference already exists" / "is at <oid> but expected <oid>"). Only consulted
// after the re-fetch showed our commit did not land.
const LEASE_REJECTED =
  /stale info|\[rejected\]|fetch first|non-fast-forward|cannot lock ref '[^']+': (?:reference already exists|is at [0-9a-f]+ but expected [0-9a-f]*)/;

function uncertain(msg: string, commit: string, pushError: string): PromotionError {
  return new PromotionError(EXIT.readBackMismatch, `push outcome uncertain: ${msg}`, {
    commit,
    push_error: pushError,
  });
}

/** Re-fetches the ledger ref and returns the first of `commits` (our own OIDs, each unique by
 * its nonce) that is the remote head or on its first-parent chain (null = none landed). Same
 * tree or same events under a different OID is someone else's commit. A failing fetch is
 * "uncertain" (exit 5). */
async function landedOnRemote(
  repo: LedgerRepo,
  commits: string[],
  pushError: string,
): Promise<string | null> {
  let head: string | null;
  let chain: string[];
  try {
    head = await fetchHead(repo);
    if (head === null) return null;
    chain = (await repo.git(["rev-list", "--first-parent", head], { cwd: repo.repoDir }))
      .trim()
      .split("\n");
  } catch (err) {
    throw uncertain(
      `cannot re-fetch the ledger ref (${(err as Error).message})`,
      commits.at(-1) ?? "",
      pushError,
    );
  }
  return commits.find((c) => chain.includes(c)) ?? null;
}

async function verifyLanded(repo: LedgerRepo, commit: string, tree: string, text: string) {
  const { git, repoDir, config } = repo;
  const fail = (msg: string): never => {
    throw new PromotionError(EXIT.readBackMismatch, `read-back after push failed: ${msg}`, {
      commit,
    });
  };
  const head = await fetchHead(repo);
  if (head === null) fail("ledger ref disappeared from the remote");
  const chain = (await git(["rev-list", "--first-parent", head as string], { cwd: repoDir }))
    .trim()
    .split("\n");
  if (!chain.includes(commit)) {
    fail(`commit ${commit} is not on the first-parent chain of remote head ${head}`);
  }
  const landedTree = (await git(["rev-parse", `${commit}^{tree}`], { cwd: repoDir })).trim();
  if (landedTree !== tree) fail(`tree ${landedTree} != built tree ${tree}`);
  const landed = await git(["show", `${commit}:${config.ledger_path}`], { cwd: repoDir });
  if (landed !== text) fail("ledger content at the landed commit differs from what was built");
}
