import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type App } from "../src/app.ts";
import { handleApiRequest } from "../src/api/router.ts";
import { cachedBoardTickets } from "../src/api/cached-reads.ts";
import { TtlCache } from "../src/core/ttl-cache.ts";
import type {
  PullRequest,
  PullRequestListing,
  PullRequestScope,
} from "../src/application/pull-requests.ts";
import type { AuthUser } from "../src/auth.ts";

/**
 * The response cache, over a real App and the real router.
 *
 * The first test in this file is the one that must never be deleted. Every other
 * assertion here is about cost — a hit saved a call, a TTL expired — and getting one
 * of those wrong makes the console slower or staler. Getting the *key* wrong serves
 * one developer the private merge requests of another, silently, and it is invisible
 * in every kind of testing that involves one logged-in user. So it gets a test with
 * two of them.
 *
 * `app.pullRequests` is replaced with a counting stub rather than a real forge: the
 * question is how many times the router reaches for the expensive read and with
 * whose identity, which is exactly what a stub can answer and a live GitLab cannot.
 */

let dir: string;
let app: App;
/** Every `list()` the router asked for, in order, with who asked. */
let calls: { userId: string; scope: PullRequestScope; repoFilter: readonly string[] }[];
/** Advanced by hand so a TTL can expire without a test sleeping through it. */
let clock: number;

const CONFIG = `
database: ./test.db
logLevel: fatal
`;

/** One merge request, named after the repository so a leak is legible in the diff. */
function pullRequestIn(repository: string): PullRequest {
  return {
    provider: "gitlab",
    id: `gitlab:${repository}!1`,
    number: 1,
    title: `Change in ${repository}`,
    state: "open",
    sourceBranch: "feature",
    targetBranch: "main",
    webUrl: `https://gitlab.example/${repository}/-/merge_requests/1`,
    repository,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "talos-api-cache-"));
  writeFileSync(join(dir, "talos.yaml"), CONFIG);
  app = await createApp({ config: join(dir, "talos.yaml") });
  app.logger = app.logger.child({}, { level: "fatal" });

  calls = [];
  clock = 1_000_000;
  // The same cache the app builds, with a clock this file owns.
  app.responseCache = new TtlCache({ now: () => clock });

  // Answers with whatever the caller's own repo filter names, which is what makes a
  // cross-user hit detectable: a listing that came back with somebody else's
  // repositories in it can only have come from somebody else's cache entry.
  app.pullRequests = {
    list: async (
      user: AuthUser,
      scope: PullRequestScope,
    ): Promise<PullRequestListing> => {
      const repoFilter = app.pullRequestRepoFilters.list(user.id);
      calls.push({ userId: user.id, scope, repoFilter });
      return {
        scope,
        states: ["open"],
        repositoryFilter: [...repoFilter],
        pullRequests: repoFilter.map(pullRequestIn),
        unavailable: [],
        failed: [],
      };
    },
  } as unknown as App["pullRequests"];
});

afterEach(() => {
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function createActiveUser(name: string, email: string) {
  const invitation = app.auth.createInvitedUser({ name, email, roleId: "qa" });
  const session = await app.auth.acceptInvitation(invitation.token, "correct-horse-42");
  if (!session) throw new Error(`Failed to accept invitation for '${email}'.`);
  return session;
}

test("keeps Mine and Team Jira board reads in separate cache entries", async () => {
  const registered = await createActiveUser("Jira Developer", "jira@example.com");
  const scopes: Array<"mine" | "team"> = [];
  app.assignedTickets = {
    list: async (
      _actor: Parameters<App["assignedTickets"]["list"]>[0],
      options: Parameters<App["assignedTickets"]["list"]>[1],
    ) => {
      scopes.push(options?.scope ?? "mine");
      return { tickets: [] };
    },
  } as unknown as App["assignedTickets"];

  await cachedBoardTickets(app, registered.user, "mine");
  await cachedBoardTickets(app, registered.user, "team");
  await cachedBoardTickets(app, registered.user, "mine");
  await cachedBoardTickets(app, registered.user, "team");

  expect(scopes).toEqual(["mine", "team"]);
});

/** A logged-in user with a Team MRs filter of their own. */
async function login(
  name: string,
  email: string,
  repositories: string[],
): Promise<{ cookie: string; id: string }> {
  const registered = await createActiveUser(name, email);
  app.pullRequestRepoFilters.set(registered.user.id, repositories);
  return { cookie: registered.cookie.split(";")[0]!, id: registered.user.id };
}

function request(
  path: string,
  cookie: string,
  init: { headers?: Record<string, string>; method?: string; body?: string } = {},
): Promise<Response | null> {
  return handleApiRequest(
    new Request(`http://localhost${path}`, {
      ...(init.method ? { method: init.method } : {}),
      ...(init.body ? { body: init.body } : {}),
      headers: { cookie, ...init.headers },
    }),
    app,
  );
}

async function listing(path: string, cookie: string, headers?: Record<string, string>) {
  const response = await request(path, cookie, headers ? { headers } : {});
  expect(response?.status).toBe(200);
  return (await response!.json()) as { pullRequests: { repository?: string }[] };
}

describe("the response cache", () => {
  test("never serves one user's merge requests to another", async () => {
    const alice = await login("Alice", "alice@example.com", ["acme/alice-only"]);
    const bob = await login("Bob", "bob@example.com", ["acme/bob-only"]);

    const first = await listing("/api/pull-requests?scope=team", alice.cookie);
    // Byte-identical request, inside the TTL, different session.
    const second = await listing("/api/pull-requests?scope=team", bob.cookie);

    expect(first.pullRequests.map((pr) => pr.repository)).toEqual(["acme/alice-only"]);
    expect(second.pullRequests.map((pr) => pr.repository)).toEqual(["acme/bob-only"]);
    // And the point: Bob's request was *not* a hit. Two entries, two forge reads.
    expect(calls).toEqual([
      { userId: alice.id, scope: "team", repoFilter: ["acme/alice-only"] },
      { userId: bob.id, scope: "team", repoFilter: ["acme/bob-only"] },
    ]);
  });

  test("serves a repeat request from the entry, and re-reads once it expires", async () => {
    const alice = await login("Alice", "alice@example.com", ["acme/web"]);

    await listing("/api/pull-requests?scope=team", alice.cookie);
    await listing("/api/pull-requests?scope=team", alice.cookie);
    expect(calls).toHaveLength(1);

    clock += 59_000;
    await listing("/api/pull-requests?scope=team", alice.cookie);
    expect(calls).toHaveLength(1);

    // Past `CACHE_TTL.pullRequests`.
    clock += 2_000;
    await listing("/api/pull-requests?scope=team", alice.cookie);
    expect(calls).toHaveLength(2);
  });

  test("distinguishes the scope and the state filter, which are in the key", async () => {
    const alice = await login("Alice", "alice@example.com", ["acme/web"]);

    await listing("/api/pull-requests?scope=team", alice.cookie);
    await listing("/api/pull-requests?scope=mine", alice.cookie);
    await listing("/api/pull-requests?scope=team&states=merged", alice.cookie);
    expect(calls.map((call) => call.scope)).toEqual(["team", "mine", "team"]);
    expect(calls).toHaveLength(3);
  });

  test("the refresh button's `no-store` reaches past the entry", async () => {
    const alice = await login("Alice", "alice@example.com", ["acme/web"]);

    await listing("/api/pull-requests?scope=team", alice.cookie);
    expect(calls).toHaveLength(1);

    await listing("/api/pull-requests?scope=team", alice.cookie, {
      "cache-control": "no-store",
    });
    expect(calls).toHaveLength(2);

    // And it repopulated rather than merely bypassing: the next plain read is a hit.
    await listing("/api/pull-requests?scope=team", alice.cookie);
    expect(calls).toHaveLength(2);
  });

  test("changing the Team MRs filter drops the entry it was keyed on", async () => {
    const alice = await login("Alice", "alice@example.com", ["acme/web"]);

    const before = await listing("/api/pull-requests?scope=team", alice.cookie);
    expect(before.pullRequests.map((pr) => pr.repository)).toEqual(["acme/web"]);

    const saved = await request("/api/me/pull-request-repos", alice.cookie, {
      method: "PUT",
      body: JSON.stringify({ repositories: ["acme/api"] }),
    });
    expect(saved?.status).toBe(200);

    const after = await listing("/api/pull-requests?scope=team", alice.cookie);
    expect(after.pullRequests.map((pr) => pr.repository)).toEqual(["acme/api"]);
    expect(calls).toHaveLength(2);
  });

  test("saving integration credentials clears every forge-derived entry", async () => {
    const alice = await login("Alice", "alice@example.com", ["acme/web"]);
    await app.auth.updateUser(alice.id, {
      name: "Alice",
      email: "alice@example.com",
      roleId: "admin",
    });
    await listing("/api/pull-requests?scope=team", alice.cookie);
    expect(calls).toHaveLength(1);

    // Whatever was cached was fetched with the token that just changed, so it is
    // now attributable to the wrong credentials — see `routeIntegrations`.
    const saved = await request("/api/settings/integrations", alice.cookie, {
      method: "PUT",
      body: JSON.stringify({ overrides: { GITLAB_API_URL: "https://gitlab.example/api/v4" } }),
    });
    expect(saved?.status).toBe(200);

    await listing("/api/pull-requests?scope=team", alice.cookie);
    expect(calls).toHaveLength(2);
  });
});

describe("ETag revalidation", () => {
  test("answers a matching If-None-Match with 304 and no body", async () => {
    const alice = await login("Alice", "alice@example.com", ["acme/web"]);

    const first = await request("/api/pull-requests?scope=team", alice.cookie);
    expect(first?.status).toBe(200);
    const etag = first!.headers.get("etag");
    expect(etag).toMatch(/^W\/"/);

    const second = await request("/api/pull-requests?scope=team", alice.cookie, {
      headers: { "if-none-match": etag! },
    });
    expect(second?.status).toBe(304);
    expect(await second!.text()).toBe("");
  });

  test("is private and varies on the cookie — never `public` or `s-maxage`", async () => {
    const alice = await login("Alice", "alice@example.com", ["acme/web"]);

    const response = await request("/api/pull-requests?scope=team", alice.cookie);
    const cacheControl = response!.headers.get("cache-control") ?? "";
    expect(cacheControl).toBe("private, no-cache");
    expect(cacheControl).not.toContain("public");
    expect(cacheControl).not.toContain("s-maxage");
    expect(response!.headers.get("vary")).toBe("Cookie");
  });
});
