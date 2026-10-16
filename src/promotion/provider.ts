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
// Only an exact pages_build_version marker attributes a deployment; the marker-less fallback
// can only add locks (late-effect detection, blocking abandonment), never close a promotion.

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

/** How a deployment relates to one promotion:
 *   "marker"   -- carries a pages_build_version marker and it is exactly this promotion's;
 *   "fallback" -- carries no marker at all, but {environment, sha, created_at window} fit;
 *   "mismatch" -- anything else, including a marker of ANY other promotion (never a fallback).
 * Only "marker" attributes a deployment to a promotion (a terminal may be derived from it);
 * "fallback" is only ever used to detect / suspect an effect (lock, block abandonment). */
export type PromotionMatch = "marker" | "fallback" | "mismatch";

export type MatchesPromotion = (
  deployment: Deployment,
  promotion: PromotionMatchInput,
  lookbackS: number,
) => PromotionMatch;

/** pages_build_version = `<head_sha>:<run_id>:<run_attempt>` (same shape as the schema). */
const MARKER = /(?<![0-9a-f])[0-9a-f]{40}:[1-9][0-9]{0,19}:[1-9][0-9]{0,9}(?![0-9])/g;

/** Every pages_build_version marker found in the deployment's ref / description / payload. */
export function deploymentMarkers(deployment: Deployment): string[] {
  const haystack = [
    deployment.ref,
    deployment.description ?? "",
    JSON.stringify(deployment.payload ?? null),
  ].join("\n");
  return [...new Set(haystack.match(MARKER) ?? [])];
}

/** THE deployment <-> promotion predicate (one place only). A deployment with any marker
 * matches only when every marker it carries is exactly this promotion's pages_build_version;
 * a marker-less one falls back to {environment, sha, created_at >= send_at - lookback}. */
export const matchesPromotion: MatchesPromotion = (deployment, promotion, lookbackS) => {
  const markers = deploymentMarkers(deployment);
  if (markers.length > 0) {
    return promotion.pages_build_version.length > 0 &&
      markers.every((m) => m === promotion.pages_build_version)
      ? "marker"
      : "mismatch";
  }
  return deployment.environment === PAGES_ENVIRONMENT &&
    deployment.sha === promotion.head_sha &&
    Date.parse(deployment.created_at) >= Date.parse(promotion.send_at) - lookbackS * 1000
    ? "fallback"
    : "mismatch";
};

const PAGE_SIZE = 100;
const MAX_PAGES = 50;
/** Safety valve only: the deployments listing normally ends at `since` or the last page. */
const MAX_DEPLOYMENT_PAGES = 1000;

/** An artifact id the POST body can carry as an exact JSON number: decimal, 1..2^53-1. */
export function isSafeArtifactId(id: string): boolean {
  return /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id));
}

/** True when an RFC 8288 `Link` header has a `rel="next"` link. */
function hasNextLink(headers: Headers): boolean {
  const link = headers.get("link");
  if (!link) return false;
  for (const m of link.matchAll(/<[^>]*>((?:\s*;\s*[^;,]+)*)/g)) {
    const rel = /;\s*rel\s*=\s*"?([^";,]*)"?/i.exec(m[1] ?? "");
    if (rel && (rel[1] ?? "").toLowerCase().split(/\s+/).includes("next")) return true;
  }
  return false;
}

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
    // send refuses such ids before effect_send; this only guards against a rounded POST body.
    if (!isSafeArtifactId(input.artifact_id)) {
      throw new PromotionError(3, `artifact id ${input.artifact_id} is not a safe integer`);
    }
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

  /** All deployments for the environment with created_at >= since. GitHub lists them newest
   * first, so the walk stops (complete) at the first page reaching back before `since`, or at a
   * page without a `rel="next"` Link. A page out of created_at descending order, an unparseable
   * created_at, an error, or MAX_DEPLOYMENT_PAGES pages = incomplete. */
  async listDeployments(opts: { environment: string; since: string }): Promise<
    Listing<Deployment>
  > {
    const since = Date.parse(opts.since);
    const items: Deployment[] = [];
    const incomplete = (pages: number, reason: string): Listing<Deployment> => ({
      complete: false,
      items,
      pages_fetched: pages,
      reason,
    });
    if (Number.isNaN(since)) return incomplete(0, `unparseable since ${opts.since}`);
    const env = encodeURIComponent(opts.environment);
    let previous = Number.POSITIVE_INFINITY;
    for (let page = 1; page <= MAX_DEPLOYMENT_PAGES; page++) {
      let r: Awaited<ReturnType<GitHubProvider["request"]>>;
      try {
        r = await this.request(
          "GET",
          `/deployments?environment=${env}&per_page=${PAGE_SIZE}&page=${page}`,
        );
      } catch (err) {
        return incomplete(page - 1, (err as Error).message);
      }
      if (r.status !== 200 || !Array.isArray(r.json)) {
        return incomplete(page - 1, `page ${page}: ${r.status}`);
      }
      for (const raw of r.json as Json[]) {
        const d = toDeployment(raw);
        const t = Date.parse(d.created_at);
        if (Number.isNaN(t)) return incomplete(page, `page ${page}: unparseable created_at`);
        if (t > previous)
          return incomplete(page, `page ${page}: not in created_at descending order`);
        previous = t;
        if (t >= since) items.push(d);
      }
      if (previous < since || !hasNextLink(r.headers)) {
        return { complete: true, items, pages_fetched: page };
      }
    }
    return incomplete(MAX_DEPLOYMENT_PAGES, "page limit reached");
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
