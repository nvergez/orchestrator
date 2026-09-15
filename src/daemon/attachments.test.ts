import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Attachments } from './attachments.ts';
import type { SlackFile } from './filter.ts';
import type { FileDownloader } from './slack-download.ts';
import type { ThreadContext } from './thread-context.ts';
import { createLogger } from '../kernel/logger.ts';

const CHANNEL = 'C0EXAMPLE123';
const THREAD = '1751970000.000100';
const USER = 'U0ALLOWED';

const stateDirs: string[] = [];
afterEach(() => { for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const make = (download: FileDownloader, enabled = true) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'orc-attachments-'));
  stateDirs.push(stateDir);
  const notices: string[] = [];
  const attachments = new Attachments({
    stateDir, enabled, download, logger: createLogger('silent'),
    notify: (_channelId, _threadTs, text) => { notices.push(text); return Promise.resolve(); },
  });
  return { attachments, notices, stateDir };
};

const document = (id: string, name = `${id}.md`): SlackFile =>
  ({ id, name, mimetype: 'text/markdown', url_private: `https://files.slack.com/${id}` });

const bodies = (contents: Record<string, string>): FileDownloader =>
  (url) => Promise.resolve(Buffer.from(contents[url.split('/').pop() ?? ''] ?? ''));

const context = (files: ThreadContext['files']): ThreadContext => ({ lines: ['> <@U_COLLEAGUE>: see this'], files, dropped: false });

describe('document attachments', () => {
  it('inlines a document under the instruction and keeps its path for the worker', async () => {
    const { attachments, stateDir } = make(bodies({ F_SPEC: '# Spec\n\nShip the thing.' }));
    const turn = await attachments.prepare(THREAD, CHANNEL, USER, 'do this', [document('F_SPEC')]);
    const path = join(stateDir, 'attachments', CHANNEL, THREAD, 'F_SPEC.md');
    expect(turn.text).toContain(`[Document 1 — F_SPEC.md, from <@${USER}>, saved at ${path}]`);
    expect(turn.text).toContain('[Begin document 1 — F_SPEC.md]\n# Spec\n\nShip the thing.\n[End document 1]');
    expect(turn.text.indexOf('do this')).toBeLessThan(turn.text.indexOf('[Begin document 1'));
    expect(turn.images).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('# Spec\n\nShip the thing.');
  });

  it('shares one turn-wide inline budget, so a third full document is noted rather than shown', async () => {
    const full = 'x'.repeat(32 * 1024);
    const { attachments, notices } = make(bodies({ F_ONE: full, F_TWO: full, F_THREE: full }));
    const turn = await attachments.prepare(THREAD, CHANNEL, USER, 'read these',
      [document('F_ONE'), document('F_TWO'), document('F_THREE')]);
    expect(turn.text).toContain('[Begin document 1 — F_ONE.md]');
    expect(turn.text).toContain('[Begin document 2 — F_TWO.md]');
    expect(turn.text).not.toContain('[Begin document 3');
    expect(turn.text).toContain('F_THREE.md: turn document limit (8 files / 64 KiB)');
    expect(turn.text).not.toContain('showing the first');
    expect(notices[0]).toContain('F_THREE.md: turn document limit');
  });

  it('cuts a document at the budget and says how much of it the turn holds', async () => {
    const { attachments, stateDir } = make(bodies({ F_LOG: 'y'.repeat(40 * 1024) }));
    const turn = await attachments.prepare(THREAD, CHANNEL, USER, 'why', [document('F_LOG', 'run.log')]);
    expect(turn.text).toContain('run.log, from <@U0ALLOWED>, saved at');
    expect(turn.text).toContain('showing the first 32768 of 40960 characters');
    expect(turn.text).toContain(`[Begin document 1 — run.log]\n${'y'.repeat(32 * 1024)}\n[End document 1]`);
    expect(readFileSync(join(stateDir, 'attachments', CHANNEL, THREAD, 'F_LOG.log'), 'utf8')).toHaveLength(40 * 1024);
  });

  it('takes at most eight documents in one turn', async () => {
    const ids = Array.from({ length: 9 }, (_, index) => `F_${index}`);
    const { attachments } = make(bodies(Object.fromEntries(ids.map((id) => [id, id]))));
    const turn = await attachments.prepare(THREAD, CHANNEL, USER, 'all of them', ids.map((id) => document(id)));
    expect(turn.text).toContain('[Begin document 8 — F_7.md]');
    expect(turn.text).not.toContain('[Begin document 9');
    expect(turn.text).toContain('F_8.md: turn document limit (8 files / 64 KiB)');
  });

  it('falls back to the Slack filetype when the upload carries no extension', async () => {
    const { attachments, stateDir } = make(bodies({ F_SNIP: 'pasted notes' }));
    const turn = await attachments.prepare(THREAD, CHANNEL, USER, '', [
      { id: 'F_SNIP', name: 'pasted', filetype: 'markdown', url_private: 'https://files.slack.com/F_SNIP' },
    ]);
    expect(turn.text).toContain('The message carried only the file(s) below.');
    expect(turn.text).toContain('[Begin document 1 — pasted]\npasted notes\n[End document 1]');
    expect(readFileSync(join(stateDir, 'attachments', CHANNEL, THREAD, 'F_SNIP.markdown'), 'utf8')).toBe('pasted notes');
  });

  it('rejects a binary wearing a text extension after reading its bytes', async () => {
    const { attachments, notices } = make(() => Promise.resolve(Buffer.from('PK\u0003\u0004\u0000\u0000')));
    const turn = await attachments.prepare(THREAD, CHANNEL, USER, 'look', [document('F_ZIP', 'bundle.txt')]);
    expect(turn.text).toContain('bundle.txt: not a text file');
    expect(turn.text).not.toContain('[Begin document');
    expect(notices[0]).toBe('⚠️ Skipped attachments: bundle.txt: not a text file.');
  });

  it('quotes a thread-context document with its author, after the mention’s own', async () => {
    const { attachments } = make(bodies({ F_MINE: 'mine', F_THEIRS: 'theirs' }));
    const turn = await attachments.prepare(THREAD, CHANNEL, USER, 'compare these', [document('F_MINE')],
      context([{ file: document('F_THEIRS'), userId: 'U_COLLEAGUE' }]));
    expect(turn.text).toContain('> [Document 2 — F_THEIRS.md, from <@U_COLLEAGUE>, saved at');
    expect(turn.text.indexOf('[Begin document 1 — F_MINE.md]')).toBeLessThan(turn.text.indexOf('[Begin document 2 — F_THEIRS.md]'));
    expect(turn.text).toContain('[End thread context. Mentioning message follows.]');
  });

  it('refuses documents without files:read and never touches the network', async () => {
    let downloads = 0;
    const { attachments, notices } = make(() => { downloads += 1; return Promise.resolve(Buffer.from('x')); }, false);
    const turn = await attachments.prepare(THREAD, CHANNEL, USER, 'read it', [document('F_SPEC')]);
    expect(downloads).toBe(0);
    expect(turn.text).toContain('F_SPEC.md: files:read missing — add the scope and reinstall the app');
    expect(notices[0]).toContain('reinstall the app');
  });
});
