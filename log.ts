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

// Returns a job's log as lines, without the time GitHub puts in front of each.
export function linesOf(log: string): string[] {
  return log
    .trimEnd()
    .split("\n")
    .map((line) => line.replace(/\r$/, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""));
}

// Returns the lines of the step that failed. A step's log starts with ##[group]Run, and the
// post-job steps, which come last, with "Post job cleanup." or "Cleaning up orphan processes". The step that
// failed is the first with an ##[error] line. When none has one, it is everything before the
// post-job steps.
export function failedStep(lines: string[]): string[] {
  const steps: string[][] = [[]];
  const post: boolean[] = [false];
  for (const line of lines) {
    const isPost = /^(Post job cleanup\.|Cleaning up orphan processes)/.test(line);
    if (/^##\[group\]Run /.test(line) || isPost) {
      steps.push([]);
      post.push(isPost || post.at(-1) === true);
    }
    steps[steps.length - 1]?.push(line);
  }
  const failed = steps.findIndex(
    (step, n) => !post[n] && step.some((l) => l.startsWith("##[error]")),
  );
  if (failed !== -1) return steps[failed] ?? [];
  return steps.filter((_, n) => !post[n]).flat();
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

export async function log(repository: string, check: string): Promise<{ log: string }> {
  const noted = await rest(
    repository,
    `read check ${check}'s annotations`,
    "GET",
    `/check-runs/${check}/annotations?per_page=100`,
    undefined,
    [404],
  );
  const notes = noted.status === 200 ? annotations(noted.body) : [];
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
    const lines = linesOf(await response.text());
    parts.push({
      heading: "Lines about failures from the log of the step that failed:",
      text: failures(failedStep(lines)).join("\n"),
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
