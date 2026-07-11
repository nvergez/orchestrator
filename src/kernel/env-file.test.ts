import { describe, expect, it } from 'vitest';
import { parseEnvFile } from './env-file.ts';

describe('parseEnvFile', () => {
  it('keeps an empty value empty, so `KEY=` still reads as missing', () => {
    expect(parseEnvFile('SLACK_BOT_TOKEN=\n')).toEqual({ SLACK_BOT_TOKEN: '' });
  });

  it('ignores lines without an equals sign', () => {
    expect(parseEnvFile('garbage line\nKEY=value\n')).toEqual({ KEY: 'value' });
  });

  it('does not strip mismatched quotes', () => {
    expect(parseEnvFile(`KEY="value'`)).toEqual({ KEY: `"value'` });
  });
});
