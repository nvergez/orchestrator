import { Badge } from './ui/badge';

const KNOWN_STATES = {
  active: { variant: 'good', label: '● daemon active' },
  inactive: { variant: 'serious', label: '■ daemon stopped' },
  failed: { variant: 'critical', label: '✗ daemon FAILED' },
} as const;

/** "All quiet" and "daemon is down" must never be confusable (issue #87). */
export function DaemonStatus({ unitState }: { unitState: string }) {
  const known = (KNOWN_STATES as Record<string, (typeof KNOWN_STATES)[keyof typeof KNOWN_STATES]>)[
    unitState
  ];
  if (known !== undefined) {
    return <Badge variant={known.variant}>{known.label}</Badge>;
  }
  return <Badge variant="warning">? daemon {unitState}</Badge>;
}
