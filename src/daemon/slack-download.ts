import type { ReadableStreamDefaultReader } from 'node:stream/web';

/** Hard limits also apply when Slack's metadata under-reports the body. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export type FileDownloader = (url: string) => Promise<Uint8Array>;

export class ImageDownloadError extends Error {
  readonly reason: 'too large' | 'files:read missing — add the scope and reinstall the app';

  constructor(reason: ImageDownloadError['reason']) {
    super(reason);
    this.reason = reason;
  }
}

/** Never send credentials to an arbitrary host, including through redirects. */
function slackFileUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['files.slack.com', 'files-origin.slack.com'].includes(url.hostname)) {
    throw new Error('Not a Slack file URL');
  }
  return url;
}

export function slackFileDownloader(token: string): FileDownloader {
  return async (value) => {
    let url = slackFileUrl(value);
    const signal = AbortSignal.timeout(15_000);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new Error('File redirect has no location');
        url = slackFileUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403) throw new ImageDownloadError('files:read missing — add the scope and reinstall the app');
        throw new Error(`File download returned HTTP ${response.status}`);
      }
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
        await response.body?.cancel();
        throw new ImageDownloadError('too large');
      }
      if (!response.body) throw new Error('File download returned no body');
      const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_IMAGE_BYTES) throw new ImageDownloadError('too large');
          chunks.push(value);
        }
        return Buffer.concat(chunks, size);
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    throw new Error('Too many file redirects');
  };
}
