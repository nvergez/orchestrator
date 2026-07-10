import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**'] },
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
              group: ['../daemon/*', '../delegation/*'],
              message: 'cli/ statically imports only kernel/ — daemon loads via the lazy dynamic import in cli.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/daemon/**/*.ts'],
    ignores: ['src/daemon/daemon.ts'], // the composition root wires the clusters by value
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../delegation/*'],
              allowTypeImports: true,
              message: 'daemon/ ↔ delegation/ value edges live only in the composition root daemon.ts.',
            },
            { group: ['../cli/*'], message: 'daemon/ must not import cli/.' },
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
              message: 'daemon/ ↔ delegation/ value edges live only in the composition root daemon.ts.',
            },
            { group: ['../cli/*'], message: 'delegation/ must not import cli/.' },
          ],
        },
      ],
    },
  },
);
