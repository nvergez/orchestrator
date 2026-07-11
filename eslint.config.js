import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // web/ is the frontend workspace — its own toolchain (Vite + tsc) gates
  // it; the root lint covers the daemon package only.
  { ignores: ['node_modules/**', 'dist/**', 'web/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Architecture boundaries — the tree mirrors the import DAG. Static
  // imports only; the one sanctioned daemon edge from cli/ is the lazy
  // `import('../daemon/daemon.ts')` in cli.ts, which these rules ignore
  // by design: `orc --version`/`doctor` must never load the Slack stack.
  {
    files: ['src/kernel/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../*'], message: 'kernel/ imports nothing outside kernel/.' }] },
      ],
    },
  },
  {
    files: ['src/cli/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../daemon/*', '../delegation/*', '../dashboard/*'],
              message: 'cli/ statically imports only kernel/ — daemon and dashboard load via the lazy dynamic imports in cli.ts.',
            },
          ],
        },
      ],
    },
  },
  // The dashboard sidecar reads the SQLite file the stores maintain, never
  // the store clusters themselves (ADR 0002: read-only, its own process).
  // Two exemptions construct the real stores to populate a database the
  // way the daemon would: the HTTP-seam suite, and the demo-state builder
  // it shares — dev-only code the published build excludes.
  {
    files: ['src/dashboard/**/*.ts'],
    ignores: ['src/dashboard/server.test.ts', 'src/dashboard/demo-state.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../daemon/*', '../delegation/*'],
              allowTypeImports: true,
              message: 'dashboard/ reads the database file directly — only the HTTP-seam tests and the demo-state builder construct the real stores.',
            },
            { group: ['../cli/*'], message: 'dashboard/ must not import cli/.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/daemon/**/*.ts'],
    // The composition root wires the clusters by value; its composition
    // tests (runtime.test.ts, app.test.ts) drive that same real graph.
    ignores: [
      'src/daemon/runtime.ts',
      'src/daemon/runtime.test.ts',
      'src/daemon/app.test.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../delegation/*'],
              allowTypeImports: true,
              message: 'daemon/ ↔ delegation/ value edges live only in the composition root runtime.ts.',
            },
            { group: ['../cli/*'], message: 'daemon/ must not import cli/.' },
            { group: ['../dashboard/*'], message: 'the dashboard is a sidecar, never a daemon endpoint (ADR 0002).' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/delegation/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../daemon/*'],
              allowTypeImports: true,
              message: 'daemon/ ↔ delegation/ value edges live only in the composition root runtime.ts.',
            },
            { group: ['../cli/*'], message: 'delegation/ must not import cli/.' },
            { group: ['../dashboard/*'], message: 'the dashboard is a sidecar, never a daemon endpoint (ADR 0002).' },
          ],
        },
      ],
    },
  },
);
