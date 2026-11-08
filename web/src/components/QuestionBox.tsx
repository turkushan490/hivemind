import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { toast } from '../notify';
import { transcribe } from '../voice';

/**
 * The question with everything that can go with it: long text, pictures, PDFs and text files, and audio.
 * Pictures are uploaded to your files and go in as ![name](hm-file:…) — models that can see get the picture itself.
 * PDFs and text files go in as their text; audio as what was said in it (speech to text).
 */
export interface Attachment {
  id: string;
  name: string;
  kind: 'image' | 'text' | 'audio';
  /** What goes into the question for it. */
  text: string;
  /** Pictures: a link to show the thumbnail. */
  preview?: string;
  busy?: boolean;
}

const MAX_TEXT = 100_000;
const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|jsx|ts|tsx|py|java|c|cpp|h|cs|go|rs|rb|php|sh|ps1|yaml|yml|toml|ini|log|sql)$/i;

async function pdfText(file: File): Promise<string> {
  // Loaded only when needed: the PDF reader is big.
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  return pages.join('\n\n');
}

async function upload(file: File): Promise<string> {
  const safe = file.name.replace(/[^\w.-]+/g, '_') || 'picture.png';
  const res = await fetch(`/api/files?name=${encodeURIComponent(`uploads/${safe}`)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
  const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !data.path) throw new Error(data.error ?? `upload failed (HTTP ${res.status})`);
  return data.path;
}

const clip = (text: string, name: string) => {
  const t = text.replace(/\u0000/g, '').trim();
  if (t.length <= MAX_TEXT) return t;
  toast(`Only the first ${MAX_TEXT / 1000}k characters of ${name} are used`, 'info');
  return t.slice(0, MAX_TEXT);
};

/** The attachments of one question box. */
export function useAttachments() {
  const [list, setList] = useState<Attachment[]>([]);
  const patch = (id: string, p: Partial<Attachment> | null) => setList((l) => (p ? l.map((a) => (a.id === id ? { ...a, ...p } : a)) : l.filter((a) => a.id !== id)));

  const add = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const id = Math.random().toString(36).slice(2);
      const kind: Attachment['kind'] = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|flac)$/i.test(file.name) ? 'audio' : 'text';
      if (kind === 'text' && !file.name.toLowerCase().endsWith('.pdf') && !TEXT_FILE.test(file.name) && !file.type.startsWith('text/')) {
        toast(`${file.name}: pictures, PDFs, text/code files and audio can go with a question`, 'info');
        continue;
      }
      setList((l) => [...l, { id, name: file.name, kind, text: '', busy: true }]);
      void (async () => {
        try {
          if (kind === 'image') {
            const path = await upload(file);
            patch(id, { busy: false, text: `![${file.name}](hm-file:${path})`, preview: `/api/files/raw?inline=1&path=${encodeURIComponent(path)}` });
          } else if (kind === 'audio') {
            const said = await transcribe(file);
            patch(id, { busy: false, text: `--- Audio "${file.name}" (what is said in it) ---\n${clip(said, file.name)}` });
          } else {
            const text = clip(file.name.toLowerCase().endsWith('.pdf') ? await pdfText(file) : await file.text(), file.name);
            if (!text) throw new Error('no text found in it (a scanned PDF has only pictures)');
            patch(id, { busy: false, text: `--- File "${file.name}" ---\n${text}` });
          }
        } catch (err) {
          toast(`Could not add ${file.name}: ${(err as Error).message}`);
          patch(id, null);
        }
      })();
    }
  };

  return {
    list,
    add,
    remove: (id: string) => patch(id, null),
    clear: () => setList([]),
    busy: list.some((a) => a.busy),
    /** The question as it is sent: the text, then every attachment. */
    compose: (question: string) => [question.trim(), ...list.filter((a) => !a.busy && a.text).map((a) => a.text)].filter(Boolean).join('\n\n'),
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

const ICON: Record<Attachment['kind'], string> = { image: '🖼', text: '📄', audio: '🎵' };

/**
 * A text box that grows with what you type (Enter sends, Shift+Enter is a new line), a 📎 button, and attachments
 * by dropping or pasting them in.
 */
export function QuestionBox(p: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  attachments: Attachments;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
  /** Bigger text (the Use page). */
  big?: boolean;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const a = p.attachments;

  // Grows up to about 10 lines, then scrolls.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [p.value]);

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!p.disabled) p.onSubmit();
    }
  };
  const paste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      a.add(files);
    }
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer.files.length) a.add(e.dataTransfer.files);
  };

  return (
    <div
      className={`min-w-0 flex-1 rounded-md border bg-[#0d1117] ${drag ? 'border-indigo-400' : 'border-[#30363d]'} ${p.className ?? ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={drop}
    >
      {a.list.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
          {a.list.map((x) => (
            <span key={x.id} className="flex max-w-[220px] items-center gap-1 rounded bg-[#21262d] px-1.5 py-0.5 text-xs text-slate-300" title={x.name}>
              {x.preview ? <img src={x.preview} alt="" className="h-6 w-6 rounded object-cover" /> : <span>{ICON[x.kind]}</span>}
              <span className="truncate">{x.busy ? `${x.name} …` : x.name}</span>
              <button type="button" className="text-slate-500 hover:text-white" onClick={() => a.remove(x.id)} aria-label={`Remove ${x.name}`}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1">
        <textarea
          ref={box}
          rows={1}
          className={`min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-slate-100 outline-none placeholder:text-slate-500 ${p.big ? 'text-base' : 'text-sm'}`}
          placeholder={p.placeholder}
          value={p.value}
          onChange={(e) => p.onChange(e.target.value)}
          onKeyDown={keys}
          onPaste={paste}
          autoFocus={p.autoFocus}
        />
        <button
          type="button"
          className="mb-1 mr-1 shrink-0 rounded px-2 py-1 text-slate-400 hover:bg-[#21262d] hover:text-white"
          title="Add pictures, PDFs, text or code files, or audio (or drop / paste them here)"
          onClick={() => picker.current?.click()}
        >
          📎
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept="image/*,audio/*,.pdf,.txt,.md,.csv,.json,.html,.xml,.log,.py,.js,.ts,.tsx,.java,.c,.cpp,.cs,.go,.rs,.sh,.yaml,.yml,.sql"
          onChange={(e) => {
            if (e.target.files) a.add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
