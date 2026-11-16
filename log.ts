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

// Returns the lines of the step that failed the job. In the log, the job's set-up comes first,
// then each step from a ##[group]Run line, then the post-job steps, from "Post job cleanup." or
// "Cleaning up orphan processes". A Run line doesn't mark a step reliably: an action of several
// steps logs one for each, and a step with a name of its own shows by its command, not its
// name. So the step that failed is found by its times, which the jobs API gives to the second:
// the lines logged from the second it started to the second it completed. The steps on either
// side may have logged in those seconds too, so it starts at its Run line, found by its name or
// else the first in that time, and ends at its first ##[error] line, which a failed step ends
// with. Without its times, it is found by its name alone, running to its first ##[error] line
// but never past a later step's Run line or into the post-job steps. Without the steps, or when
// neither finds it, it is the last part before the post-job steps with an ##[error] line, as a
// job stops at the step that fails it, or failing that, everything before the post-job steps.
export function failedStep(
  lines: string[],
  times: (number | null)[] = [],
  steps: Step[] = [],
): string[] {
  const post: boolean[] = [];
  let after = false;
  for (const line of lines) {
    if (/^(Post job cleanup\.|Cleaning up orphan processes)/.test(line)) after = true;
    post.push(after);
  }
  const isRun = (n: number) => /^##\[group\]Run /.test(lines[n] ?? "");
  const isError = (n: number) => (lines[n] ?? "").startsWith("##[error]");
  const firstFrom = (from: number, to: number, found: (n: number) => boolean) => {
    for (let n = from; n <= to; n++) if (found(n)) return n;
    return -1;
  };
  const failed = steps.find((step) => step.conclusion === "failure");
  const header = (step: Step) => `##[group]${step.name}`;
  if (failed?.started != null && failed.completed != null) {
    const second = (ms: number) => Math.floor(ms / 1000);
    const from = second(failed.started);
    const to = second(failed.completed);
    const inside = (n: number) => {
      const time = times[n];
      return !post[n] && time != null && second(time) >= from && second(time) <= to;
    };
    const lo = firstFrom(0, lines.length - 1, inside);
    if (lo !== -1) {
      let hi = lo;
      for (let n = lo; n < lines.length; n++) if (inside(n)) hi = n;
      let start = firstFrom(lo, hi, (n) => lines[n] === header(failed));
      if (start === -1) start = firstFrom(lo, hi, isRun);
      if (start === -1) start = lo;
      const end = firstFrom(start, hi, isError);
      return lines.slice(start, (end === -1 ? hi : end) + 1);
    }
  }
  if (failed !== undefined) {
    const later = new Set(steps.filter((s) => s.number > failed.number).map(header));
    const start = firstFrom(0, lines.length - 1, (n) => !post[n] && lines[n] === header(failed));
    if (start !== -1) {
      let end = start;
      while (!isError(end)) {
        const next = end + 1;
        if (next >= lines.length || post[next] || later.has(lines[next] ?? "")) {
          end = firstFrom(start + 1, next - 1, isRun) - 1;
          if (end < start) end = next - 1;
          break;
        }
        end = next;
      }
      return lines.slice(start, end + 1);
    }
  }
  const parts: string[][] = [[]];
  const partPost: boolean[] = [false];
  lines.forEach((line, n) => {
    if (isRun(n) || (post[n] && !post[n - 1])) {
      parts.push([]);
      partPost.push(post[n] === true);
    }
    parts[parts.length - 1]?.push(line);
  });
  const erred = (part: string[]) => part.some((l) => l.startsWith("##[error]"));
  const last = parts.findLastIndex((part, n) => !partPost[n] && erred(part));
  if (last !== -1) return parts[last] ?? [];
  return parts.filter((_, n) => !partPost[n]).flat();
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
