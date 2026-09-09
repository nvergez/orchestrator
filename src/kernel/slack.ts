/** Slack's auth.test returns granted scopes in the x-oauth-scopes header. */
export function imageAttachmentsEnabled(scopes: readonly string[] = []): boolean {
  return scopes.includes('files:read');
}

/** The doctor uses the identity check without loading Bolt or daemon code. */
export async function slackIdentity(token: string): Promise<{ scopes: string[] }> {
  const response = await fetch('https://slack.com/api/auth.test', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Slack identity check returned HTTP ${response.status}`);
  const identity = await response.json() as { ok?: boolean };
  if (!identity.ok) throw new Error('Slack identity check failed');
  return { scopes: (response.headers.get('x-oauth-scopes') ?? '').split(',').map((scope) => scope.trim()) };
}
