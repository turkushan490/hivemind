import { toast } from './notify';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Calls the API. Failures show a toast unless `quiet` (the caller shows them itself). */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; quiet?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    const err = new ApiError("Can't reach the HiveMind server. Is the container running?", 0);
    if (!opts.quiet) toast(err.message);
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
    if (!opts.quiet && res.status !== 401) toast(data.problemId ? `${err.message} (problem #${data.problemId})` : err.message);
    throw err;
  }
  return data as T;
}
