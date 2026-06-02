import { cacheGet, cacheSet } from '@/storage/cacheStore';

interface FetchOptions {
  cacheKey?: string;
  cacheTtlMs?: number;
  retries?: number;
  forceRefresh?: boolean;
}

const inflight = new Map<string, Promise<unknown>>();

export class RobloxHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string
  ) {
    super(`HTTP ${status}`);
    this.name = 'RobloxHttpError';
  }
}

export async function robloxFetch<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { cacheKey, cacheTtlMs = 60_000, retries = 3, forceRefresh = false } = opts;

  if (cacheKey && !forceRefresh) {
    const cached = await cacheGet<T>(cacheKey);
    if (cached !== null) return cached;
  }

  const dedupKey = cacheKey ?? url;
  const existing = inflight.get(dedupKey) as Promise<T> | undefined;
  if (existing) return existing;

  const p = (async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new RobloxHttpError(res.status, url);
          if (attempt < retries - 1) {
            await sleep(2 ** attempt * 500 + Math.random() * 250);
          }
          continue;
        }
        if (!res.ok) throw new RobloxHttpError(res.status, url);
        const data = (await res.json()) as T;
        if (cacheKey) await cacheSet(cacheKey, data, cacheTtlMs);
        return data;
      } catch (e) {
        lastErr = e;
        if (e instanceof RobloxHttpError) throw e;
        if (attempt < retries - 1) await sleep(2 ** attempt * 500);
      }
    }
    throw lastErr ?? new Error('robloxFetch failed');
  })();

  inflight.set(dedupKey, p);
  try {
    return await p;
  } finally {
    inflight.delete(dedupKey);
  }
}

export async function robloxPost<T>(
  url: string,
  body: unknown,
  opts: FetchOptions = {}
): Promise<T> {
  const { cacheKey, cacheTtlMs = 60_000, retries = 3 } = opts;

  if (cacheKey) {
    const cached = await cacheGet<T>(cacheKey);
    if (cached !== null) return cached;
  }

  const dedupKey = cacheKey ?? `${url}:${JSON.stringify(body)}`;
  const existing = inflight.get(dedupKey) as Promise<T> | undefined;
  if (existing) return existing;

  const p = (async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new RobloxHttpError(res.status, url);
          if (attempt < retries - 1) {
            await sleep(2 ** attempt * 500 + Math.random() * 250);
          }
          continue;
        }
        if (!res.ok) throw new RobloxHttpError(res.status, url);
        const data = (await res.json()) as T;
        if (cacheKey) await cacheSet(cacheKey, data, cacheTtlMs);
        return data;
      } catch (e) {
        lastErr = e;
        if (e instanceof RobloxHttpError) throw e;
        if (attempt < retries - 1) await sleep(2 ** attempt * 500);
      }
    }
    throw lastErr ?? new Error('robloxPost failed');
  })();

  inflight.set(dedupKey, p);
  try {
    return await p;
  } finally {
    inflight.delete(dedupKey);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
