/**
 * The `<repo>-<issue#>-<slug>` worktree naming convention (spec §5) — the
 * one parser of it. The delegation coordinator enforces the shape at create
 * time and reads the repo/issue/title back out of it as the fallback when
 * the runtime's own metadata is missing; the gate relay renders `repo#n`
 * ack refs from it. Nothing else may parse a worktree name.
 */

/** The repo prefix; the whole name when unconventional. */
export function repoFromName(worktreeName: string): string {
  return /^(.*?)-\d+-/.exec(worktreeName)?.[1] ?? worktreeName;
}

/** The issue number; null when the name does not follow the convention. */
export function issueFromName(worktreeName: string): number | null {
  const match = /^.*?-(\d+)-/.exec(worktreeName);
  return match === null ? null : Number(match[1]);
}

/** The `repo#n` display ref; null when the name does not follow the convention. */
export function worktreeIssueRef(worktreeName: string): string | null {
  const issue = issueFromName(worktreeName);
  return issue === null ? null : `${repoFromName(worktreeName)}#${issue}`;
}

/** The de-slugged suffix — the card title until task-create names it. */
export function titleFromName(worktreeName: string): string {
  const match = /^.*?-\d+-/.exec(worktreeName);
  const slug = match === null ? worktreeName : worktreeName.slice(match[0].length);
  return slug.replaceAll('-', ' ');
}
