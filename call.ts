// The plugin's call command: skel asks one question as JSON on stdin, and the plugin answers it
// as JSON on stdout, acting on GitHub as skel's GitHub App. A failure exits non-zero with its
// reason as the last line of stderr, which skel shows: code 2 when only the setup fixes it, by
// signing in again or installing the app on the repository, and 1 for anything else.
import { changed, type Item } from "./changed.ts";
import {
  askService,
  asYou,
  githubRemote,
  graphql,
  list,
  number,
  record,
  repositoryToken,
  rest,
  SetupNeeded,
  settings,
  text,
} from "./github.ts";
import { log } from "./log.ts";

// Returns a repository skel names as owner/name, so nothing else reaches a GitHub path.
function repositoryOf(value: unknown): string {
  const name = text(value, "the repository");
  if (!/^[\w.-]+\/[\w.-]+$/.test(name) || name.includes(".."))
    throw new Error(`${name} isn't a GitHub repository's owner/name`);
  return name;
}

// Returns an issue's, PR's or check's number as skel gives it, so nothing else reaches a path.
function numberOf(value: unknown, what: string): number {
  const given = typeof value === "number" ? String(value) : text(value, what);
  if (!/^\d+$/.test(given)) throw new Error(`${given} isn't ${what}`);
  return Number(given);
}

// Returns who commits as the app, as GitHub names its bot: the app's name from its install
// page, which the service names, and the bot's ID, which links a commit to it.
async function appBot(): Promise<{ name: string; email: string }> {
  const { service } = settings();
  const found = await fetch(`${service}/github`, {
    headers: { "user-agent": "skelcrew-github", accept: "application/json" },
  });
  if (!found.ok) throw new Error(`${service} didn't name its app: HTTP ${found.status}`);
  const install = text(record(await found.json(), "the service's answer").install, "the app");
  const slug = install.match(/\/apps\/([\w-]+)\//)?.[1];
  if (!slug) throw new Error(`${install} isn't a GitHub App's install page`);
  const name = `${slug}[bot]`;
  const bot = await asYou(`/users/${encodeURIComponent(name)}`);
  if (bot.status !== 200) throw new Error(`GitHub doesn't know ${name}`);
  const id = number(record(bot.body, name).id, `${name}'s ID`);
  return { name, email: `${id}+${name}@users.noreply.github.com` };
}

// Answers `claims`: the repository's key, short name, link and clone URL, whether you can
// push to it, whether it is a fork, and who commits as the app, or null for a remote that
// isn't on GitHub. Asking the service for a token checks that the app is installed there. Where
// it isn't, claims exits 2, so from your terminal Skelcrew runs the setup, which installs it.
async function claims(remote: string) {
  const found = githubRemote(remote);
  if (!found) return null;
  const given = `${found.owner}/${found.name}`;
  const seen = await asYou(`/repos/${given}`);
  if (seen.status !== 200) throw new Error(`${given} isn't on GitHub, or you can't reach it`);
  const repo = record(seen.body, `${given} on GitHub`);
  const key = text(repo.full_name, "the repository's name");
  await repositoryToken(key);
  const permissions = record(repo.permissions ?? {}, "your permissions");
  return {
    key,
    name: text(repo.name, "the repository's name"),
    link: text(repo.html_url, "the repository's link"),
    clone: text(repo.clone_url, "the repository's clone URL"),
    push: permissions.push === true,
    fork: repo.fork === true,
    author: await appBot(),
  };
}

// Answers `create task`: opens an issue and returns it as a task.
async function createTask(repository: string, title: string, body: string): Promise<Item> {
  const made = await rest(repository, `create an issue in ${repository}`, "POST", "/issues", {
    title,
    body,
  });
  const issue = record(made.body, "the new issue");
  const user = issue.user == null ? null : record(issue.user, "the issue's author");
  const login = user === null ? null : text(user.login, "the issue's author");
  const id = String(number(issue.number, "the issue's number"));
  return {
    kind: "task",
    id,
    title: text(issue.title, "the issue's title"),
    body: typeof issue.body === "string" ? issue.body : "",
    state: "open",
    author:
      login === null
        ? null
        : { login, bot: user?.type === "Bot", you: login === settings().login, push: null },
    labels: list(issue.labels ?? [], "labels").map((l) =>
      text(record(l, "a label").name, "a label"),
    ),
    link: text(issue.html_url, "the issue's link"),
    created: text(issue.created_at, "when the issue was created"),
    updated: text(issue.updated_at, "when the issue was updated"),
    ref: `#${id}`,
    closes: `Closes #${id}`,
  };
}

// Answers `open pr`: the number of the PR open from the branch, opening one when there is
// none. GitHub matches a branch only when it is named with its owner, as owner:branch.
async function openPr(
  repository: string,
  pr: { branch: string; base: string; title: string; body: string },
): Promise<{ number: number }> {
  const owner = repository.split("/")[0];
  const head = encodeURIComponent(`${owner}:${pr.branch}`);
  const found = await rest(
    repository,
    `look for a PR from ${pr.branch}`,
    "GET",
    `/pulls?state=open&head=${head}`,
  );
  const [open] = list(found.body, "the open PRs");
  if (open !== undefined) return { number: number(record(open, "a PR").number, "a PR's number") };
  const made = await rest(repository, `open a PR from ${pr.branch}`, "POST", "/pulls", {
    head: pr.branch,
    base: pr.base,
    title: pr.title,
    body: pr.body,
  });
  return { number: number(record(made.body, "the new PR").number, "the new PR's number") };
}

// Answers `merge pr`: merges the PR, but only while its head is still the commit you saw
// approved, so a push after you looked is never merged unseen. It merges in the first way the
// repository allows, of a merge commit, squash and rebase. Answers null once merged, or with
// why GitHub refused, such as a conflict, a rule on the branch or a head that moved, which
// Skelcrew shows you. The ways allowed come from GraphQL, which tells them to any reader.
async function mergePr(
  repository: string,
  pr: number,
  commit: string,
): Promise<{ refused: string } | null> {
  // The owner and name passed repositoryOf's check, so they hold nothing that ends a string.
  const [owner, name] = repository.split("/");
  const read = await graphql(
    repository,
    `read how ${repository} merges`,
    `query { repository(owner: "${owner}", name: "${name}") { mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed } }`,
  );
  const allows = record(record(read, "GitHub's answer").repository, repository);
  const method =
    allows.mergeCommitAllowed === true
      ? "merge"
      : allows.squashMergeAllowed === true
        ? "squash"
        : allows.rebaseMergeAllowed === true
          ? "rebase"
          : null;
  if (method === null) return { refused: `${repository} allows no way to merge` };
  // GitHub answers 405 for a PR it won't merge, 409 for a head that moved, and 422 for a
  // merge it can't make. Each is a refusal to show, not a failure of the plugin.
  const merged = await rest(
    repository,
    `merge #${pr}`,
    "PUT",
    `/pulls/${pr}/merge`,
    { sha: commit, merge_method: method },
    [405, 409, 422],
  );
  if (merged.status === 200) return null;
  const said = record(merged.body ?? {}, "GitHub's answer").message;
  return { refused: typeof said === "string" ? said : `GitHub answered ${merged.status}` };
}

// Throws when GitHub's refusal is only it asking to slow down: a rate limit, which it answers
// with 403, or edits sent too quickly, with 422. Those pass on their own, so they fail as other
// calls do. Only its words tell them apart, in its message or, for a 422, the errors it lists.
function unlessSlowedDown(answered: { status: number; body: unknown }, doing: string): void {
  if (!/rate limit|too quickly|abuse/i.test(JSON.stringify(answered.body ?? {}))) return;
  const message = record(answered.body ?? {}, "GitHub's answer").message;
  throw new Error(
    `couldn't ${doing}: GitHub said ${typeof message === "string" ? message : answered.status}`,
  );
}

// Answers `edit pr`: replaces the PR's description with the body given, as it is, so the PR
// follows the latest round's summary. Skelcrew keeps its own lines, such as "Closes #12", in
// the body it sends. Answers whether GitHub took the change. A PR that can't be edited answers
// false: one closed or merged, which GitHub would let the app edit, so it is read first, one
// missing, or one the app lacks the permission for.
async function editPr(repository: string, pr: number, body: string): Promise<{ edited: boolean }> {
  // GitHub answers 403 for an app lacking the permission, 404 and 410 for a PR that isn't
  // there, and 422 for an edit it refuses. Each is a PR that can't be edited, not a failure,
  // unless GitHub is only asking to slow down.
  const refusals = [403, 404, 410, 422];
  const read = await rest(repository, `read #${pr}`, "GET", `/pulls/${pr}`, undefined, refusals);
  if (read.status !== 200) {
    unlessSlowedDown(read, `read #${pr}`);
    return { edited: false };
  }
  if (record(read.body, "the PR").state !== "open") return { edited: false };
  const edited = await rest(repository, `edit #${pr}`, "PATCH", `/pulls/${pr}`, { body }, refusals);
  if (edited.status === 200) return { edited: true };
  unlessSlowedDown(edited, `edit #${pr}`);
  return { edited: false };
}

// Answers `close pr`: posts the comment when there is one, so the PR says why it closed, then
// closes the PR and deletes its branch, as skel's sc rm removes the thread behind it. A branch
// already gone, such as one GitHub deleted itself, counts as deleted.
async function closePr(
  repository: string,
  pr: number,
  branch: string,
  comment: string | null,
): Promise<null> {
  if (comment !== null)
    await rest(repository, `comment on #${pr}`, "POST", `/issues/${pr}/comments`, {
      body: comment,
    });
  await rest(repository, `close #${pr}`, "PATCH", `/pulls/${pr}`, { state: "closed" });
  // Each part of the branch's name is encoded on its own, as its slashes are part of the path.
  const ref = branch.split("/").map(encodeURIComponent).join("/");
  const deleted = await rest(
    repository,
    `delete ${branch}`,
    "DELETE",
    `/git/refs/heads/${ref}`,
    undefined,
    [422],
  );
  if (deleted.status !== 422) return null;
  // GitHub answers 422 both for a branch already gone and for one it refuses to delete, such as
  // a protected branch. Only asking for the branch tells them apart.
  const still = await rest(
    repository,
    `look for ${branch}`,
    "GET",
    `/git/ref/heads/${ref}`,
    undefined,
    [404],
  );
  if (still.status === 404) return null;
  const said = record(deleted.body ?? {}, "GitHub's answer").message;
  throw new Error(
    `couldn't delete ${branch}: GitHub said ${typeof said === "string" ? said : "422"}`,
  );
}

// Answers `review`: posts the reviewer's verdict on the PR as a review that only comments,
// for the commit it covers. GitHub doesn't let a PR's author approve it, and skel's app opened
// the PR, so the verdict is in its first words, and the skelcrew/check check carries it.
async function review(
  repository: string,
  pr: number,
  commit: string,
  verdict: string,
  body: string,
): Promise<{ id: string }> {
  const said = verdict === "approve" ? "**Approved.**" : "**Changes requested.**";
  const posted = await rest(repository, `post a review on #${pr}`, "POST", `/pulls/${pr}/reviews`, {
    event: "COMMENT",
    commit_id: commit,
    body: `${said}\n\n${body}`,
  });
  return { id: String(number(record(posted.body, "the review").id, "the review's ID")) };
}

// Answers `seen`: reacts with 👀 to a person's comment or review on the PR, once skel has typed
// it into the builder, so they can see on GitHub that it was picked up. GitHub's REST API has
// no reactions on a review, so a review is found by its ID for its node ID, which GitHub's
// GraphQL API reacts to.
async function seen(repository: string, pr: number, kind: string, id: number): Promise<null> {
  if (kind === "comment") {
    await rest(repository, `react to comment ${id}`, "POST", `/issues/comments/${id}/reactions`, {
      content: "eyes",
    });
    return null;
  }
  const found = await rest(repository, `find review ${id}`, "GET", `/pulls/${pr}/reviews/${id}`);
  // The node ID goes into the query as it is, so it may hold nothing that ends a string.
  const node = text(record(found.body, "the review").node_id, "the review's node ID");
  if (!/^[\w=-]+$/.test(node)) throw new Error(`${node} isn't a review's node ID`);
  await graphql(
    repository,
    `react to review ${id}`,
    `mutation { addReaction(input: { subjectId: "${node}", content: EYES }) { clientMutationId } }`,
  );
  return null;
}

// Answers `assign`: adds you to the issue as an assignee, or with `on` false takes you off,
// leaving other assignees be. You are the person the setup signed in as. The app makes the
// change, as Skelcrew acts on GitHub only as its app. Adding answers whether this call added
// you, so Skelcrew takes you off later only if it put you on.
async function assign(repository: string, task: number, on: boolean) {
  const { login } = settings();
  if (!on) {
    await rest(repository, `take ${login} off #${task}`, "DELETE", `/issues/${task}/assignees`, {
      assignees: [login],
    });
    return null;
  }
  const assigned = (issue: unknown) =>
    list(record(issue, "the issue").assignees ?? [], "the issue's assignees").some(
      (each) => record(each, "an assignee").login === login,
    );
  const before = await rest(repository, `read #${task}`, "GET", `/issues/${task}`);
  if (assigned(before.body)) return { assigned: false };
  const after = await rest(repository, `assign #${task}`, "POST", `/issues/${task}/assignees`, {
    assignees: [login],
  });
  // GitHub quietly leaves out someone it won't assign, such as a person who can't reach the
  // repository, so only the issue it answers with says whether it worked.
  if (!assigned(after.body)) throw new Error(`GitHub didn't assign ${login} to #${task}`);
  return { assigned: true };
}

// Returns the answer to one question from skel.
async function answer(question: Record<string, unknown>): Promise<unknown> {
  const ask = text(question.ask, "the question");
  if (ask === "claims") return claims(text(question.remote, "the remote"));
  const repository = repositoryOf(question.repository);
  if (ask === "changed")
    return changed(
      repository,
      list(question.jobs, "the jobs").map((job) => text(job, "a job")),
      question.next == null ? null : text(question.next, "next"),
      list(question.prs ?? [], "the PRs").map((pr) => number(pr, "a PR")),
    );
  if (ask === "create task")
    return createTask(
      repository,
      text(question.title, "the title"),
      text(question.body, "the body"),
    );
  if (ask === "took") {
    const task = numberOf(question.task, "an issue's number");
    // GitHub answers 201 when it adds the app's 👀 and 200 when the app's was there already.
    // Every machine reacts as the same bot, so a 200 means another one, or this one earlier,
    // took the issue, and Skelcrew here leaves it be.
    const reacted = await rest(
      repository,
      `react to #${task}`,
      "POST",
      `/issues/${task}/reactions`,
      {
        content: "eyes",
      },
    );
    return { took: reacted.status === 201 };
  }
  if (ask === "assign") {
    if (typeof question.on !== "boolean")
      throw new Error("whether to assign you isn't what the GitHub plugin expects");
    return assign(repository, numberOf(question.task, "an issue's number"), question.on);
  }
  if (ask === "seen") {
    const kind = text(question.kind, "the kind");
    if (kind !== "comment" && kind !== "review")
      throw new Error(`${kind} isn't a comment or a review`);
    return seen(
      repository,
      numberOf(question.pr, "a PR's number"),
      kind,
      numberOf(question.id, `a ${kind}'s ID`),
    );
  }
  if (ask === "open pr")
    return openPr(repository, {
      branch: text(question.branch, "the branch"),
      base: text(question.base, "the base"),
      title: text(question.title, "the title"),
      body: text(question.body, "the body"),
    });
  if (ask === "merge pr") {
    const commit = text(question.commit, "the commit");
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${commit} isn't a commit`);
    return mergePr(repository, numberOf(question.pr, "a PR's number"), commit);
  }
  if (ask === "edit pr")
    return editPr(
      repository,
      numberOf(question.pr, "a PR's number"),
      text(question.body, "the body"),
    );
  if (ask === "close pr") {
    // Only what a branch skel names holds, so nothing else reaches a GitHub path.
    const branch = text(question.branch, "the branch");
    if (!/^[\w-][\w./-]*$/.test(branch) || branch.includes(".."))
      throw new Error(`${branch} isn't a branch`);
    return closePr(
      repository,
      numberOf(question.pr, "a PR's number"),
      branch,
      question.comment == null ? null : text(question.comment, "the comment"),
    );
  }
  if (ask === "review")
    return review(
      repository,
      numberOf(question.pr, "a PR's number"),
      text(question.commit, "the commit"),
      text(question.verdict, "the verdict"),
      text(question.body, "the body"),
    );
  if (ask === "status") {
    const commit = text(question.commit, "the commit");
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${commit} isn't a commit`);
    // GitHub refuses a description longer than 140 characters.
    await rest(
      repository,
      `set the skelcrew/check check on ${commit}`,
      "POST",
      `/statuses/${commit}`,
      {
        state: text(question.state, "the state"),
        context: "skelcrew/check",
        description: text(question.description, "the description").slice(0, 140),
      },
    );
    return null;
  }
  if (ask === "log") return log(repository, String(numberOf(question.check, "a check's ID")));
  if (ask === "wake" || ask === "unwake") {
    await askService(`/github/${ask}`, { repository, url: text(question.url, "the address") });
    return null;
  }
  throw new Error(`the GitHub plugin doesn't answer ${ask}`);
}

try {
  const question = record(JSON.parse(await Bun.stdin.text()), "Skelcrew's question");
  console.log(JSON.stringify(await answer(question)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error instanceof SetupNeeded ? 2 : 1);
}
