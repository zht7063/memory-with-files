/** Raised as soon as more than the allowed number of bytes has arrived. */
export class StdinTooLarge extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`standard input is larger than ${limit} bytes`);
    this.name = 'StdinTooLarge';
    this.limit = limit;
  }
}

/**
 * Read a stream as UTF-8, counting bytes while it streams. The read stops, and the stream is
 * released (its iterator is closed, which destroys a process stdin), the moment the total passes
 * `maxBytes`, so an endless or huge pipe never has to be buffered to be refused.
 */
export async function readLimited(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new StdinTooLarge(maxBytes); // leaving the loop closes the stream
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
