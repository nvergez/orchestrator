import type { GateView, StallView } from '../api';
import { ago } from '../lib/time';
import { Badge } from './ui/badge';

/**
 * Pending gates and stall alerts — the "needs a human" strip. An escalation
 * outranks a decision gate visually (critical vs warning), and both quote
 * the worker verbatim: the relay fidelity rule extends to this page.
 */

export function GateCallout({ gate, asOf }: { gate: GateView; asOf: string }) {
  const escalation = gate.kind === 'escalation';
  return (
    <div
      className={`animate-enter rounded-lg border-l-4 bg-card p-3.5 shadow-lift ${
        escalation ? 'border-status-critical' : 'border-status-warning'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Badge variant={escalation ? 'critical' : 'warning'}>
          {escalation ? '‼ escalation' : '⧖ decision gate'}
        </Badge>
        {gate.worktreeName !== null && (
          <span className="font-mono text-2xs text-muted-foreground">{gate.worktreeName}</span>
        )}
        <span className="ml-auto text-2xs text-muted-foreground tabular-nums">
          asked {ago(gate.relayedAt, asOf)}
        </span>
      </div>
      <blockquote className="mt-2.5 border-l-2 border-border pl-3 text-sm leading-relaxed whitespace-pre-wrap">
        {gate.question}
      </blockquote>
      {gate.options.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {gate.options.map((option) => (
            <Badge key={option}>{option}</Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function StallCallout({ stall, asOf }: { stall: StallView; asOf: string }) {
  return (
    <div className="animate-enter rounded-lg border-l-4 border-status-serious bg-card p-3.5 shadow-lift">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Badge variant="serious">⏸ stalled worker</Badge>
        {stall.worktreeName !== null && (
          <span className="font-mono text-2xs text-muted-foreground">{stall.worktreeName}</span>
        )}
        <span className="ml-auto text-2xs text-muted-foreground tabular-nums">
          alerted {ago(stall.alertedAt, asOf)}
        </span>
      </div>
      <pre className="mt-2.5 max-h-40 overflow-auto rounded-md bg-muted p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {stall.lastOutput}
      </pre>
    </div>
  );
}
