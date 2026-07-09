// PROTOTYPE (#67) — throwaway. Staged into the packed tarball as
// src/prototype-crash.ts so both package shapes contain an identical module
// that throws through a few frames. Used to compare stack-trace quality:
// does the trace point at readable .ts source (shape A) or compiled .js
// (shape B, with/without --enable-source-maps)?

interface Frame {
  depth: number;
  label: string;
}

function innermost(frame: Frame): never {
  throw new Error(`prototype crash at depth ${frame.depth} (${frame.label})`);
}

function middle(frame: Frame): never {
  innermost({ ...frame, depth: frame.depth + 1 });
}

export function detonate(label: string): never {
  middle({ depth: 1, label });
}

detonate('pack-shape prototype');
