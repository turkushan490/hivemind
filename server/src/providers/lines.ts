/** Splits a streamed HTTP body into lines (works for NDJSON and SSE). */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const part of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(part, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      yield line;
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}

/** Yields the parsed JSON of each `data:` line of an SSE stream, stopping at [DONE]. */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncIterable<any> {
  for await (const line of readLines(body)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') return;
    yield JSON.parse(data);
  }
}
