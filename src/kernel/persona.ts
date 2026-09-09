import { readFileSync } from 'node:fs';

/**
 * The operator's voice: free prose in `~/.config/orchestrator/persona.md`
 * (or wherever `ORCHESTRATOR_PERSONA_PATH` points) describing how the
 * Slack-facing session should sound, rendered into the session's system
 * prompt right after the routing rules.
 *
 * Optional by design — an absent file leaves the stock voice, which is why
 * a missing file is silence here while a missing routing-hints file is
 * boot-fatal (routing.ts): hints are an allow-list, tone is a preference.
 * An existing file that cannot be honored (unreadable, oversized) still
 * fails the boot: the operator wrote it expecting it to be heard.
 *
 * `personaInstructions` is the other half — it frames the prose so a voice
 * can never quietly override the conduct around it: the fixed protocol
 * lines stay fixed, and text relayed to a worker stays verbatim (spec §6).
 */

export class PersonaError extends Error {}

/**
 * Past this the file stops being a voice and becomes a second system
 * prompt — it rides in every turn, so an overrun fails the boot loudly
 * instead of quietly inflating each turn's cost.
 */
export const PERSONA_MAX_CHARS = 8_000;

/**
 * The worker register's own, tighter cap: it is copied into every brief,
 * read by two different agents, and competes there with the request itself.
 * Long prose would dilute the brief; this one is meant to be blunt lines.
 */
export const WORKER_PERSONA_MAX_CHARS = 2_000;

/**
 * HTML comments are the file's own commentary: `orc init` scaffolds a
 * fully commented persona.md, and stripping them here is what makes an
 * untouched scaffold read as "no persona configured" rather than as
 * instructions the model would dutifully follow.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * Read one of the operator's voice files. Missing file (or one holding
 * nothing but commentary) → `undefined`, the stock voice. Any other failure
 * throws. `maxChars` is the caller's cap — the two files have different
 * budgets for different reasons.
 */
export function loadPersona(filePath: string, maxChars = PERSONA_MAX_CHARS): string | undefined {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PersonaError(`cannot read the persona at ${filePath}: ${String(error)}`);
  }

  const persona = text.replace(HTML_COMMENT, '').trim();
  if (persona === '') return undefined;
  if (persona.length > maxChars) {
    throw new PersonaError(
      `${filePath}: the persona is ${persona.length} characters, over the ${maxChars} cap — ` +
        'it rides in every turn of every thread; keep it to the tone rules that matter',
    );
  }
  return persona;
}

/**
 * The system-prompt block (issue #18's neighbour): the operator's prose,
 * plus the three limits that keep a voice from eating the protocol — the
 * fixed verbatims, relay fidelity, and the Slack shape of a reply.
 */
export function personaInstructions(persona: string): string {
  return `## Voice

The operator wrote how you sound. Apply it to every word you write in your own name:

${persona}

The voice never overrides the conduct rules in this prompt:
- Fixed lines stay fixed. The one-line dispatch ack, the gate and stall acks, and everything the daemon posts itself (cards, alerts, summaries) are protocol, not prose — never restyle them.
- Text you pass to a worker is not yours to style: a human's answer goes down verbatim (spec §6), whatever your voice would have made of it.
- Slack mrkdwn and short replies still apply — a voice is not a licence to write more.`;
}

/**
 * The register block inlined in BOTH worker briefs (requests.ts). It has to
 * live inside each brief, not around them: the coordinator copies only the
 * matching brief into `task-create --spec`, so anything outside it never
 * reaches the worker.
 *
 * The closing sentence is the guardrail. A worker's Slack-bound text is an
 * answer or a report, and a register tuned for short chat lines must not
 * cost it a file path, a line number or the caveat that something could not
 * be verified — the register is how it sounds, never what it leaves out.
 */
export function workerPersonaBrief(persona: string): string {
  return `Register for everything you send to Slack — your answer, your questions and your final report are posted to the requester as you wrote them, so write them like this:

${persona}

The register is tone only. Keep the answer's structure readable (Slack mrkdwn, code, bullets) and never drop a path, a number, a caveat or an unverified-thing note to sound more casual.`;
}
