import { describe, expect, it } from 'vitest';
import { withoutOwnName } from '../src/nodes/index.js';
import { LiveText } from '../src/services/openaiCompat.js';

describe("a character's own name in front of its answer", () => {
  it('is cut off the answer, any case, also in bold; other names and "Jev" inside stay', () => {
    expect(withoutOwnName('Jev: The osan kamer lamp is off now.', 'jev')).toBe('The osan kamer lamp is off now.');
    expect(withoutOwnName('**Jev:** Done.', 'jev')).toBe('Done.');
    expect(withoutOwnName('Jarvis: hi', 'jev')).toBe('Jarvis: hi');
    expect(withoutOwnName('I told Jev: no.', 'jev')).toBe('I told Jev: no.');
    expect(withoutOwnName('Jev:', 'jev')).toBe('Jev:');
    expect(withoutOwnName('Jev: hi', undefined)).toBe('Jev: hi');
  });

  it('is not streamed: the first tokens wait until the name is clear', () => {
    const live = new LiveText('jev');
    const out = ['J', 'ev', ':', ' The lamp', ' is off.'].map((t) => live.push(t)).join('');
    expect(out).toBe('The lamp is off.');
    expect(live.finish('The lamp is off.')).toBe('');
    const other = new LiveText('jev');
    expect(['Je', 'ff is here'].map((t) => other.push(t)).join('')).toBe('Jeff is here');
  });
});
