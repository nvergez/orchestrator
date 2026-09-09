/**
 * Slack ships mentions as bare ids — `<@U08G64ER601>` in the event payload,
 * and the same in every `rich_text` element the filter walks. Handed through
 * untouched, the session only ever knows people as ids, so it names them by id
 * in the thread ("`U08G64ER601` can ping me instead") and nobody reading the
 * thread knows who that is. This resolves ids to display names once and caches
 * them, and keeps the `<@…>` form available in a roster line so a reply can
 * still deliberately notify someone.
 */

import type { Logger } from '../kernel/logger.ts';

/** The slice of Slack's `users.info` the directory calls (needs `users:read`). */
export interface UsersApi {
  info(args: { user: string }): Promise<{
    ok?: boolean;
    error?: string;
    user?: {
      name?: string;
      real_name?: string;
      profile?: { display_name?: string; real_name?: string };
    };
  }>;
}

/** Both mention shapes Slack emits: bare, and the legacy labelled `<@ID|name>`. */
const MENTION = /<@([UWB][A-Z0-9]{2,})(?:\|[^>]*)?>/g;
/** Names change rarely; a long-lived daemon still picks a rename up same-day. */
const NAME_TTL_MS = 6 * 60 * 60 * 1000;
/** A failed lookup (deleted user, revoked scope) must not hammer Slack. */
const MISS_TTL_MS = 5 * 60 * 1000;
const MAX_NAME_LENGTH = 64;

export class UserNames {
  private readonly cache = new Map<string, { name?: string; at: number }>();
  private readonly users: UsersApi;
  private readonly enabled: boolean;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: { users: UsersApi; enabled: boolean; logger: Logger; now?: () => number }) {
    this.users = options.users;
    this.enabled = options.enabled;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /**
   * Rewrites every mention in a turn — the instruction, the quoted thread
   * context and the attachment labels alike — into `@Display Name`, and
   * appends the id roster. An id that cannot be resolved, and a token without
   * `users:read`, leave the text exactly as Slack delivered it.
   */
  async render(text: string): Promise<string> {
    if (!this.enabled) return text;
    const ids = [...new Set([...text.matchAll(MENTION)].map((match) => match[1]!))];
    if (ids.length === 0) return text;
    const names = new Map<string, string>();
    for (const id of ids) {
      const name = await this.name(id);
      if (name !== undefined) names.set(id, name);
    }
    if (names.size === 0) return text;
    const named = text.replace(MENTION, (whole, id: string) => {
      const name = names.get(id);
      return name === undefined ? whole : `@${name}`;
    });
    const roster = [...names].map(([id, name]) => `@${name} = <@${id}>`).join('; ');
    return `${named}\n\n[Slack ids — ${roster}. Call people by name; paste the <@…> form only when you deliberately want to notify them, never a bare id.]`;
  }

  /** Cached `users.info`; a lookup failure degrades to "no name known". */
  private async name(id: string): Promise<string | undefined> {
    const now = this.now();
    const hit = this.cache.get(id);
    if (hit && now - hit.at < (hit.name === undefined ? MISS_TTL_MS : NAME_TTL_MS)) return hit.name;
    try {
      const result = await this.users.info({ user: id });
      if (result.ok === false) throw new Error(result.error ?? 'users.info failed');
      const name = displayName(result.user);
      this.cache.set(id, { name, at: now });
      return name;
    } catch (error) {
      this.logger.warn({ err: error, userId: id }, 'Slack user name lookup failed');
      this.cache.set(id, { at: now });
      return undefined;
    }
  }
}

/** What the workspace shows first, falling back through Slack's own ladder. */
function displayName(user: Awaited<ReturnType<UsersApi['info']>>['user']): string | undefined {
  const raw = user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name;
  // A display name is user-authored text landing next to the instruction:
  // keep it one short, unmarked-up line so it cannot forge prompt structure.
  const safe = (raw ?? '').replace(/[<>|@\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH).trim();
  return safe === '' ? undefined : safe;
}
