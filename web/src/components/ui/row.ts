/**
 * The shared delegation/history list-row shape: full-bleed hover surface,
 * hairline separators, identity left / metadata right. One definition so a
 * row-style tweak never needs synchronized edits.
 */
export const listRow =
  '-mx-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border-t border-border/70 px-2 py-2 text-sm transition-colors first:border-t-0 hover:bg-muted/60';
