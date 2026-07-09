# PROTOTYPE — throwaway (#67, map #65)

**Do not merge.** This directory answers one question and then dies with its
branch: should the published `@nvergez/orchestrator` package ship the
TypeScript source directly (bin `src/index.ts`, Node ≥22.18 type stripping)
or a tsc-compiled `dist/`?

Run it (from the repo root, after `npm ci`, needs network):

```sh
node prototype-pack/run.mjs
```

It stages both package shapes under `.work/`, `npm pack`s each, installs each
tarball into a clean prefix, runs the `orc` bin (success = exit 1 at config
validation), and writes the comparison to [RESULTS.md](RESULTS.md). The
verdict lives in the #67 comment thread; nothing here is production code.
