import { useEffect, useState, type DragEvent } from 'react';
import { api } from '../api';
import { fileUrl, SitePreview } from '../components/AnswerView';
import { toast } from '../notify';

interface FileEntry {
  path: string;
  size: number;
  modified: string;
  kind: 'image' | 'text' | 'html' | 'pdf' | 'other';
}

const ICON: Record<FileEntry['kind'], string> = { image: '🖼️', text: '📄', html: '🌐', pdf: '📕', other: '📦' };
const size = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

/** The files folder (appdata/hivemind/files): drop files in for your canvases, get what blocks saved. */
export function FilesPage({ active }: { active: boolean }) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<FileEntry | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);

  const load = () => api<FileEntry[]>('/api/files', { quiet: true }).then(setFiles).catch(() => {});
  useEffect(() => {
    if (active) load();
  }, [active]);

  useEffect(() => {
    setText(null);
    if (open && (open.kind === 'text' || open.kind === 'html')) fetch(fileUrl(open.path)).then((r) => r.text()).then((t) => setText(t.slice(0, 200_000)));
  }, [open?.path]);

  const upload = async (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      setUploading((n) => n + 1);
      try {
        const res = await fetch(`/api/files?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        toast(`Uploaded ${f.name}`, 'ok');
      } catch (err) {
        toast(`Could not upload ${f.name}: ${(err as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    load();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
  };

  const shown = files.filter((f) => f.path.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
      <div className="space-y-3">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center text-sm ${dragging ? 'border-indigo-400 bg-indigo-500/10' : 'border-[#30363d] text-slate-400 hover:border-slate-500'}`}
        >
          <input type="file" multiple className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />
          <span className="text-2xl">⬆️</span>
          {uploading ? `Uploading ${uploading}…` : 'Drop files here or click to upload'}
          <span className="mt-1 text-xs text-slate-500">Stored in appdata/hivemind/files · what blocks save goes to outputs/</span>
        </label>
        <input className="input" placeholder={`Search ${files.length} files…`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="card max-h-[60vh] space-y-0.5 overflow-y-auto p-1">
          {shown.length === 0 && <p className="p-3 text-sm text-slate-500">No files yet.</p>}
          {shown.map((f) => (
            <button
              key={f.path}
              onClick={() => setOpen(f)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${open?.path === f.path ? 'bg-indigo-500/15' : 'hover:bg-[#21262d]'}`}
            >
              <span>{ICON[f.kind]}</span>
              <span className="min-w-0 flex-1 truncate" title={f.path}>
                {f.path}
              </span>
              <span className="shrink-0 text-xs text-slate-500">{size(f.size)}</span>
              <span className="hidden shrink-0 text-xs text-slate-600 sm:inline">{new Date(f.modified).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card min-h-[300px] space-y-3">
        {!open ? (
          <p className="text-sm text-slate-500">Pick a file to preview it.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium" title={open.path}>
                {open.path}
              </span>
              <a className="btn-ghost" href={fileUrl(open.path, false)}>
                Download
              </a>
              <button
                className="btn-ghost text-red-400"
                onClick={async () => {
                  if (!confirm(`Delete ${open.path}?`)) return;
                  await api(`/api/files?path=${encodeURIComponent(open.path)}`, { method: 'DELETE' });
                  setOpen(null);
                  load();
                }}
              >
                Delete
              </button>
            </div>
            {open.kind === 'image' && <img src={fileUrl(open.path)} alt="" className="max-h-[70vh] w-full rounded-md object-contain" />}
            {open.kind === 'pdf' && <iframe title="PDF" src={fileUrl(open.path)} className="h-[70vh] w-full rounded-md bg-white" />}
            {open.kind === 'html' && text !== null && <SitePreview html={text} height={560} />}
            {open.kind === 'text' && text !== null && <pre className="max-h-[70vh] overflow-auto rounded-md bg-[#0d1117] p-3 text-xs text-slate-300">{text}</pre>}
            {open.kind === 'other' && <p className="text-sm text-slate-500">No preview for this type — download it.</p>}
          </>
        )}
      </div>
    </div>
  );
}
