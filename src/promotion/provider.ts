// GitHub API adapter. Every call goes through an injected `fetch` (no global network access in
// tests); `now` comes from the API's own `Date` response header, never the runner clock.
// Terminal truth is only ever what the provider reports -- no command accepts a human-supplied
// deployment state.
//
// INTEGRATION ITEMS (not yet confirmed against the real API; see docs/promotion-protocol.md):
// the Pages deployment create response fields ({id, status_url}), whether a Pages deployment
// shows up in /deployments with ref/payload/description carrying pages_build_version, the
// Actions artifact `digest` format, and the (undocumented) Pages deployment listing endpoint.
// `matchesPromotion` is the single predicate all of reconcile / late-effect / unknown-response
// matching uses, so a field correction is a one-place change (commands accept a replacement).

import { PAGES_ENVIRONMENT, PromotionError } from "./types.js";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ProviderOptions {
  fetch: FetchFn;
  apiBase: string;
  repository: string;
  token?: string | undefined;
  timeoutMs?: number;
}

export interface RunArtifact {
  id: string;
  name: string;
  expired: boolean;
  digest: string | null;
  workflow_run_id: string | null;
}

export interface Deployment {
  id: string;
  sha: string;
  ref: string;
  environment: string;
  created_at: string;
  payload: unknown;
  description: string | null;
}

export interface DeploymentStatus {
  id: string;
  state: string;
  created_at: string;
}

export interface Listing<T> {
  complete: boolean;
  items: T[];
  pages_fetched: number;
  reason?: string;
}

export type PagesCreateResult =
  | { kind: "created"; id: string; status_url: string | null }
  | { kind: "rejected"; status: number }
  | { kind: "unknown"; reason: string };

export interface PromotionMatchInput {
  pages_build_version: string;
  head_sha: string;
  send_at: string;
}

export type MatchesPromotion = (
  deployment: Deployment,
  promotion: PromotionMatchInput,
  lookbackS: number,
) => boolean;

/** THE deployment <-> promotion predicate (one place only). The pages_build_version
 * fingerprint wins when present anywhere in ref/payload/description; otherwise fall back to
 * {environment, sha, created_at >= send_at - lookback}. */
export const matchesPromotion: MatchesPromotion = (deployment, promotion, lookbackS) => {
  const haystack = [
    deployment.ref,
    deployment.description ?? "",
    JSON.stringify(deployment.payload ?? null),
  ];
  if (haystack.some((s) => s.includes(promotion.pages_build_version))) return true;
  return (
    deployment.environment === PAGES_ENVIRONMENT &&
    deployment.sha === promotion.head_sha &&
    Date.parse(deployment.created_at) >= Date.parse(promotion.send_at) - lookbackS * 1000
  );
};

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

type Json = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function toDeployment(raw: Json): Deployment {
  return {
    id: str(raw.id),
    sha: str(raw.sha),
    ref: str(raw.ref),
    environment: str(raw.environment),
    created_at: str(raw.created_at),
    payload: raw.payload ?? null,
    description: typeof raw.description === "string" ? raw.description : null,
  };
}

export class GitHubProvider {
  private readonly owner: string;
  private readonly repo: string;

  constructor(private readonly opts: ProviderOptions) {
    const [owner, repo] = opts.repository.split("/");
    if (!owner || !repo) throw new PromotionError(2, `bad repository "${opts.repository}"`);
    this.owner = owner;
    this.repo = repo;
  }

  private url(p: string): string {
    return `${this.opts.apiBase.replace(/\/+$/, "")}/repos/${this.owner}/${this.repo}${p}`;
  }

  private async request(
    method: string,
    p: string,
    body?: unknown,
  ): Promise<{ status: number; headers: Headers; json: unknown }> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.opts.fetch(this.url(p), init);
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(quoteUnsafeIntegers(text)) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, json };
  }

  private async getOk(p: string): Promise<{ headers: Headers; json: Json }> {
    const r = await this.request("GET", p);
    if (r.status !== 200 || r.json === null || typeof r.json !== "object") {
      throw new PromotionError(3, `GitHub API GET ${p} returned ${r.status}`);
    }
    return { headers: r.headers, json: r.json as Json };
  }

  /** Provider time (the `Date` header). Never falls back to the local clock. */
  async fetchNow(): Promise<string> {
    const { headers } = await this.getOk("");
    const date = headers.get("date");
    const ms = date ? Date.parse(date) : Number.NaN;
    if (Number.isNaN(ms))
      throw new PromotionError(3, "GitHub API response has no usable Date header");
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  async getRunAttempt(
    runId: string,
    attempt: number,
  ): Promise<{ status: string; conclusion: string | null; head_sha: string }> {
    const { json } = await this.getOk(`/actions/runs/${runId}/attempts/${attempt}`);
    if (str(json.id) !== runId || json.run_attempt !== attempt) {
      throw new PromotionError(3, `run attempt response does not describe ${runId}/${attempt}`);
    }
    return {
      status: str(json.status),
      conclusion: typeof json.conclusion === "string" ? json.conclusion : null,
      head_sha: str(json.head_sha),
    };
  }

  private async paginate<T>(p: string, key: string, map: (raw: Json) => T): Promise<Listing<T>> {
    const items: T[] = [];
    const sep = p.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page++) {
      let r: Awaited<ReturnType<GitHubProvider["request"]>>;
      try {
        r = await this.request("GET", `${p}${sep}per_page=${PAGE_SIZE}&page=${page}`);
      } catch (err) {
        return { complete: false, items, pages_fetched: page - 1, reason: (err as Error).message };
      }
      const list = key === "" ? r.json : (r.json as Json | null)?.[key];
      if (r.status !== 200 || !Array.isArray(list)) {
        return {
          complete: false,
          items,
          pages_fetched: page - 1,
          reason: `page ${page}: ${r.status}`,
        };
      }
      items.push(...list.map((x) => map(x as Json)));
      if (list.length < PAGE_SIZE) return { complete: true, items, pages_fetched: page };
    }
    return { complete: false, items, pages_fetched: MAX_PAGES, reason: "page limit reached" };
  }

  async listRunArtifacts(runId: string): Promise<Listing<RunArtifact>> {
    return this.paginate(`/actions/runs/${runId}/artifacts`, "artifacts", (a) => ({
      id: str(a.id),
      name: str(a.name),
      expired: a.expired === true,
      digest: typeof a.digest === "string" ? a.digest : null,
      workflow_run_id: str((a.workflow_run as Json | undefined)?.id) || null,
    }));
  }

  /** POST /pages/deployments. Never throws: timeout / network error / 5xx / unparseable or
   * id-less 2xx all collapse to `unknown` (the request may or may not have taken effect). */
  async createPagesDeployment(input: {
    artifact_id: string;
    oidc_token: string;
    pages_build_version: string;
  }): Promise<PagesCreateResult> {
    try {
      const r = await this.request("POST", "/pages/deployments", {
        artifact_id: Number(input.artifact_id),
        pages_build_version: input.pages_build_version,
        oidc_token: input.oidc_token,
      });
      if (r.status >= 500) return { kind: "unknown", reason: `HTTP ${r.status}` };
      if (r.status >= 400) return { kind: "rejected", status: r.status };
      const json = r.json as Json | null;
      const id = str(json?.id);
      if (r.status < 200 || r.status >= 300 || id.length === 0) {
        return { kind: "unknown", reason: `HTTP ${r.status} without a deployment id` };
      }
      return {
        kind: "created",
        id,
        status_url: typeof json?.status_url === "string" ? json.status_url : null,
      };
    } catch (err) {
      return { kind: "unknown", reason: (err as Error).name || "request failed" };
    }
  }

  async getDeployment(id: string): Promise<Deployment | null> {
    const r = await this.request("GET", `/deployments/${id}`);
    if (r.status === 404) return null;
    if (r.status !== 200 || r.json === null || typeof r.json !== "object") {
      throw new PromotionError(3, `GitHub API GET /deployments/${id} returned ${r.status}`);
    }
    return toDeployment(r.json as Json);
  }

  /** Latest status = created_at descending, then id descending (decimal ids compared as BigInt;
   * any id that is not `^[0-9]+$` is a problem and makes the listing unusable: latest = null, so
   * no terminal can be derived from it). */
  async listDeploymentStatuses(
    id: string,
  ): Promise<{ latest: DeploymentStatus | null; problems: string[] }> {
    const listing = await this.paginate(`/deployments/${id}/statuses`, "", (s) => ({
      id: str(s.id),
      state: str(s.state),
      created_at: str(s.created_at),
    }));
    if (!listing.complete) {
      throw new PromotionError(3, `deployment ${id} statuses incomplete: ${listing.reason}`);
    }
    const problems = listing.items
      .filter((s) => !/^[0-9]+$/.test(s.id))
      .map((s) => `deployment ${id} status id ${JSON.stringify(s.id)} is not a decimal integer`);
    if (problems.length > 0) return { latest: null, problems };
    const sorted = [...listing.items].sort((a, b) => {
      const byTime = Date.parse(b.created_at) - Date.parse(a.created_at);
      if (byTime !== 0) return byTime;
      const [x, y] = [BigInt(a.id), BigInt(b.id)];
      return x === y ? 0 : y > x ? 1 : -1;
    });
    return { latest: sorted[0] ?? null, problems };
  }

  /** All deployments for the environment with created_at >= since (every page). */
  async listDeployments(opts: { environment: string; since: string }): Promise<
    Listing<Deployment>
  > {
    const listing = await this.paginate(
      `/deployments?environment=${encodeURIComponent(opts.environment)}`,
      "",
      toDeployment,
    );
    const since = Date.parse(opts.since);
    return { ...listing, items: listing.items.filter((d) => Date.parse(d.created_at) >= since) };
  }

  /** Pages deployment listing: 404 = endpoint unsupported; 403 / timeout / partial = incomplete. */
  async listPagesDeployments(): Promise<{
    status: "checked" | "unsupported" | "incomplete";
    items: Deployment[];
  }> {
    let first: Awaited<ReturnType<GitHubProvider["request"]>>;
    try {
      first = await this.request("GET", `/pages/deployments?per_page=${PAGE_SIZE}&page=1`);
    } catch {
      return { status: "incomplete", items: [] };
    }
    if (first.status === 404) return { status: "unsupported", items: [] };
    const listing = await this.paginate("/pages/deployments", "", (raw) => ({
      ...toDeployment(raw),
      environment: PAGES_ENVIRONMENT,
      ref: str(raw.ref) || str(raw.pages_build_version) || str(raw.build_version),
      sha: str(raw.sha) || str(raw.commit),
    }));
    return { status: listing.complete ? "checked" : "incomplete", items: listing.items };
  }
}

/** Rewrites integer literals outside strings that a JS number cannot hold exactly (ids beyond
 * Number.MAX_SAFE_INTEGER) into JSON strings, so JSON.parse keeps every digit. Assumes
 * well-formed JSON; anything else is left to JSON.parse to reject. */
export function quoteUnsafeIntegers(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j] as string)) j++;
      const tok = text.slice(i, j);
      out += /^-?[0-9]+$/.test(tok) && !Number.isSafeInteger(Number(tok)) ? `"${tok}"` : tok;
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** The one name-addressed artifact of a run: exact name, unique, not expired, with a digest. */
export function resolveRunArtifact(listing: Listing<RunArtifact>, name: string): RunArtifact {
  if (!listing.complete) {
    throw new PromotionError(3, `artifact listing incomplete: ${listing.reason ?? "unknown"}`);
  }
  const hits = listing.items.filter((a) => a.name === name);
  if (hits.length !== 1) {
    throw new PromotionError(
      3,
      `expected exactly one artifact named ${name}, found ${hits.length}`,
    );
  }
  const hit = hits[0] as RunArtifact;
  if (hit.expired) throw new PromotionError(3, `artifact ${name} has expired`);
  if (!hit.digest || !/^sha256:[0-9a-f]{64}$/.test(hit.digest)) {
    throw new PromotionError(3, `artifact ${name} has no usable sha256 digest`);
  }
  return hit;
}
