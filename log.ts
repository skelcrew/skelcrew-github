// Answers `log`: what a failed check says went wrong, kept short, as skel types it into the
// builder so it can fix CI. In order: the check's failure annotations, which name the failing
// tests and their errors, then the lines about failures from the log of the step that failed,
// and only when both are empty, the end of the job's log, or for a check not from GitHub
// Actions, its summary. A heading says what each part is.
import { list, record, repositoryToken, rest } from "./github.ts";

// The most skel takes, in characters.
export const limit = 3000;

// Lines that say what failed, in the test runners and compilers CI runs.
const failing = /\(fail\)|error:|FAIL|✗|Error/;

// Lines of context kept before and after each line that says what failed.
const before = 2;
const after = 3;

// Returns the check's failure annotations, each as its place, title and message. GitHub adds
// one to every failed job for its exit code, which says nothing the rest doesn't, so it goes.
export function annotations(given: unknown): string[] {
  return list(given, "the check's annotations").flatMap((each) => {
    const a = record(each, "an annotation");
    if (a.annotation_level !== "failure") return [];
    const message = typeof a.message === "string" ? a.message.trim() : "";
    if (/^Process completed with exit code \d+\.?$/.test(message)) return [];
    const path = typeof a.path === "string" && a.path !== ".github" ? a.path : "";
    const line = typeof a.start_line === "number" && path !== "" ? `:${a.start_line}` : "";
    const title = typeof a.title === "string" ? a.title.trim() : "";
    const head = [`${path}${line}`, title].filter((part) => part !== "").join(": ");
    const text = [head, message].filter((part) => part !== "").join("\n");
    return text === "" ? [] : [text];
  });
}

// Returns a job's log as lines, without the time GitHub puts in front of each, and that time
// for each line, in milliseconds, or null for a line without one.
export function linesOf(log: string): { lines: string[]; times: (number | null)[] } {
  const lines: string[] = [];
  const times: (number | null)[] = [];
  for (const raw of log.trimEnd().split("\n")) {
    const line = raw.replace(/\r$/, "");
    const time = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z) ?/);
    lines.push(time ? line.slice(time[0].length) : line);
    times.push(time?.[1] ? Date.parse(time[1]) : null);
  }
  return { lines, times };
}

// A step of the job, as GitHub's jobs API reports it, with when it started and completed, in
// milliseconds. A step that failed but was let go on, with continue-on-error, has the
// conclusion "success", so only the one that failed the job has "failure".
export type Step = {
  name: string;
  number: number;
  conclusion: string | null;
  started: number | null;
  completed: number | null;
};

// Returns the job's steps from GitHub's answer for the job.
export function stepsOf(job: unknown): Step[] {
  const time = (value: unknown) => {
    const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  };
  return list(record(job, "the job").steps ?? [], "the job's steps").map((each) => {
    const step = record(each, "a step");
    return {
      name: typeof step.name === "string" ? step.name : "",
      number: typeof step.number === "number" ? step.number : 0,
      conclusion: typeof step.conclusion === "string" ? step.conclusion : null,
      started: time(step.started_at),
      completed: time(step.completed_at),
    };
  });
}

// Returns the lines of the step that failed the job.
//
// In the log, the job's set-up comes first, then each step from a ##[group]Run line, then the
// post-job steps, from "Post job cleanup." or "Cleaning up orphan processes". A Run line alone
// doesn't mark a step: an action of several steps logs one for each of its own, and a step with
// a name of its own shows by its command, not its name. So each step is placed by its times,
// which the jobs API gives to the second. A step's Run line is logged in its first second,
// after every line of the step before it and before any line logged after that step completed.
// Where the second a step starts is shared with the step before it, and either is an action
// of several steps, the times can't tell whose Run line is whose, so the failed step is placed
// to keep all of itself, at the cost of some of its neighbours. The steps up to it are placed
// from the first on, each at the first Run line from the second it started after the line of
// the step before it, so the failed step never starts at one of its own later Run lines. The
// steps after it are placed from the last back, each at the last such line, so the step after
// it is never placed at one of the failed step's own. A Run line that shows the step's name
// comes first. The failed step runs from its line to the next step's, or the post-job steps,
// so whatever it logs after an error comes too.
//
// Without the steps' times, the failed step is found by its name alone, and runs to the next
// Run line. Without the steps, or when neither finds it, it is the last part before the
// post-job steps with an ##[error] line, as a job stops at the step that fails it, or failing
// that, everything before the post-job steps.
export function failedStep(
  lines: string[],
  times: (number | null)[] = [],
  steps: Step[] = [],
): string[] {
  let cleanup = lines.findIndex((line) =>
    /^(Post job cleanup\.|Cleaning up orphan processes)/.test(line),
  );
  if (cleanup === -1) cleanup = lines.length;
  const isRun = (n: number) => /^##\[group\]Run /.test(lines[n] ?? "");
  const runs = lines.flatMap((_, n) => (n < cleanup && isRun(n) ? [n] : []));
  const header = (step: Step) => `##[group]${step.name}`;
  const failed = steps.find((step) => step.conclusion === "failure");
  const placed = failed === undefined ? null : place(lines, times, steps, failed, runs, cleanup);
  if (placed !== null) return lines.slice(placed.start, placed.end);
  if (failed !== undefined) {
    const at = runs.find((n) => lines[n] === header(failed));
    if (at !== undefined) return lines.slice(at, runs.find((n) => n > at) ?? cleanup);
  }
  const starts = [0, ...runs.filter((n) => n > 0), cleanup];
  const parts = starts.slice(0, -1).map((start, i) => lines.slice(start, starts[i + 1]));
  const last = parts.findLastIndex((part) => part.some((l) => l.startsWith("##[error]")));
  if (last !== -1) return parts[last] ?? [];
  return lines.slice(0, cleanup);
}

// Returns where the failed step starts and ends in the lines before the cleanup, placing the
// steps as failedStep describes, or null when a step's times are missing or the failed step
// finds no Run line that fits.
function place(
  lines: string[],
  times: (number | null)[],
  steps: Step[],
  failed: Step,
  runs: number[],
  cleanup: number,
): { start: number; end: number } | null {
  const second = (ms: number) => Math.floor(ms / 1000);
  const logged = steps.filter(
    (step, n) =>
      !(n === 0 && step.name === "Set up job") &&
      !step.name.startsWith("Post ") &&
      step.name !== "Complete job" &&
      step.conclusion !== "skipped",
  );
  const ran = steps.filter((step) => step.conclusion !== "skipped");
  const at = logged.indexOf(failed);
  if (at === -1 || logged.some((step) => step.started == null || step.completed == null))
    return null;
  // The first line logged after the second, and the last logged before it.
  const firstAfter = (s: number) => {
    const n = times.findIndex((time, i) => i < cleanup && time != null && second(time) > s);
    return n === -1 ? cleanup : n;
  };
  const lastBefore = (s: number) =>
    times.findLastIndex((time, i) => i < cleanup && time != null && second(time) < s);
  // The Run lines the step can start at, after `after` and before `next`: those from the second
  // it started, or failing that, any up to the second it completed, with one showing its name
  // alone when there is one.
  const fits = (step: Step, after: number, next: number) => {
    const start = second(step.started ?? 0);
    const end = second(step.completed ?? 0);
    const before = ran[ran.indexOf(step) - 1]?.completed;
    const from = Math.max(after + 1, lastBefore(start) + 1);
    const to = Math.min(next - 1, before == null ? cleanup : firstAfter(second(before)));
    const within = runs.filter((n) => {
      const time = times[n];
      return n >= from && n <= to && (time == null || second(time) <= end);
    });
    const first = within.filter((n) => {
      const time = times[n];
      return time == null || second(time) === start;
    });
    const all = first.length > 0 ? first : within;
    const named = all.filter((n) => lines[n] === `##[group]${step.name}`);
    return named.length > 0 ? named : all;
  };
  let start = -1;
  for (let k = 0; k <= at; k++) {
    const step = logged[k];
    const found = step === undefined ? undefined : fits(step, start, cleanup)[0];
    if (found !== undefined) start = found;
    else if (k === at) return null;
  }
  let end = cleanup;
  for (let k = logged.length - 1; k > at; k--) {
    const step = logged[k];
    const found = step === undefined ? undefined : fits(step, start, end).at(-1);
    if (found !== undefined) end = found;
  }
  return { start, end };
}

// Returns the lines that say what failed, each with a few lines around it. Lines already kept
// are left out, as test runners repeat their failures in a summary at the end, and "..." marks
// lines skipped between.
export function failures(lines: string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  let end = -1;
  lines.forEach((line, n) => {
    if (!failing.test(line)) return;
    const from = Math.max(n - before, end + 1);
    const to = Math.min(n + after, lines.length - 1);
    if (from > end + 1 && kept.length > 0 && kept.at(-1) !== "...") kept.push("...");
    for (let i = from; i <= to; i++) {
      const each = lines[i] ?? "";
      if (each.startsWith("##[endgroup]")) continue;
      if (each.trim() !== "" && seen.has(each)) continue;
      seen.add(each);
      kept.push(each);
    }
    end = Math.max(end, to);
  });
  while (kept.at(-1) === "...") kept.pop();
  return kept;
}

// Returns the parts as one answer within the limit, each under its heading, in order, so the
// first parts keep their room. A part cut short keeps its start, but for one `fromEnd`.
export function within(parts: { heading: string; text: string; fromEnd?: boolean }[]): string {
  let answer = "";
  for (const part of parts) {
    if (part.text.trim() === "") continue;
    const head = `${answer === "" ? "" : "\n\n"}${part.heading}\n`;
    const room = limit - answer.length - head.length;
    if (room < 40) break;
    const text =
      part.text.length <= room
        ? part.text
        : part.fromEnd
          ? `…${part.text.slice(-(room - 1))}`
          : `${part.text.slice(0, room - 1)}…`;
    answer += head + text;
  }
  return answer;
}

// Returns the check's failure annotations from every page GitHub has, as a check can have
// pages of warnings before its failures, until there are more than the answer has room for.
async function failureAnnotations(repository: string, check: string): Promise<string[]> {
  const notes: string[] = [];
  for (let page = 1; page <= 30; page++) {
    const got = await rest(
      repository,
      `read check ${check}'s annotations`,
      "GET",
      `/check-runs/${check}/annotations?per_page=100&page=${page}`,
      undefined,
      [404],
    );
    if (got.status !== 200) break;
    const all = list(got.body, "the check's annotations");
    notes.push(...annotations(all));
    if (all.length < 100 || notes.join("\n\n").length >= limit) break;
  }
  return notes;
}

export async function log(repository: string, check: string): Promise<{ log: string }> {
  const notes = await failureAnnotations(repository, check);
  const job = await rest(
    repository,
    `read job ${check}`,
    "GET",
    `/actions/jobs/${check}`,
    undefined,
    [404],
  );
  const steps = job.status === 200 ? stepsOf(job.body) : [];
  const token = await repositoryToken(repository);
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/jobs/${check}/logs`,
    { headers: { authorization: `Bearer ${token}`, "user-agent": "skelcrew-github" } },
  );
  const parts = [
    {
      heading: "Annotations on the failed check (failing tests and their errors):",
      text: notes.join("\n\n"),
    },
  ];
  if (response.ok) {
    const { lines, times } = linesOf(await response.text());
    parts.push({
      heading: "Lines about failures from the log of the step that failed:",
      text: failures(failedStep(lines, times, steps)).join("\n"),
    });
    if (parts.every((part) => part.text === ""))
      return {
        log: within([
          {
            heading: "The end of the job's log:",
            text: lines.slice(-30).join("\n"),
            fromEnd: true,
          },
        ]),
      };
    return { log: within(parts) };
  }
  if (notes.length > 0) return { log: within(parts) };
  const run = await rest(repository, `read check ${check}`, "GET", `/check-runs/${check}`);
  const output = record(record(run.body, "the check").output ?? {}, "the check's output");
  const summary = [output.title, output.summary, output.text]
    .filter((part) => typeof part === "string" && part !== "")
    .join("\n\n");
  return { log: within([{ heading: "The check's summary:", text: summary, fromEnd: true }]) };
}
