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
});
