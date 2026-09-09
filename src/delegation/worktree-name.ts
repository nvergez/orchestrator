/** The de-slugged suffix for a card until task-create supplies its title.
 * Repo identity always comes from the registry, never from this name. */
export function titleFromName(worktreeName: string, repo: string): string {
  const slug = worktreeName.startsWith(`${repo}-`) ? worktreeName.slice(repo.length + 1) : worktreeName;
  return slug.replaceAll('-', ' ');
}
