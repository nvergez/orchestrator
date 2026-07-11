import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * Status variants tint a border/text over a faint wash, never color alone —
 * every badge carries its word, so state survives grayscale and
 * colorblindness.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'border-border text-muted-foreground',
        accent: 'border-accent/40 bg-accent/10 text-accent',
        good: 'border-status-good/40 bg-status-good/10 text-status-good',
        warning: 'border-status-warning/50 bg-status-warning/10 text-status-warning',
        serious: 'border-status-serious/45 bg-status-serious/10 text-status-serious',
        critical: 'border-status-critical/45 bg-status-critical/10 text-status-critical',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
