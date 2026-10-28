import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/** Minimal ZIP writer/reader (deflate, no zip64): enough for exports of canvases and tasks. */

export interface ZipEntry {
  name: string;
  data: Buffer | string;
}

export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const packed = deflateRawSync(raw);
    // Store already-compressed data (images) as is when deflate doesn't help.
    const stored = packed.length >= raw.length;
    const body = stored ? raw : packed;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }

  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** Unpacked size limits, so a "zip bomb" can't fill the memory: per file and for the whole archive. */
export const ZIP_MAX_FILE = 300 * 1024 * 1024;
export const ZIP_MAX_TOTAL = 1024 * 1024 * 1024;

const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

/** Reads a ZIP made by HiveMind (or any plain deflate/stored ZIP). Damaged or oversized archives give a 400. */
export function readZip(buf: Buffer, limits = { file: ZIP_MAX_FILE, total: ZIP_MAX_TOTAL }): ZipEntry[] & { data: Buffer }[] {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0 || endAt + 22 > buf.length) throw bad('Not a ZIP file');
  // Every offset read from the archive is checked before it is used.
  const need = (at: number, len: number) => {
    if (at < 0 || at + len > buf.length) throw bad('Damaged ZIP file');
  };
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  let total = 0;
  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    need(p, 46);
    if (buf.readUInt32LE(p) !== 0x02014b50) throw bad('Damaged ZIP file');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    need(p + 46, nameLen);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    need(localAt, 30);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    need(dataAt, size);
    const body = buf.subarray(dataAt, dataAt + size);
    if (!name.endsWith('/')) {
      if (method !== 0 && method !== 8) throw bad(`Unsupported compression in ${name}`);
      const room = Math.min(limits.file, limits.total - total);
      let data: Buffer;
      try {
        data = method === 8 ? inflateRawSync(body, { maxOutputLength: Math.max(1, room) }) : Buffer.from(body);
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw bad(`The ZIP unpacks to more than allowed (${name})`);
        throw bad(`Damaged ZIP file (${name})`);
      }
      if (data.length > room) throw bad(`The ZIP unpacks to more than allowed (${name})`);
      total += data.length;
      out.push({ name, data });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
