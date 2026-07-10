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
      className={`rounded-md border-l-4 bg-card p-3 ${
        escalation ? 'border-status-critical' : 'border-status-warning'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Badge variant={escalation ? 'critical' : 'warning'}>
          {escalation ? '‼ escalation' : '⧖ decision gate'}
        </Badge>
        {gate.worktreeName !== null && (
          <span className="font-mono text-xs text-muted-foreground">{gate.worktreeName}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          asked {ago(gate.relayedAt, asOf)}
        </span>
      </div>
      <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-border pl-3 text-sm">
        {gate.question}
      </blockquote>
      {gate.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
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
    <div className="rounded-md border-l-4 border-status-serious bg-card p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Badge variant="serious">⏸ stalled worker</Badge>
        {stall.worktreeName !== null && (
          <span className="font-mono text-xs text-muted-foreground">{stall.worktreeName}</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          alerted {ago(stall.alertedAt, asOf)}
        </span>
      </div>
      <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
        {stall.lastOutput}
      </pre>
    </div>
  );
}
