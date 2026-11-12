import { describe, expect, it } from 'vitest';
import { isWav16k } from '../src/services/whisper.js';

/** A minimal PCM WAV header (+ a little silence) with these settings. */
function wav(rate: number, channels: number, bits = 16): Buffer {
  const data = Buffer.alloc(320);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE((rate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe('built-in whisper input check', () => {
  it('passes a 16 kHz mono 16-bit WAV as is, and sends everything else through ffmpeg', () => {
    expect(isWav16k(wav(16000, 1))).toBe(true);
    expect(isWav16k(wav(24000, 1))).toBe(false); // Kokoro / cloned voices
    expect(isWav16k(wav(16000, 2))).toBe(false);
    expect(isWav16k(wav(16000, 1, 32))).toBe(false);
    expect(isWav16k(Buffer.from('ID3\x04mp3 data that is long enough to pass the length check..'))).toBe(false);
    expect(isWav16k(Buffer.from('\x1aE\xdf\xa3 webm '.padEnd(60, 'x'), 'latin1'))).toBe(false);
  });
});
