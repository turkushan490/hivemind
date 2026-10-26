import type { FastifyInstance } from 'fastify';
import { createReadStream, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { cleanName, deleteFile, listFiles, safePath, writeUnique } from '../services/files.js';
import { requireUser } from './auth.js';

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.zip': 'application/zip',
};

export function fileRoutes(app: FastifyInstance) {
  // Uploads arrive as the raw file body.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 200 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get('/api/files', { preHandler: requireUser }, async () => listFiles());

  /** Body: the file. ?name=folder/file.ext — an existing name gets " (2)" added. */
  app.post('/api/files', { preHandler: requireUser, bodyLimit: 200 * 1024 * 1024 }, async (req, reply) => {
    const name = String((req.query as { name?: string }).name ?? '');
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Send the file as application/octet-stream' });
    const parts = name.split('/').map(cleanName);
    return { path: writeUnique(parts.join('/'), req.body) };
  });

  /** Download (or ?inline=1 to show in the browser: images, PDFs, previews). HTML is always served as a download here. */
  app.get('/api/files/raw', { preHandler: requireUser }, async (req, reply) => {
    const { path, inline } = req.query as { path?: string; inline?: string };
    const full = safePath(path ?? '');
    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      return reply.code(404).send({ error: 'File not found' });
    }
    const ext = extname(full).toLowerCase();
    // HTML from models is shown only inside the sandboxed preview (as text), never as a page on this origin.
    const type = ext === '.html' || ext === '.htm' ? 'text/plain; charset=utf-8' : (MIME[ext] ?? 'application/octet-stream');
    const disposition = inline === '1' ? 'inline' : 'attachment';
    reply
      .header('content-type', type)
      .header('content-length', size)
      .header('x-content-type-options', 'nosniff');
    // Nothing from the folder may run scripts on this origin (PDFs keep the browser's own viewer).
    if (ext !== '.pdf') reply.header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(basename(full))}`);
    return reply.send(createReadStream(full));
  });

  app.delete('/api/files', { preHandler: requireUser }, async (req) => {
    deleteFile(String((req.query as { path?: string }).path ?? ''));
    return { ok: true };
  });
}
