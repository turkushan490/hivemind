import { describe, expect, it } from 'vitest';
import { createZip, readZip } from '../src/services/zip.js';

describe('zip', () => {
  it('round-trips text, unicode names and binary data', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: 300 }, (_, i) => (i * 37) % 256)]);
    const zip = createZip([
      { name: 'answer.md', data: '# Answer\n'.repeat(50) },
      { name: 'blocks/1-Judge ✓.md', data: 'merged' },
      { name: 'files/image.png', data: png },
    ]);
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
    const back = readZip(zip);
    expect(back.map((e) => e.name)).toEqual(['answer.md', 'blocks/1-Judge ✓.md', 'files/image.png']);
    expect(back[0].data.toString()).toBe('# Answer\n'.repeat(50));
    expect(Buffer.compare(back[2].data as Buffer, png)).toBe(0);
  });

  it('rejects things that are not ZIP files', () => {
    expect(() => readZip(Buffer.from('hello'))).toThrow(/Not a ZIP/);
  });

  it('refuses a zip bomb instead of unpacking it', () => {
    const zip = createZip([{ name: 'big.txt', data: Buffer.alloc(5 * 1024 * 1024) }]);
    expect(zip.length).toBeLessThan(100_000);
    expect(() => readZip(zip, { file: 1024 * 1024, total: 10 * 1024 * 1024 })).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/more than allowed/) }));
    const two = createZip([
      { name: 'a.txt', data: Buffer.alloc(3 * 1024 * 1024) },
      { name: 'b.txt', data: Buffer.alloc(3 * 1024 * 1024) },
    ]);
    expect(() => readZip(two, { file: 4 * 1024 * 1024, total: 5 * 1024 * 1024 })).toThrow(/more than allowed \(b\.txt\)/);
  });

  it('gives a 400 for damaged offsets', () => {
    const zip = createZip([{ name: 'a.txt', data: 'hello' }]);
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    zip.writeUInt32LE(0xfffffff0, end + 16);
    expect(() => readZip(zip)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
