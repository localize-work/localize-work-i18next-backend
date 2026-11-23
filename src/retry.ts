/**
 * How long to wait before retrying a request: the server's `Retry-After`
 * (seconds or an HTTP date) when it sent one, else exponential backoff.
 */
export function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(date - Date.now(), 0);
  }
  return 250 * 2 ** attempt;
}
