/** Downloads keep one total deadline through headers and body, and cap streamed bytes. */
export async function downloadBoundedBuffer(url: string, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Attachment download failed (${response.status}).`);
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('Attachment exceeds the 25 MiB download limit.');
  }
  // Test adapters and empty-body responses can expose only arrayBuffer.
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('Attachment exceeds the download limit.');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Attachment exceeds the 25 MiB download limit.');
      }
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, total);
  } finally { reader.releaseLock(); }
}
