// Tests of the plugin's call command, asked as skel asks it, against a fake GitHub and a fake
// skel's service.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Asked, json, removeSettings, run, signedIn, startFake } from "./fake.ts";

const fake = startFake();
afterAll(() => fake.stop());
let dir = "";

beforeEach(() => {
  dir = signedIn();
  fake.asked = [];
  fake.route = world;
});
afterEach(() => removeSettings(dir));

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

// A GitHub where simon can push to simon/app, which has skel's app installed, and simon/other
// has it not installed.
function world(asked: Asked): Response | undefined {
  const { method, path, auth } = asked;
  if (method === "POST" && path === "/service/github/token") {
    if (auth !== "Bearer user-token")
      return json({ error: "GitHub doesn't accept your sign-in" }, 401);
    const { repository } = JSON.parse(asked.body);
    if (repository === "simon/app") return json({ token: "ghs_app", expires: inAnHour() });
    return json(
      {
        error: `skel's GitHub App isn't installed on ${repository}: install it at https://github.com/apps/skelcrew/installations/new`,
      },
      404,
    );
  }
  if (path === "/api/repos/simon/app" && auth === "Bearer user-token")
    return json({
      full_name: "simon/app",
      name: "app",
      html_url: "https://github.com/simon/app",
      clone_url: "https://github.com/simon/app.git",
      fork: false,
      permissions: { push: true },
    });
  if (method === "GET" && path === "/service/github")
    return json({
      install: "https://github.com/apps/skelcrew/installations/new",
      client_id: "Iv1.app",
    });
  if (path === "/api/users/skelcrew%5Bbot%5D") return json({ login: "skelcrew[bot]", id: 41 });
  if (path === "/api/repos/simon/other" && auth === "Bearer user-token")
    return json({ full_name: "simon/other", name: "other", permissions: { push: true } });
  return undefined;
}

// Asks the plugin one question, as skel does, and returns its answer, or throws its error.
async function ask(question: object): Promise<unknown> {
  const { code, out, err } = await run(fake.url, dir, ["call.ts"], JSON.stringify(question));
  if (code !== 0) throw new Error(err.trim().split("\n").at(-1));
  return JSON.parse(out);
}

const sent = (path: string) =>
  fake.asked.filter((a) => a.path === path).map((a) => JSON.parse(a.body || "null"));

// Commits are authored by the app's bot, as GitHub names it, so they show as the app's.
test("claims answers for a remote on GitHub, in any form git writes one, or its full name", async () => {
  const claimed = {
    key: "simon/app",
    name: "app",
    link: "https://github.com/simon/app",
    clone: "https://github.com/simon/app.git",
    push: true,
    fork: false,
    author: { name: "skelcrew[bot]", email: "41+skelcrew[bot]@users.noreply.github.com" },
  };
  for (const remote of [
    "git@github.com:simon/app.git",
    "https://github.com/simon/app",
    "ssh://git@github.com/simon/app.git",
    "simon/app",
  ])
    expect(await ask({ ask: "claims", remote })).toEqual(claimed);
});

test("claims answers null for a remote somewhere else, without asking anyone", async () => {
  expect(await ask({ ask: "claims", remote: "git@gitlab.com:simon/app.git" })).toBeNull();
  expect(fake.asked).toEqual([]);
});

// Exit code 2 has Skelcrew run the setup, which installs the app, from your terminal.
test("claims exits 2 where the app isn't installed, saying so", async () => {
  const question = JSON.stringify({ ask: "claims", remote: "git@github.com:simon/other.git" });
  const { code, out, err } = await run(fake.url, dir, ["call.ts"], question);
  expect(code).toBe(2);
  expect(out).toBe("");
  expect(err).toBe("Skelcrew's GitHub App isn't installed on simon/other\n");
});

test("a repository's token is asked for once and used until it nearly runs out", async () => {
  fake.route = (asked) =>
    asked.path === "/api/repos/simon/app/issues/12/reactions" ? json({}, 201) : world(asked);
  await ask({ ask: "took", repository: "simon/app", task: "12" });
  await ask({ ask: "took", repository: "simon/app", task: "12" });
  expect(sent("/service/github/token")).toEqual([{ repository: "simon/app" }]);
  const reactions = fake.asked.filter((a) => a.path.endsWith("/reactions"));
  expect(reactions.map((a) => a.auth)).toEqual(["Bearer ghs_app", "Bearer ghs_app"]);
  expect(JSON.parse(reactions[0]?.body ?? "")).toEqual({ content: "eyes" });
});

// GitHub answers 201 for a reaction it adds and 200 for one the app had there already, as when
// Skelcrew on another machine, posting as the same bot, claimed the issue first.
test("took answers whether this call added the app's eyes to the issue", async () => {
  let reacted = false;
  fake.route = (asked) => {
    if (asked.path !== "/api/repos/simon/app/issues/12/reactions") return world(asked);
    const status = reacted ? 200 : 201;
    reacted = true;
    return json({ content: "eyes" }, status);
  };
  expect(await ask({ ask: "took", repository: "simon/app", task: "12" })).toEqual({ took: true });
  expect(await ask({ ask: "took", repository: "simon/app", task: "12" })).toEqual({
    took: false,
  });
  expect(sent("/api/repos/simon/app/issues/12/reactions")).toEqual([
    { content: "eyes" },
    { content: "eyes" },
  ]);
});

// A GitHub where issue 12 has the assignees in `assignees`, which POST and DELETE on its
// assignees change, as GitHub does. `assignable` says whom GitHub lets be assigned: it leaves
// out anyone else without an error.
function assigning(assignees: string[], assignable = ["simon", "ana"]) {
  return (asked: Asked): Response | undefined => {
    if (asked.path === "/api/repos/simon/app/issues/12") {
      if (asked.method !== "GET") return undefined;
      return json({ number: 12, assignees: assignees.map((login) => ({ login })) });
    }
    if (asked.path !== "/api/repos/simon/app/issues/12/assignees") return world(asked);
    const given: string[] = JSON.parse(asked.body).assignees;
    if (asked.method === "POST")
      for (const login of given)
        if (assignable.includes(login) && !assignees.includes(login)) assignees.push(login);
    if (asked.method === "DELETE") {
      const kept = assignees.filter((login) => !given.includes(login));
      assignees.splice(0, assignees.length, ...kept);
    }
    return json({ number: 12, assignees: assignees.map((login) => ({ login })) }, 201);
  };
}

test("assign on adds you to the issue as the app, and says whether this call did", async () => {
  const assignees = ["ana"];
  fake.route = assigning(assignees);
  expect(await ask({ ask: "assign", repository: "simon/app", task: "12", on: true })).toEqual({
    assigned: true,
  });
  expect(assignees).toEqual(["ana", "simon"]);
  expect(await ask({ ask: "assign", repository: "simon/app", task: "12", on: true })).toEqual({
    assigned: false,
  });
  expect(sent("/api/repos/simon/app/issues/12/assignees")).toEqual([{ assignees: ["simon"] }]);
  const writes = fake.asked.filter((a) => a.path.endsWith("/assignees"));
  expect(writes.map((a) => a.auth)).toEqual(["Bearer ghs_app"]);
});

test("assign off takes only you off the issue, as the app", async () => {
  const assignees = ["ana", "simon"];
  fake.route = assigning(assignees);
  expect(await ask({ ask: "assign", repository: "simon/app", task: "12", on: false })).toBeNull();
  expect(assignees).toEqual(["ana"]);
  const removed = fake.asked.find((a) => a.path.endsWith("/assignees"));
  expect(removed?.method).toBe("DELETE");
  expect(removed?.auth).toBe("Bearer ghs_app");
  expect(JSON.parse(removed?.body ?? "")).toEqual({ assignees: ["simon"] });
});

// GitHub answers success when it won't assign someone, such as a person who can't reach the
// repository, and only its list of assignees shows it.
test("assign on fails when GitHub leaves you off the issue", async () => {
  fake.route = assigning([], ["ana"]);
  await expect(
    ask({ ask: "assign", repository: "simon/app", task: "12", on: true }),
  ).rejects.toThrow("GitHub didn't assign simon to #12");
});

test("assign refuses an issue or an on it can't send to GitHub", async () => {
  await expect(
    ask({ ask: "assign", repository: "simon/app", task: "../1", on: true }),
  ).rejects.toThrow("isn't an issue's number");
  await expect(
    ask({ ask: "assign", repository: "simon/app", task: "12", on: "yes" }),
  ).rejects.toThrow("whether to assign you isn't what the GitHub plugin expects");
  expect(fake.asked.filter((a) => a.path.startsWith("/api/"))).toEqual([]);
});

test("seen reacts with eyes to a PR comment as the app", async () => {
  fake.route = (asked) =>
    asked.path === "/api/repos/simon/app/issues/comments/77/reactions"
      ? json({}, 201)
      : world(asked);
  expect(
    await ask({ ask: "seen", repository: "simon/app", pr: 26, kind: "comment", id: "77" }),
  ).toBeNull();
  const reaction = fake.asked.find((a) => a.path.endsWith("/reactions"));
  expect(reaction?.method).toBe("POST");
  expect(reaction?.auth).toBe("Bearer ghs_app");
  expect(JSON.parse(reaction?.body ?? "")).toEqual({ content: "eyes" });
});

// GitHub's REST API has no reactions on a review, so its GraphQL API reacts, by the review's
// node ID.
test("seen reacts with eyes to a review as the app, through GraphQL", async () => {
  fake.route = (asked) => {
    if (asked.path === "/api/repos/simon/app/pulls/26/reviews/601")
      return json({ id: 601, node_id: "PRR_kwDOabc123" });
    if (asked.path === "/api/graphql")
      return json({ data: { addReaction: { reaction: { content: "EYES" } } } });
    return world(asked);
  };
  expect(
    await ask({ ask: "seen", repository: "simon/app", pr: 26, kind: "review", id: "601" }),
  ).toBeNull();
  const graphql = fake.asked.find((a) => a.path === "/api/graphql");
  expect(graphql?.auth).toBe("Bearer ghs_app");
  const { query } = JSON.parse(graphql?.body ?? "");
  expect(query).toContain('addReaction(input: { subjectId: "PRR_kwDOabc123", content: EYES })');
});

test("seen refuses an ID or kind it can't send to GitHub", async () => {
  await expect(
    ask({ ask: "seen", repository: "simon/app", pr: 26, kind: "comment", id: "../1" }),
  ).rejects.toThrow("isn't a comment's ID");
  await expect(
    ask({ ask: "seen", repository: "simon/app", pr: 26, kind: "issue", id: "1" }),
  ).rejects.toThrow("issue isn't a comment or a review");
  expect(fake.asked.filter((a) => a.path.startsWith("/api/"))).toEqual([]);
});

test("a sign-in about to run out is renewed through the service once, by calls at once", async () => {
  removeSettings(dir);
  dir = signedIn({ access: "old-token", accessExpires: Date.now() + 60_000 });
  let renewals = 0;
  fake.route = (asked) => {
    if (asked.path === "/service/github/renew") {
      renewals++;
      // A refresh token works once.
      if (JSON.parse(asked.body).refresh_token !== "refresh-1")
        return json({ error: "GitHub refused the sign-in" }, 401);
      return json({
        access_token: "user-token",
        expires_in: 28800,
        refresh_token: "refresh-2",
        refresh_token_expires_in: 15724800,
      });
    }
    if (asked.path.endsWith("/reactions")) return json({}, 201);
    return world(asked);
  };
  await Promise.all(
    [1, 2, 3].map((n) => ask({ ask: "took", repository: "simon/app", task: String(n) })),
  );
  expect(renewals).toBe(1);
  const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(saved.access).toBe("user-token");
  expect(saved.refresh).toBe("refresh-2");
});

// A GraphQL answer for simon/app: issue 12 labeled skelcrew, PR 26 from a thread, with checks,
// a review from skel's app and a comment from someone else, and PR 30 nobody watches.
const issue12 = {
  number: 12,
  title: "Fix the login",
  body: "It redirects wrong.",
  url: "https://github.com/simon/app/issues/12",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-09T10:00:00Z",
  author: { __typename: "User", login: "simon" },
  labels: { nodes: [{ name: "skelcrew" }] },
  state: "OPEN",
};
const pull = (n: number, updatedAt: string) => ({
  number: n,
  title: `PR ${n}`,
  body: "Closes #12",
  url: `https://github.com/simon/app/pull/${n}`,
  createdAt: "2026-11-02T10:00:00Z",
  updatedAt,
  author: { __typename: "Bot", login: "skelcrew" },
  labels: { nodes: [] },
  state: "OPEN",
  mergeable: "CONFLICTING",
  baseRefName: "main",
  headRefName: `skel/12-fix-login`,
  headRefOid: "a".repeat(40),
  reviews: {
    nodes: [
      {
        databaseId: 501,
        state: "COMMENTED",
        body: "**Approved.**",
        author: { __typename: "Bot", login: "skelcrew" },
        comments: { nodes: [] },
      },
      {
        databaseId: 502,
        state: "CHANGES_REQUESTED",
        body: "Rename it",
        author: { __typename: "User", login: "ana" },
        comments: { nodes: [{ path: "src/a.ts", line: 3, body: "here" }] },
      },
      {
        databaseId: 503,
        state: "PENDING",
        body: "",
        author: { __typename: "User", login: "ana" },
        comments: { nodes: [] },
      },
    ],
  },
  comments: {
    nodes: [{ databaseId: 601, body: "lgtm", author: { __typename: "User", login: "bob" } }],
  },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: "CheckRun",
                  databaseId: 9,
                  name: "test",
                  status: "COMPLETED",
                  conclusion: "FAILURE",
                },
                {
                  __typename: "CheckRun",
                  databaseId: 10,
                  name: "lint",
                  status: "IN_PROGRESS",
                  conclusion: null,
                },
                {
                  __typename: "CheckRun",
                  databaseId: 11,
                  name: "old",
                  status: "COMPLETED",
                  conclusion: "CANCELLED",
                },
                { __typename: "StatusContext", context: "skelcrew/check", state: "SUCCESS" },
              ],
            },
          },
        },
      },
    ],
  },
});
const page = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });

// A GitHub that answers GraphQL with simon/app's issues and PRs, as asked, and says ana can
// push and bob can't.
function withRepository(asked: Asked): Response | undefined {
  if (asked.path === "/api/graphql") {
    const { query } = JSON.parse(asked.body);
    const repository: Record<string, unknown> = {};
    if (query.includes("issues(")) repository.issues = page([issue12]);
    if (query.includes("pullRequests("))
      repository.pullRequests = page([
        pull(30, "2026-11-09T11:00:00Z"),
        pull(26, "2026-11-08T10:00:00Z"),
      ]);
    if (query.includes("pr26:")) repository.pr26 = pull(26, "2026-11-08T10:00:00Z");
    if (query.includes("pr99:")) repository.pr99 = null;
    return json({ data: { repository } });
  }
  if (asked.path === "/api/repos/simon/app/labels") return json({ message: "exists" }, 422);
  if (asked.path === "/api/repos/simon/app/collaborators/ana/permission")
    return json({ permission: "write" });
  if (asked.path === "/api/repos/simon/app/collaborators/bob/permission")
    return json({ permission: "read" });
  return world(asked);
}

test("changed with no next brings everything open, and the PRs skel watches, in one query", async () => {
  fake.route = withRepository;
  const answer = await ask({
    ask: "changed",
    repository: "simon/app",
    jobs: ["tracker", "forge"],
    next: null,
    prs: [26, 99],
  });
  const graphql = fake.asked.filter((a) => a.path === "/api/graphql");
  expect(graphql.length).toBe(1);
  const { query } = JSON.parse(graphql[0]?.body ?? "");
  expect(query).toContain("states: [OPEN]");
  // The label is made when the plugin is first asked, as the tracker.
  expect(sent("/api/repos/simon/app/labels")).toEqual([
    { name: "skelcrew", color: "5319e7", description: "Skelcrew starts a thread on this issue" },
  ]);
  expect(answer).toMatchObject({ next: "2026-11-09T11:00:00Z" });
  const { items } = answer as { items: ({ kind: string; id: string } & Record<string, unknown>)[] };
  expect(items.map((item) => `${item.kind} ${item.id}`)).toEqual(["task 12", "pr 30", "pr 26"]);
  expect(items[0]).toEqual({
    kind: "task",
    id: "12",
    title: "Fix the login",
    body: "It redirects wrong.",
    state: "open",
    author: { login: "simon", bot: false, you: true, push: null },
    labels: ["skelcrew"],
    link: "https://github.com/simon/app/issues/12",
    created: "2026-11-01T10:00:00Z",
    updated: "2026-11-09T10:00:00Z",
    closes: "Closes #12",
  });
  expect(items[2]).toEqual({
    kind: "pr",
    id: "26",
    title: "PR 26",
    body: "Closes #12",
    state: "open",
    author: { login: "skelcrew", bot: true, you: false, push: null },
    labels: [],
    link: "https://github.com/simon/app/pull/26",
    created: "2026-11-02T10:00:00Z",
    updated: "2026-11-08T10:00:00Z",
    branch: "skel/12-fix-login",
    head: "a".repeat(40),
    base: "main",
    conflicts: true,
    checks: [
      { name: "test", id: "9", state: "failed" },
      { name: "lint", id: "10", state: "running" },
      { name: "old", id: "11", state: "cancelled" },
      { name: "skelcrew/check", id: null, state: "passed" },
    ],
    reviews: [
      {
        id: "501",
        text: "**Approved.**",
        author: { login: "skelcrew", bot: true, you: false, push: false },
        verdict: "commented",
        lines: [],
      },
      {
        id: "502",
        text: "Rename it",
        author: { login: "ana", bot: false, you: false, push: true },
        verdict: "changes requested",
        lines: [{ path: "src/a.ts", line: 3, text: "here" }],
      },
    ],
    comments: [
      { id: "601", text: "lgtm", author: { login: "bob", bot: false, you: false, push: false } },
    ],
  });
});

test("whether someone can push is asked once, and kept for the next poll", async () => {
  fake.route = withRepository;
  const question = {
    ask: "changed",
    repository: "simon/app",
    jobs: ["forge"],
    next: null,
    prs: [26],
  };
  await ask(question);
  await ask(question);
  expect(fake.asked.filter((a) => a.path.includes("/collaborators/")).length).toBe(2);
});

test("changed with next asks only for what changed since, closed ones too", async () => {
  fake.route = withRepository;
  const answer = await ask({
    ask: "changed",
    repository: "simon/app",
    jobs: ["tracker", "forge"],
    next: "2026-11-09T09:00:00Z",
    prs: [],
  });
  const { query } = JSON.parse(fake.asked.find((a) => a.path === "/api/graphql")?.body ?? "");
  expect(query).toContain('filterBy: { since: "2026-11-09T09:00:00Z" }');
  expect(query).not.toContain("states: [OPEN]");
  expect(sent("/api/repos/simon/app/labels")).toEqual([]);
  expect(answer).toMatchObject({ next: "2026-11-09T11:00:00Z" });
});

test("without repositories.json, changed's query has no assignee", async () => {
  fake.route = withRepository;
  for (const next of [null, "2026-11-09T09:00:00Z"]) {
    fake.asked = [];
    await ask({ ask: "changed", repository: "simon/app", jobs: ["tracker"], next, prs: [] });
    const { query } = JSON.parse(fake.asked.find((a) => a.path === "/api/graphql")?.body ?? "");
    expect(query).not.toContain("assignee");
  }
});

test("a repository set to assigned has GitHub pass on only issues assigned to you", async () => {
  writeFileSync(
    join(dir, "repositories.json"),
    JSON.stringify({ "simon/app": { assigned: true }, "simon/other": { assigned: false } }),
  );
  fake.route = withRepository;
  await ask({
    ask: "changed",
    repository: "simon/app",
    jobs: ["tracker", "forge"],
    next: null,
    prs: [],
  });
  let [graphql] = fake.asked.filter((a) => a.path === "/api/graphql");
  let { query } = JSON.parse(graphql?.body ?? "");
  expect(query).toContain('filterBy: { assignee: "simon" }');
  expect(query).toContain("states: [OPEN]");
  // PRs aren't filtered.
  expect(query).toMatch(/pullRequests\(first: 50, states: \[OPEN\], orderBy/);
  fake.asked = [];
  await ask({
    ask: "changed",
    repository: "simon/app",
    jobs: ["tracker"],
    next: "2026-11-09T09:00:00Z",
    prs: [],
  });
  [graphql] = fake.asked.filter((a) => a.path === "/api/graphql");
  ({ query } = JSON.parse(graphql?.body ?? ""));
  // Closed ones updated since still come, if they are assigned to you.
  expect(query).toContain('filterBy: { assignee: "simon", since: "2026-11-09T09:00:00Z" }');
  expect(query).not.toContain("states: [OPEN]");
  expect(fake.asked.filter((a) => a.path === "/api/graphql").length).toBe(1);
});

test("a repositories.json that isn't JSON fails plainly", async () => {
  writeFileSync(join(dir, "repositories.json"), "{ simon/app");
  fake.route = withRepository;
  await expect(
    ask({ ask: "changed", repository: "simon/app", jobs: ["tracker"], next: null, prs: [] }),
  ).rejects.toThrow("repositories.json isn't JSON");
});

test("as the forge alone, changed leaves issues out and makes no label", async () => {
  fake.route = withRepository;
  const answer = await ask({
    ask: "changed",
    repository: "simon/app",
    jobs: ["forge"],
    next: null,
    prs: [],
  });
  const { query } = JSON.parse(fake.asked.find((a) => a.path === "/api/graphql")?.body ?? "");
  expect(query).not.toContain("issues(");
  expect((answer as { items: { kind: string }[] }).items.map((i) => i.kind)).toEqual(["pr", "pr"]);
  expect(sent("/api/repos/simon/app/labels")).toEqual([]);
});

test("a list longer than a page is read to its end", async () => {
  let pages = 0;
  fake.route = (asked) => {
    if (asked.path !== "/api/graphql") return world(asked);
    const { query } = JSON.parse(asked.body);
    pages++;
    const first = !query.includes("after:");
    const node = { ...issue12, number: first ? 1 : 2 };
    return json({
      data: {
        repository: {
          issues: { pageInfo: { hasNextPage: first, endCursor: "c1" }, nodes: [node] },
        },
      },
    });
  };
  fake.asked = [];
  const answer = await ask({
    ask: "changed",
    repository: "simon/app",
    jobs: ["tracker"],
    next: "2026-11-01T00:00:00Z",
    prs: [],
  });
  expect(pages).toBe(2);
  expect((answer as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(["1", "2"]);
});

test("create task opens an issue and answers it as a task", async () => {
  fake.route = (asked) =>
    asked.path === "/api/repos/simon/app/issues" && asked.method === "POST"
      ? json(
          {
            number: 13,
            title: "Add a logout",
            body: "Somewhere.",
            state: "open",
            user: { login: "skelcrew[bot]", type: "Bot" },
            labels: [],
            html_url: "https://github.com/simon/app/issues/13",
            created_at: "2026-11-09T12:00:00Z",
            updated_at: "2026-11-09T12:00:00Z",
          },
          201,
        )
      : world(asked);
  const task = await ask({
    ask: "create task",
    repository: "simon/app",
    title: "Add a logout",
    body: "Somewhere.",
  });
  expect(sent("/api/repos/simon/app/issues")).toEqual([
    { title: "Add a logout", body: "Somewhere." },
  ]);
  expect(task).toEqual({
    kind: "task",
    id: "13",
    title: "Add a logout",
    body: "Somewhere.",
    state: "open",
    author: { login: "skelcrew[bot]", bot: true, you: false, push: null },
    labels: [],
    link: "https://github.com/simon/app/issues/13",
    created: "2026-11-09T12:00:00Z",
    updated: "2026-11-09T12:00:00Z",
    closes: "Closes #13",
  });
});

test("open pr answers the PR already open from the branch, or opens one", async () => {
  let open: unknown[] = [];
  fake.route = (asked) => {
    if (asked.path.startsWith("/api/repos/simon/app/pulls?")) return json(open);
    if (asked.path === "/api/repos/simon/app/pulls") return json({ number: 26 }, 201);
    return world(asked);
  };
  const question = {
    ask: "open pr",
    repository: "simon/app",
    branch: "skel/12-fix-login",
    base: "main",
    title: "Fix the login",
    body: "Closes #12",
  };
  expect(await ask(question)).toEqual({ number: 26 });
  expect(
    fake.asked.some(
      (a) => a.path === "/api/repos/simon/app/pulls?state=open&head=simon%3Askel%2F12-fix-login",
    ),
  ).toBe(true);
  expect(sent("/api/repos/simon/app/pulls")).toEqual([
    { head: "skel/12-fix-login", base: "main", title: "Fix the login", body: "Closes #12" },
  ]);
  open = [{ number: 25 }];
  fake.asked = [];
  expect(await ask(question)).toEqual({ number: 25 });
  expect(sent("/api/repos/simon/app/pulls")).toEqual([]);
});

// The body goes to GitHub as it is, Skelcrew's own lines and all. A PR closed or merged, which
// GitHub would let the app edit, is left be and answers false, as does one GitHub won't let the
// app edit. Any other failure fails, a rate limit or an edit sent too quickly too.
test("edit pr replaces an open PR's description, or answers false where it can't be edited", async () => {
  let pr: object = { number: 26, state: "open", merged: false };
  let reading: Response | null = null;
  let editing: Response | null = null;
  fake.route = (asked) => {
    if (asked.path !== "/api/repos/simon/app/pulls/26") return world(asked);
    if (asked.method === "GET") return reading ?? json(pr);
    if (asked.method === "PATCH")
      return editing ?? json({ number: 26, body: JSON.parse(asked.body).body });
    return undefined;
  };
  const question = {
    ask: "edit pr",
    repository: "simon/app",
    pr: 26,
    body: "Fix the login, round two.\n\nCloses #12",
  };
  const edits = () => fake.asked.filter((a) => a.method === "PATCH");
  expect(await ask(question)).toEqual({ edited: true });
  const github = fake.asked.filter((a) => a.path.startsWith("/api/repos/simon/app/"));
  expect(github.map((a) => `${a.method} ${a.path} ${a.auth}`)).toEqual([
    "GET /api/repos/simon/app/pulls/26 Bearer ghs_app",
    "PATCH /api/repos/simon/app/pulls/26 Bearer ghs_app",
  ]);
  expect(edits().map((a) => JSON.parse(a.body))).toEqual([
    { body: "Fix the login, round two.\n\nCloses #12" },
  ]);

  // Closed and merged PRs are never edited.
  for (const state of [
    { number: 26, state: "closed", merged: false },
    { number: 26, state: "closed", merged: true },
  ]) {
    pr = state;
    fake.asked = [];
    expect(await ask(question)).toEqual({ edited: false });
    expect(edits()).toEqual([]);
  }
  pr = { number: 26, state: "open", merged: false };

  // A PR missing, or the app lacking the permission, whether in reading or in editing.
  const refusals: [number, string][] = [
    [404, "Not Found"],
    [403, "Resource not accessible by integration"],
  ];
  for (const [status, message] of refusals) {
    reading = json({ message }, status);
    expect(await ask(question)).toEqual({ edited: false });
  }
  reading = null;
  for (const [status, message] of [...refusals, [422, "Validation Failed"] as [number, string]]) {
    editing = json({ message }, status);
    expect(await ask(question)).toEqual({ edited: false });
  }

  // A rate limit or an edit sent too quickly passes on its own, so it fails instead.
  reading = json({ message: "API rate limit exceeded for installation ID 1." }, 403);
  await expect(ask(question)).rejects.toThrow("couldn't read #26: GitHub said API rate limit");
  reading = null;
  editing = json({ message: "You have exceeded a secondary rate limit. Please wait." }, 403);
  await expect(ask(question)).rejects.toThrow("couldn't edit #26: GitHub said You have exceeded");
  editing = json(
    {
      message: "Validation Failed",
      errors: [{ resource: "PullRequest", code: "custom", message: "was submitted too quickly" }],
    },
    422,
  );
  await expect(ask(question)).rejects.toThrow("couldn't edit #26: GitHub said Validation Failed");
  editing = json({ message: "Server Error" }, 500);
  await expect(ask(question)).rejects.toThrow("couldn't edit #26: GitHub said Server Error");
  await expect(ask({ ...question, pr: "26/merge" })).rejects.toThrow("isn't a PR's number");
});

// A branch GitHub already deleted, such as with "delete branch on merge" or by hand, answers
// 422, and the question still succeeds, as the branch is gone either way. GitHub answers 422
// too when it refuses to delete one, such as a protected branch, which must fail.
test("close pr comments, closes the PR and deletes its branch, and with no comment only closes", async () => {
  let gone = false;
  let refused = false;
  fake.route = (asked) => {
    const { method, path } = asked;
    if (method === "POST" && path === "/api/repos/simon/app/issues/26/comments")
      return json({ id: 5 }, 201);
    if (method === "PATCH" && path === "/api/repos/simon/app/pulls/26")
      return json({ number: 26, state: "closed" });
    if (method === "DELETE" && path === "/api/repos/simon/app/git/refs/heads/skelcrew/12-fix-login")
      return refused
        ? json({ message: "Cannot delete this protected branch" }, 422)
        : gone
          ? json({ message: "Reference does not exist" }, 422)
          : new Response(null, { status: 204 });
    if (method === "GET" && path === "/api/repos/simon/app/git/ref/heads/skelcrew/12-fix-login")
      return gone ? json({ message: "Not Found" }, 404) : json({ ref: "refs/heads/x" });
    return world(asked);
  };
  const question = {
    ask: "close pr",
    repository: "simon/app",
    pr: 26,
    branch: "skelcrew/12-fix-login",
    comment: "Closed by Skelcrew: started over as app-14",
  };
  expect(await ask(question)).toBeNull();
  const github = fake.asked.filter((a) => a.path.startsWith("/api/repos/simon/app/"));
  expect(github.map((a) => `${a.method} ${a.path}`)).toEqual([
    "POST /api/repos/simon/app/issues/26/comments",
    "PATCH /api/repos/simon/app/pulls/26",
    "DELETE /api/repos/simon/app/git/refs/heads/skelcrew/12-fix-login",
  ]);
  expect(sent("/api/repos/simon/app/issues/26/comments")).toEqual([
    { body: "Closed by Skelcrew: started over as app-14" },
  ]);
  expect(sent("/api/repos/simon/app/pulls/26")).toEqual([{ state: "closed" }]);

  gone = true;
  fake.asked = [];
  expect(await ask({ ...question, comment: null })).toBeNull();
  expect(sent("/api/repos/simon/app/issues/26/comments")).toEqual([]);
  expect(sent("/api/repos/simon/app/pulls/26")).toEqual([{ state: "closed" }]);

  gone = false;
  refused = true;
  await expect(ask(question)).rejects.toThrow("Cannot delete this protected branch");

  await expect(ask({ ...question, branch: "../../hooks" })).rejects.toThrow("isn't a branch");
});

// A GitHub where simon/app allows the ways to merge in `allowed`, and PR 31's head is `head`.
// A merge at another commit is refused, as GitHub refuses one whose head moved, and so is a
// way the repository doesn't allow.
function merging(allowed: string[], head: string, refusal?: [number, string]) {
  return (asked: Asked): Response | undefined => {
    if (asked.path === "/api/graphql")
      return json({
        data: {
          repository: {
            mergeCommitAllowed: allowed.includes("merge"),
            squashMergeAllowed: allowed.includes("squash"),
            rebaseMergeAllowed: allowed.includes("rebase"),
          },
        },
      });
    if (asked.method !== "PUT" || asked.path !== "/api/repos/simon/app/pulls/31/merge")
      return world(asked);
    const { sha, merge_method } = JSON.parse(asked.body);
    if (refusal) return json({ message: refusal[1] }, refusal[0]);
    if (sha !== head)
      return json({ message: "Head branch was modified. Review and try the merge again." }, 409);
    if (!allowed.includes(merge_method))
      return json({ message: "Merge commits are not allowed on this repository." }, 405);
    return json({ sha: "f".repeat(40), merged: true, message: "Pull Request successfully merged" });
  };
}

const seenApproved = "c".repeat(40);
const mergeQuestion = { ask: "merge pr", repository: "simon/app", pr: 31, commit: seenApproved };
const mergesSent = () => sent("/api/repos/simon/app/pulls/31/merge");

test("merge pr merges the PR at the commit you saw approved, with a merge commit where allowed", async () => {
  fake.route = merging(["merge", "squash", "rebase"], seenApproved);
  expect(await ask(mergeQuestion)).toBeNull();
  expect(mergesSent()).toEqual([{ sha: seenApproved, merge_method: "merge" }]);
  const graphql = fake.asked.find((a) => a.path === "/api/graphql");
  expect(graphql?.auth).toBe("Bearer ghs_app");
  expect(JSON.parse(graphql?.body ?? "").query).toContain(
    'repository(owner: "simon", name: "app")',
  );
});

test("merge pr squashes where merge commits aren't allowed, and rebases where only that is", async () => {
  fake.route = merging(["squash", "rebase"], seenApproved);
  expect(await ask(mergeQuestion)).toBeNull();
  fake.route = merging(["rebase"], seenApproved);
  expect(await ask(mergeQuestion)).toBeNull();
  expect(mergesSent().map((body) => body.merge_method)).toEqual(["squash", "rebase"]);
});

// What GitHub refuses is your call to make, so its reason goes back to the screen as it is.
test("merge pr answers why GitHub wouldn't merge: a head that moved, a conflict or a rule", async () => {
  fake.route = merging(["merge"], "d".repeat(40));
  expect(await ask(mergeQuestion)).toEqual({
    refused: "Head branch was modified. Review and try the merge again.",
  });
  fake.route = merging(["merge"], seenApproved, [405, "Pull Request is not mergeable"]);
  expect(await ask(mergeQuestion)).toEqual({ refused: "Pull Request is not mergeable" });
  fake.route = merging(["merge"], seenApproved, [
    405,
    "At least 2 approving reviews are required by reviewers with write access.",
  ]);
  expect(await ask(mergeQuestion)).toEqual({
    refused: "At least 2 approving reviews are required by reviewers with write access.",
  });
  fake.route = merging([], seenApproved);
  expect(await ask(mergeQuestion)).toEqual({ refused: "simon/app allows no way to merge" });
});

test("merge pr refuses a commit that isn't one, without asking GitHub", async () => {
  fake.route = merging(["merge"], seenApproved);
  await expect(ask({ ...mergeQuestion, commit: "main" })).rejects.toThrow("main isn't a commit");
  expect(mergesSent()).toEqual([]);
});

test("review posts a review that only comments, with the verdict first", async () => {
  fake.route = (asked) =>
    asked.path === "/api/repos/simon/app/pulls/26/reviews" ? json({ id: 777 }) : world(asked);
  const posted = await ask({
    ask: "review",
    repository: "simon/app",
    pr: 26,
    commit: "abc123",
    verdict: "changes",
    body: "Rename it.",
  });
  expect(posted).toEqual({ id: "777" });
  expect(sent("/api/repos/simon/app/pulls/26/reviews")).toEqual([
    { event: "COMMENT", commit_id: "abc123", body: "**Changes requested.**\n\nRename it." },
  ]);
});

test("status sets the skelcrew/check status check, cut to what GitHub takes", async () => {
  const commit = "a".repeat(40);
  fake.route = (asked) =>
    asked.path === `/api/repos/simon/app/statuses/${commit}`
      ? json({ state: "pending" }, 201)
      : world(asked);
  expect(
    await ask({
      ask: "status",
      repository: "simon/app",
      commit,
      state: "pending",
      description: "x".repeat(200),
    }),
  ).toBeNull();
  expect(sent(`/api/repos/simon/app/statuses/${commit}`)).toEqual([
    { state: "pending", context: "skelcrew/check", description: "x".repeat(140) },
  ]);
});

const recorded = (name: string) => readFileSync(join(import.meta.dir, "recorded", name), "utf8");

// A failed GitHub Actions job: its annotations as GitHub answers them, and its log, where the
// post-job cleanup follows the failure. `annotations` is one page, or a list of pages, and
// `steps` the job's steps, which a job not from GitHub Actions has none of.
function failedJob(annotations: unknown[], logText: string, steps?: unknown[]) {
  const pages = Array.isArray(annotations[0]) ? annotations : [annotations];
  return (asked: Asked) => {
    const page = asked.path.match(
      /^\/api\/repos\/simon\/app\/check-runs\/9\/annotations\?per_page=100&page=(\d+)$/,
    );
    if (page) return json(pages[Number(page[1]) - 1] ?? []);
    if (asked.path === "/api/repos/simon/app/actions/jobs/9/logs") return new Response(logText);
    if (asked.path === "/api/repos/simon/app/actions/jobs/9" && steps) return json({ steps });
    return world(asked);
  };
}

const askLog = async () =>
  ((await ask({ ask: "log", repository: "simon/app", check: "9" })) as { log: string }).log;

test("log answers the failure annotations, then what failed in the failed step, not the cleanup", async () => {
  fake.route = failedJob(JSON.parse(recorded("annotations.json")), recorded("job.log"));
  expect(await askLog()).toBe(
    [
      "Annotations on the failed check (failing tests and their errors):",
      "test/call.test.ts:785: log answers the end of a failed job's log",
      "error: expect(received).toEqual(expected)",
      "",
      'Expected: "line 10"',
      'Received: "line 9"',
      "",
      "Lines about failures from the log of the step that failed:",
      '785 |   expect(log.split("\\n")).toEqual(lines);',
      "                              ^",
      "error: expect(received).toEqual(expected)",
      "      at <anonymous> (test/call.test.ts:785:27)",
      "(fail) log answers the end of a failed job's log [21.00ms]",
      "(pass) wake and unwake ask skel's service [9.00ms]",
      "(pass) a question the plugin doesn't answer fails plainly [8.00ms]",
      "",
      "1 tests failed:",
      "",
      " 41 pass",
      " 1 fail",
      "Ran 42 tests across 3 files. [1.20s]",
      'error: script "check" exited with code 1',
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
});

// A job whose lint step failed but was let go on, with continue-on-error, before its tests
// failed it.
const toleratedThenRequired = [
  "2026-11-09T10:00:00.0000000Z Current runner version: '2.329.0'",
  "2026-11-09T10:00:01.0000000Z ##[group]Run bun run lint",
  "2026-11-09T10:00:01.0000000Z ##[endgroup]",
  "2026-11-09T10:00:02.0000000Z (fail) lint: unused import in a.ts",
  "2026-11-09T10:00:02.0000000Z ##[error]Process completed with exit code 1.",
  "2026-11-09T10:00:03.0000000Z ##[group]Run bun test",
  "2026-11-09T10:00:03.0000000Z ##[endgroup]",
  "2026-11-09T10:00:04.0000000Z (pass) adds",
  "2026-11-09T10:00:04.0000000Z (fail) subtracts",
  "2026-11-09T10:00:04.0000000Z ##[error]Process completed with exit code 1.",
  "2026-11-09T10:00:05.0000000Z Post job cleanup.",
  "2026-11-09T10:00:05.0000000Z Error: something in the cleanup",
].join("\n");

const stepsOfIt = (testsName: string) => [
  { name: "Set up job", number: 1, conclusion: "success" },
  { name: "Run bun run lint", number: 2, conclusion: "success" },
  { name: testsName, number: 3, conclusion: "failure" },
  { name: "Post Run actions/checkout@v4", number: 4, conclusion: "success" },
  { name: "Complete job", number: 5, conclusion: "success" },
];

const requiredFailure = [
  "Lines about failures from the log of the step that failed:",
  "(pass) adds",
  "(fail) subtracts",
  "##[error]Process completed with exit code 1.",
].join("\n");

test("log answers the step that failed the job, not an earlier one let go on, by its name", async () => {
  fake.route = failedJob([], toleratedThenRequired, stepsOfIt("Run bun test"));
  expect(await askLog()).toBe(requiredFailure);
});

test("log without the failed step's times answers the last step with an error, for a step with a name of its own", async () => {
  fake.route = failedJob([], toleratedThenRequired, stepsOfIt("Tests"));
  expect(await askLog()).toBe(requiredFailure);
});

test("log leaves out a later step with a name of its own that ran after the failure", async () => {
  const withUpload = toleratedThenRequired.replace(
    "2026-11-09T10:00:05.0000000Z Post job cleanup.",
    [
      "2026-11-09T10:00:04.5000000Z ##[group]Run actions/upload-artifact@v4",
      "2026-11-09T10:00:04.5000000Z ##[endgroup]",
      "2026-11-09T10:00:04.6000000Z Error: no artifact found",
      "2026-11-09T10:00:05.0000000Z Post job cleanup.",
    ].join("\n"),
  );
  const steps = stepsOfIt("Run bun test");
  steps.splice(3, 0, { name: "Upload reports", number: 4, conclusion: "success" });
  fake.route = failedJob([], withUpload, steps);
  expect(await askLog()).toBe(requiredFailure);
});

test("log answers a failed action of several steps through to its error", async () => {
  const composite = [
    "2026-11-09T10:00:00.0000000Z Current runner version: '2.329.0'",
    "2026-11-09T10:00:01.0000000Z ##[group]Run ./.github/actions/test",
    "2026-11-09T10:00:01.0000000Z ##[endgroup]",
    "2026-11-09T10:00:02.0000000Z ##[group]Run bun test",
    "2026-11-09T10:00:02.0000000Z ##[endgroup]",
    "2026-11-09T10:00:03.0000000Z (fail) subtracts",
    "2026-11-09T10:00:03.0000000Z ##[error]Process completed with exit code 1.",
    "2026-11-09T10:00:04.0000000Z ##[group]Run actions/upload-artifact@v4",
    "2026-11-09T10:00:04.0000000Z Error: no artifact found",
  ].join("\n");
  const time = (s: number) => `2026-11-09T10:00:0${s}Z`;
  fake.route = failedJob([], composite, [
    {
      name: "Set up job",
      number: 1,
      conclusion: "success",
      started_at: time(0),
      completed_at: time(0),
    },
    {
      name: "Run ./.github/actions/test",
      number: 2,
      conclusion: "failure",
      started_at: time(1),
      completed_at: time(3),
    },
    {
      name: "Upload reports",
      number: 3,
      conclusion: "success",
      started_at: time(4),
      completed_at: time(4),
    },
  ]);
  expect(await askLog()).toBe(
    [
      "Lines about failures from the log of the step that failed:",
      "##[group]Run bun test",
      "(fail) subtracts",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
});

// A job whose set-up action logs a Run line for each step of its own, whose tests step has a
// name of its own, and whose upload, run after the failure, failed too. The setup's last line
// and the tests' first share a second, as do the tests' last and the upload's first.
test("log finds the failed step by its times, past an action of several steps and before a later failure", async () => {
  const at = (s: number, text: string) =>
    `2026-11-09T10:00:${String(s).padStart(2, "0")}.5000000Z ${text}`;
  const logText = [
    at(0, "Current runner version: '2.329.0'"),
    at(1, "##[group]Run ./.github/actions/setup"),
    at(1, "##[endgroup]"),
    at(2, "##[group]Run bun install"),
    at(3, "Error: optional dependency skipped"),
    at(3, "##[group]Run bun run build"),
    at(4, "built"),
    at(5, "##[group]Run bun test"),
    at(5, "##[endgroup]"),
    at(6, "(pass) adds"),
    at(7, "(fail) real test failure"),
    at(7, "error: expected 1, got 2"),
    at(8, "##[error]Process completed with exit code 1."),
    at(8, "##[group]Run actions/upload-artifact@v4"),
    at(9, "Error: report upload failed"),
    at(9, "##[error]Process completed with exit code 1."),
    at(10, "Post job cleanup."),
  ].join("\n");
  const time = (s: number) => `2026-11-09T10:00:${String(s).padStart(2, "0")}Z`;
  fake.route = failedJob([], logText, [
    {
      name: "Set up job",
      number: 1,
      conclusion: "success",
      started_at: time(0),
      completed_at: time(0),
    },
    { name: "Setup", number: 2, conclusion: "success", started_at: time(1), completed_at: time(5) },
    { name: "Tests", number: 3, conclusion: "failure", started_at: time(5), completed_at: time(8) },
    {
      name: "Upload reports",
      number: 4,
      conclusion: "failure",
      started_at: time(8),
      completed_at: time(9),
    },
  ]);
  expect(await askLog()).toBe(
    [
      "Lines about failures from the log of the step that failed:",
      "(pass) adds",
      "(fail) real test failure",
      "error: expected 1, got 2",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
});

const at = (s: number, text: string) =>
  `2026-11-09T10:00:${String(s).padStart(2, "0")}.5000000Z ${text}`;
const second = (s: number) => `2026-11-09T10:00:${String(s).padStart(2, "0")}Z`;
const step = (name: string, number: number, conclusion: string, from: number, to: number) => ({
  name,
  number,
  conclusion,
  started_at: second(from),
  completed_at: second(to),
});

test("log answers what the failed step logs after an error, through to its end", async () => {
  fake.route = failedJob(
    [],
    [
      at(0, "Current runner version: '2.329.0'"),
      at(1, "##[group]Run bun test"),
      at(1, "##[endgroup]"),
      at(2, "(fail) first failure"),
      at(2, "##[error]a.test.ts: expected 1, got 2"),
      at(3, "(pass) adds"),
      at(3, "(pass) multiplies"),
      at(3, "(pass) divides"),
      at(3, "(pass) rounds"),
      at(4, "(fail) second failure"),
      at(4, "##[error]Process completed with exit code 1."),
      at(5, "Post job cleanup."),
    ].join("\n"),
    [step("Set up job", 1, "success", 0, 0), step("Tests", 2, "failure", 1, 4)],
  );
  expect(await askLog()).toBe(
    [
      "Lines about failures from the log of the step that failed:",
      "##[group]Run bun test",
      "(fail) first failure",
      "##[error]a.test.ts: expected 1, got 2",
      "(pass) adds",
      "(pass) multiplies",
      "(pass) divides",
      "(pass) rounds",
      "(fail) second failure",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
});

test("log answers a failed step with a name of its own that started in the second the step before it did", async () => {
  fake.route = failedJob(
    [],
    [
      at(0, "Current runner version: '2.329.0'"),
      at(2, "##[group]Run ./setup.sh"),
      at(2, "Error: setup went half way"),
      at(2, "##[error]Process completed with exit code 1."),
      at(2, "##[group]Run bun test"),
      at(3, "(fail) real test failure"),
      at(4, "##[error]Process completed with exit code 1."),
      at(5, "Post job cleanup."),
    ].join("\n"),
    [
      step("Set up job", 1, "success", 0, 0),
      step("Setup", 2, "success", 2, 2),
      step("Tests", 3, "failure", 2, 4),
    ],
  );
  expect(await askLog()).toBe(
    [
      "Lines about failures from the log of the step that failed:",
      "##[group]Run bun test",
      "(fail) real test failure",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
});

// An action of several steps, named Tests and the first step to run, whose tests fail and whose
// reporting step runs after them all the same.
test("log answers the whole of a failed action of several steps with a name of its own", async () => {
  fake.route = failedJob(
    [],
    [
      at(0, "Current runner version: '2.329.0'"),
      at(1, "##[group]Run ./.github/actions/tests"),
      at(1, "##[endgroup]"),
      at(1, "##[group]Run bun test"),
      at(2, "(fail) real test failure"),
      at(2, "##[error]Process completed with exit code 1."),
      at(3, "##[group]Run ./report.sh"),
      at(3, "wrote the report"),
      at(4, "Post job cleanup."),
    ].join("\n"),
    [step("Set up job", 1, "success", 0, 0), step("Tests", 2, "failure", 1, 3)],
  );
  expect(await askLog()).toBe(
    [
      "Lines about failures from the log of the step that failed:",
      "##[group]Run bun test",
      "(fail) real test failure",
      "##[error]Process completed with exit code 1.",
      "##[group]Run ./report.sh",
      "wrote the report",
    ].join("\n"),
  );
});

// The same, where the action starts in the second the step before it completed, and the step
// after it starts in the second the action's reporting step did. Whose that reporting step is
// can't be told, so it goes, but what failed stays.
test("log answers the whole of a failed action of several steps that shares its seconds with its neighbours", async () => {
  fake.route = failedJob(
    [],
    [
      at(0, "Current runner version: '2.329.0'"),
      at(1, "##[group]Run ./setup.sh"),
      at(2, "Error: setup went half way"),
      at(2, "##[error]Process completed with exit code 1."),
      at(2, "##[group]Run ./.github/actions/tests"),
      at(2, "##[group]Run bun test"),
      at(2, "(fail) real test failure"),
      at(2, "##[error]Process completed with exit code 1."),
      at(3, "##[group]Run ./report.sh"),
      at(3, "wrote the report"),
      at(3, "##[group]Run actions/upload-artifact@v4"),
      at(3, "Error: no artifact found"),
      at(4, "Post job cleanup."),
    ].join("\n"),
    [
      step("Set up job", 1, "success", 0, 0),
      step("Setup", 2, "success", 1, 2),
      step("Tests", 3, "failure", 2, 3),
      step("Upload reports", 4, "success", 3, 3),
    ],
  );
  expect(await askLog()).toBe(
    [
      "Lines about failures from the log of the step that failed:",
      "##[group]Run ./.github/actions/tests",
      "##[group]Run bun test",
      "(fail) real test failure",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
});

// A failed step followed by an action of several steps, named Report, that starts in the
// second the failed step completed and warns before its own first command.
test("log ends the failed step at the outer Run line of an action of several steps after it", async () => {
  fake.route = failedJob(
    [],
    [
      at(0, "Current runner version: '2.329.0'"),
      at(1, "##[group]Run bun test"),
      at(2, "(fail) real test failure"),
      at(3, "##[error]Process completed with exit code 1."),
      at(3, "##[group]Run ./.github/actions/report"),
      at(3, "Error: unrelated report warning"),
      at(3, "##[group]Run ./report.sh"),
      at(3, "wrote the report"),
      at(4, "Post job cleanup."),
    ].join("\n"),
    [
      step("Set up job", 1, "success", 0, 0),
      step("Tests", 2, "failure", 1, 3),
      step("Report", 3, "success", 3, 3),
    ],
  );
  expect(await askLog()).toBe(
    [
      "Lines about failures from the log of the step that failed:",
      "##[group]Run bun test",
      "(fail) real test failure",
      "##[error]Process completed with exit code 1.",
    ].join("\n"),
  );
});

test("log without the job's steps answers the last step with an error before the cleanup", async () => {
  fake.route = failedJob([], toleratedThenRequired);
  expect(await askLog()).toBe(requiredFailure);
});

test("log reads every page of annotations, so a failure after a page of warnings comes", async () => {
  const warnings = Array.from({ length: 100 }, (_, n) => ({
    path: "a.ts",
    start_line: n + 1,
    annotation_level: "warning",
    title: "lint",
    message: "unused",
  }));
  const failure = {
    path: "test/b.test.ts",
    start_line: 7,
    annotation_level: "failure",
    title: "subtracts",
    message: "error: expected 1",
  };
  fake.route = failedJob([warnings, [failure]], "nothing to see");
  expect(await askLog()).toBe(
    "Annotations on the failed check (failing tests and their errors):\ntest/b.test.ts:7: subtracts\nerror: expected 1",
  );
  expect(fake.asked.filter((a) => a.path.includes("/annotations?")).length).toBe(2);
});

test("log keeps the annotations first and the whole answer within 3000 characters", async () => {
  const many = Array.from({ length: 40 }, (_, n) => ({
    path: "test/a.test.ts",
    start_line: n + 1,
    annotation_level: "failure",
    title: `test ${n}`,
    message: `error: ${"x".repeat(100)}`,
  }));
  fake.route = failedJob(many, recorded("job.log"));
  const log = await askLog();
  expect(log.length).toBeLessThanOrEqual(3000);
  expect(log).toStartWith("Annotations on the failed check");
  expect(log).toContain("test/a.test.ts:1: test 0\nerror: x");
  expect(log).toEndWith("…");
});

test("log without annotations or lines about failures answers the end of the job's log, without GitHub's times", async () => {
  const lines = Array.from({ length: 40 }, (_, n) => `2026-11-09T10:00:00.1234567Z line ${n}`);
  fake.route = failedJob([], lines.join("\n"));
  expect((await askLog()).split("\n")).toEqual([
    "The end of the job's log:",
    ...Array.from({ length: 30 }, (_, n) => `line ${n + 10}`),
  ]);
});

test("log of a check that isn't from GitHub Actions answers its summary", async () => {
  fake.route = (asked) =>
    asked.path === "/api/repos/simon/app/check-runs/9"
      ? json({ output: { title: "Lint failed", summary: "3 problems", text: null } })
      : world(asked);
  expect(await askLog()).toBe("The check's summary:\nLint failed\n\n3 problems");
});

test("wake and unwake ask skel's service to pass on, or stop, the repository's wake-ups", async () => {
  fake.route = (asked) =>
    asked.path === "/service/github/wake" || asked.path === "/service/github/unwake"
      ? new Response(null, { status: 204 })
      : world(asked);
  const url = "https://demo.sprites.app/github";
  expect(await ask({ ask: "wake", repository: "simon/app", url })).toBeNull();
  expect(await ask({ ask: "unwake", repository: "simon/app", url })).toBeNull();
  expect(sent("/service/github/wake")).toEqual([{ repository: "simon/app", url }]);
  expect(sent("/service/github/unwake")).toEqual([{ repository: "simon/app", url }]);
  expect(fake.asked.find((a) => a.path === "/service/github/wake")?.auth).toBe("Bearer user-token");
});

test("a question the plugin doesn't answer, or a repository that isn't one, fails plainly", async () => {
  await expect(ask({ ask: "dance", repository: "simon/app" })).rejects.toThrow(
    "the GitHub plugin doesn't answer dance",
  );
  await expect(ask({ ask: "took", repository: "../x", task: "1" })).rejects.toThrow(
    "isn't a GitHub repository's owner/name",
  );
});

// Exit code 2 tells Skelcrew the plugin needs its setup again, so its error names the command.
const again = "run sc plugin setup github to sign in again";
const took = JSON.stringify({ ask: "took", repository: "simon/app", task: "1" });

test("without setup, a call exits 2 and says to run it", async () => {
  removeSettings(join(dir, "settings.json"));
  const { code, err } = await run(fake.url, dir, ["call.ts"], took);
  expect(code).toBe(2);
  expect(err.trim()).toBe(`GitHub isn't set up: ${again}`);
});

test("a sign-in whose refresh token ran out exits 2, asking nothing", async () => {
  removeSettings(dir);
  dir = signedIn({ accessExpires: Date.now() - 1000, refreshExpires: Date.now() - 1000 });
  const { code, err } = await run(fake.url, dir, ["call.ts"], took);
  expect(code).toBe(2);
  expect(err.trim()).toBe(`your GitHub sign-in ran out: ${again}`);
  expect(fake.asked).toEqual([]);
});

test("a renewal the service refuses as unauthorized exits 2, and other failures exit 1", async () => {
  removeSettings(dir);
  dir = signedIn({ accessExpires: Date.now() - 1000 });
  fake.route = (asked) =>
    asked.path === "/service/github/renew" ? json({ error: "sign in again" }, 401) : world(asked);
  const refused = await run(fake.url, dir, ["call.ts"], took);
  expect(refused.code).toBe(2);
  expect(refused.err.trim()).toBe(`couldn't renew your GitHub sign-in: sign in again: ${again}`);
  fake.route = (asked) =>
    asked.path === "/service/github/renew" ? json({ error: "down" }, 503) : world(asked);
  const down = await run(fake.url, dir, ["call.ts"], took);
  expect(down.code).toBe(1);
  expect(down.err.trim()).toBe("couldn't renew your GitHub sign-in: down");
  const dance = await run(fake.url, dir, ["call.ts"], JSON.stringify({ ask: "dance" }));
  expect(dance.code).toBe(1);
});
