import type { Canvas, CanvasGraph, ModelInfo, ModelRef, NodeConfig, NodeType, ProviderInfo } from '@hivemind/shared';
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api } from '../api';
import { downloadText } from '../components/AnswerView';
import { toast } from '../notify';
import { useReplay } from '../run/replay';
import { Clock, useRun } from '../run/state';
import { History, ReplayBar } from './Replay';
import { useStored } from '../stored';
import { HiveEdge } from './HiveEdge';
import { HiveNode, InputMic, RunViews, type HiveFlowNode } from './HiveNode';
import { BuilderPanel } from './BuilderPanel';
import { Inspector } from './Inspector';
import { COMING_SOON, NODE_META, PALETTE } from './meta';
import { newNodeId, TEMPLATE_GROUPS, TEMPLATES, type TemplateGroup } from './templates';

const nodeTypes = { hive: HiveNode };
const edgeTypes = { hive: HiveEdge };
const ACTIVE = new Set(['loading', 'thinking', 'streaming']);
const DRAFT_KEY = 'hm.canvas.draft';

const toFlow = (g: CanvasGraph): { nodes: HiveFlowNode[]; edges: Edge[] } => ({
  nodes: g.nodes.map((n) => ({ id: n.id, type: 'hive', position: n.position, data: { kind: n.type, label: n.label, config: n.config } })),
  edges: g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: 'hive' })),
});

const toGraph = (nodes: HiveFlowNode[], edges: Edge[]): CanvasGraph => ({
  nodes: nodes.map((n) => ({
    id: n.id,
    type: n.data.kind,
    label: n.data.label,
    position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    config: n.data.config,
  })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
});

interface Draft {
  id?: string;
  name: string;
  graph: CanvasGraph;
  saved?: string;
}

function loadDraft(): Draft | undefined {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Draft) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Models to prefill a template with, so it runs right away: the three smallest local models as members
 * (fast), the largest one under 10 GB as judge (smartest that still fits). Cloud models fill gaps.
 * Ollama cloud stubs (a few KB on disk) are skipped.
 */
/** A good default image model: a realistic SDXL one when present, else the first image model. */
function pickImageModel(all: ModelInfo[]): ModelRef | undefined {
  const img = all.filter((m) => m.kind === 'image');
  const m = img.find((x) => /epicrealism|juggernaut|realvis|cyberrealistic/i.test(x.model)) ?? img[0];
  return m && { providerId: m.providerId, model: m.model };
}

function prefillModels(all: ModelInfo[]): (ModelRef | undefined)[] {
  const ms = all.filter((m) => !m.kind);
  const ref = (m: ModelInfo): ModelRef => ({ providerId: m.providerId, model: m.model });
  const local = ms.filter((m) => m.sizeBytes !== undefined && m.sizeBytes > 50e6).sort((a, b) => a.sizeBytes! - b.sizeBytes!);
  const cloud = ms.filter((m) => m.sizeBytes === undefined);
  const members = [...local, ...cloud].slice(0, 3);
  const judge = [...local].reverse().find((m) => m.sizeBytes! < 10e9) ?? cloud[0] ?? members.at(-1);
  if (!members.length) return [];
  return [members[0], members[1] ?? members[0], members[2] ?? members[0], judge ?? members[0]].map(ref);
}

export function CanvasPage(props: { active: boolean; onProblem: () => void }) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor({ active, onProblem }: { active: boolean; onProblem: () => void }) {
  const flow = useReactFlow<HiveFlowNode, Edge>();
  const initial = useRef(loadDraft());
  const [nodes, setNodes, onNodesChange] = useNodesState<HiveFlowNode>(initial.current ? toFlow(initial.current.graph).nodes : []);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.current ? toFlow(initial.current.graph).edges : []);
  const [doc, setDoc] = useState<{ id?: string; name: string }>({ id: initial.current?.id, name: initial.current?.name ?? 'My canvas' });
  // The graph as last saved, to know if there are unsaved changes.
  const [saved, setSaved] = useState<string | undefined>(initial.current?.saved);
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [question, setQuestion] = useStored('canvas.question', '');
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateGroup, setTemplateGroup] = useStored<TemplateGroup>('canvas.templateGroup', 'Everyday');
  const run = useRun(onProblem);
  const replay = useReplay();
  const replaying = !!replay.run;
  // While replaying, the canvas shows the replayed run; your own canvas waits here untouched.
  const backup = useRef<{ nodes: HiveFlowNode[]; edges: Edge[]; doc: { id?: string; name: string }; saved?: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showFile, setShowFile] = useState(false);
  const [panel, setPanel] = useStored<'inspector' | 'builder'>('canvas.panel', 'inspector');
  /** Canvases before each Builder change, for Undo. */
  const undoStack = useRef<{ nodes: HiveFlowNode[]; edges: Edge[] }[]>([]);
  const views = replaying ? replay.views : run.views;
  const shownFinal = replaying ? replay.final : run.final;
  const shownErrors = replaying ? replay.errors : run.errors;

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const graphJson = useMemo(() => JSON.stringify(graph), [graph]);
  const dirty = saved !== JSON.stringify({ name: doc.name, graph: JSON.parse(graphJson) });

  const loadLists = useCallback(async () => {
    const [m, p, c] = await Promise.all([
      api<{ models: ModelInfo[] }>('/api/models', { quiet: true }).catch(() => ({ models: [] })),
      api<ProviderInfo[]>('/api/providers', { quiet: true }).catch(() => []),
      api<Canvas[]>('/api/canvases', { quiet: true }).catch(() => []),
    ]);
    setModels(m.models);
    setProviders(p);
    setCanvases(c);
    return m.models;
  }, []);

  // First open: lists, and a council template when there is nothing to show yet.
  useEffect(() => {
    if (!active) return;
    loadLists().then((ms) => {
      if (!initial.current && nodes.length === 0) applyTemplate('council', ms, true);
    });
    // The canvas has no size while its tab is hidden; fit again once it is visible.
    const t = setTimeout(() => flow.fitView({ padding: 0.2 }), 80);
    return () => clearTimeout(t);
  }, [active]);

  // Every change is kept as a local draft, so nothing is lost on reload or tab switch.
  useEffect(() => {
    if (replaying) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ id: doc.id, name: doc.name, graph: JSON.parse(graphJson), saved } satisfies Draft));
    } catch {}
  }, [graphJson, doc, saved, replaying]);

  const confirmDiscard = () => !dirty || nodes.length === 0 || confirm('You have unsaved changes on this canvas. Throw them away?');

  const show = (g: CanvasGraph) => {
    const f = toFlow(g);
    setNodes(f.nodes);
    setEdges(f.edges);
    run.reset();
    setTimeout(() => flow.fitView({ padding: 0.2, duration: 300 }), 50);
  };

  const enterReplay = async (id: string) => {
    setShowHistory(false);
    if (run.running) return toast('Wait until the current run is finished', 'info');
    try {
      const data = await replay.open(id);
      const g = data.events.find((e) => e.type === 'run_start')?.graph;
      if (!g) {
        replay.close();
        return toast('This run has nothing to replay', 'info');
      }
      if (!backup.current) backup.current = { nodes, edges, doc, saved };
      followed.current = '';
      show(g);
      // Start after the canvas has been fitted, so the camera can follow from the first block.
      setTimeout(() => replay.setPlaying(true), 700);
    } catch {}
  };

  const exitReplay = () => {
    replay.close();
    const b = backup.current;
    backup.current = null;
    if (b) {
      setNodes(b.nodes);
      setEdges(b.edges);
      setDoc(b.doc);
      setSaved(b.saved);
    }
    setTimeout(() => flow.fitView({ padding: 0.2, duration: 400 }), 50);
  };

  /** Keep the replayed canvas as a new, unsaved canvas to edit. */
  const editCopy = () => {
    const b = backup.current;
    const bDirty = b && b.saved !== JSON.stringify({ name: b.doc.name, graph: toGraph(b.nodes, b.edges) });
    if (bDirty && !confirm('Your canvas has unsaved changes. Replace it with this run’s canvas?')) return;
    backup.current = null;
    replay.close();
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
    setDoc({ name: `Copy of run: ${replay.run?.question.slice(0, 30) ?? ''}` });
    setSaved(undefined);
  };

  function applyTemplate(id: string, ms = models, skipConfirm = false) {
    if (!skipConfirm && !confirmDiscard()) return;
    const t = TEMPLATES.find((x) => x.id === id)!;
    const refs = prefillModels(ms);
    show(t.build({ text: refs.slice(0, 3), judge: refs[3], image: pickImageModel(ms) }));
    setDoc({ name: t.name });
    setSaved(undefined);
    setShowTemplates(false);
  }

  const openCanvas = (c: Canvas) => {
    if (!confirmDiscard()) return;
    show({ nodes: c.nodes, edges: c.edges });
    setDoc({ id: c.id, name: c.name });
    setSaved(JSON.stringify({ name: c.name, graph: { nodes: c.nodes, edges: c.edges } }));
  };

  const save = async (shared?: boolean) => {
    const name = doc.name.trim() || 'My canvas';
    const c = await api<Canvas>(`/api/canvases${doc.id ? `/${doc.id}` : ''}`, { method: 'PUT', body: { name, ...graph, ...(shared !== undefined && { shared }) } });
    setDoc({ id: c.id, name: c.name });
    setSaved(JSON.stringify({ name: c.name, graph: { nodes: c.nodes, edges: c.edges } }));
    setCanvases(await api<Canvas[]>('/api/canvases', { quiet: true }).catch(() => canvases));
    toast(shared === undefined ? `Saved "${c.name}"` : c.shared ? `Saved "${c.name}" — everyone can use it now` : `Saved "${c.name}" — only you can use it now`, 'ok');
  };
  // Canvases others shared show up in Use mode, not here: only your own can be edited.
  const mine = canvases.filter((c) => c.mine !== false);
  const sharedNow = !!canvases.find((c) => c.id === doc.id)?.shared;

  const remove = async () => {
    if (!doc.id || !confirm(`Delete the canvas "${doc.name}"?`)) return;
    await api(`/api/canvases/${doc.id}`, { method: 'DELETE' });
    setDoc({ name: doc.name });
    setSaved(undefined);
    setCanvases((l) => l.filter((c) => c.id !== doc.id));
    toast('Canvas deleted (still open as an unsaved copy)', 'info');
  };

  // Ctrl+S saves.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save().catch(() => {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- Wiring ----
  const wouldLoop = (source: string, target: string) => {
    // Walking forward from the target: reaching the source again means a cycle.
    const seen = new Set<string>();
    const stack = [target];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === source) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.filter((e) => e.source === id).forEach((e) => stack.push(e.target));
    }
    return false;
  };
  const isValidConnection = (c: Connection | Edge) =>
    !!c.source && !!c.target && c.source !== c.target && !edges.some((e) => e.source === c.source && e.target === c.target) && !wouldLoop(c.source, c.target);
  const onConnect = (c: Connection) => {
    if (replaying) return;
    if (!isValidConnection(c)) return toast('That wire would make a loop', 'info');
    setEdges((es) => addEdge({ ...c, id: `${c.source}->${c.target}`, type: 'hive' }, es));
  };

  // ---- Adding blocks ----
  const addNode = (kind: NodeType, position?: { x: number; y: number }) => {
    if (kind === 'input' && nodes.some((n) => n.data.kind === 'input')) return toast('A canvas has one Question block', 'info');
    // Clicked (not dropped): start at the middle of the view and step down until no block is in the way.
    let pos = position ?? flow.screenToFlowPosition({ x: window.innerWidth / 2 - 120, y: window.innerHeight / 2 - 60 });
    if (!position) {
      const taken = (p: { x: number; y: number }) => nodes.some((n) => Math.abs(n.position.x - p.x) < 250 && Math.abs(n.position.y - p.y) < 110);
      for (let i = 0; i < 20 && taken(pos); i++) pos = { x: pos.x + (i % 2 ? 40 : 0), y: pos.y + 120 };
    }
    const id = newNodeId(kind);
    // New blocks reuse the last model of the same kind: image blocks an image model, Decide a decision model, the rest a text model.
    const modelKind = (k: NodeType) => (k === 'image' ? 'image' : k === 'decide' ? 'decision' : 'text');
    const firstDecision = models.find((m) => m.kind === 'decision');
    const lastModel =
      [...nodes].reverse().find((n) => n.data.config.model && modelKind(n.data.kind) === modelKind(kind))?.data.config.model ??
      (kind === 'image' ? pickImageModel(models) : kind === 'decide' && firstDecision ? { providerId: firstDecision.providerId, model: firstDecision.model } : undefined);
    const meta = NODE_META[kind];
    const config: NodeConfig = meta.usesModel && lastModel ? { model: lastModel } : {};
    // Debate / Vote start with fast models filled in; change them in the inspector.
    if (meta.multiModel) {
      const picks = prefillModels(models);
      config.models = [...new Map(picks.slice(0, 3).map((m) => [`${m!.providerId}|${m!.model}`, m!])).values()].slice(0, Math.max(meta.multiModel, 2));
    }
    if (kind === 'memory') config.key = 'default';
    if (kind === 'decide') config.questions = [{ name: 'spam', type: 'noul', instructions: 'Is this spam?' }];
    // With a decision provider, new Routers decide with Jev: much faster and nearly free.
    if (kind === 'router' && firstDecision) Object.assign(config, { decideWith: 'jev', decider: { providerId: firstDecision.providerId, model: firstDecision.model } });
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id, type: 'hive', position: pos, selected: true, data: { kind, config } }]);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData('application/hivemind') as NodeType;
    if (kind) addNode(kind, flow.screenToFlowPosition({ x: e.clientX - 120, y: e.clientY - 40 }));
  };

  const selected = nodes.find((n) => n.selected);
  const updateNode = (id: string, patch: { label?: string; config?: Partial<NodeConfig> }) =>
    setNodes((ns) =>
      ns.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...(patch.label !== undefined && { label: patch.label }), config: { ...n.data.config, ...patch.config } } } : n,
      ),
    );

  // ---- Running ----
  const startRun = async (q = question) => {
    followed.current = '';
    if (!q.trim()) return toast('Type a question first', 'info');
    const input = nodes.find((n) => n.data.kind === 'input');
    if (!input) return toast('Add a Question block', 'info');
    if (!edges.some((e) => e.source === input.id)) return toast('Wire the Question block to something', 'info');
    const noModel = nodes.filter((n) => {
      const c = n.data.config;
      const optional = (n.data.kind === 'llm' && !!c.auto) || (n.data.kind === 'router' && c.decideWith === 'jev' && !!c.decider);
      return NODE_META[n.data.kind].usesModel && !c.model && !optional;
    });
    if (noModel.length) {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === noModel[0].id })));
      return toast(`Pick a model for "${noModel[0].data.label || NODE_META[noModel[0].data.kind].title}"`, 'info');
    }
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
    try {
      await run.start({ question: q.trim(), graph, canvasId: doc.id });
    } catch {}
  };

  // The mic on the Question block: what was said becomes the question, and the canvas runs.
  const startRunRef = useRef(startRun);
  startRunRef.current = startRun;
  const runningRef = useRef(false);
  runningRef.current = run.running || replaying;
  const onSpoken = useCallback(
    (text: string) => {
      setQuestion(text);
      if (runningRef.current) return toast('A run is going: the question is filled in, press Run when it is done', 'info');
      startRunRef.current(text);
    },
    [setQuestion],
  );

  // Camera follows the block that is working, then shows the whole canvas when the run ends.
  const [follow, setFollow] = useStored('canvas.follow', true);
  const followed = useRef('');
  useEffect(() => {
    if (!follow || (!run.runId && !replaying)) return;
    const activeId = Object.entries(views).find(([, v]) => ACTIVE.has(v.state))?.[0];
    if (activeId && activeId !== followed.current) {
      const node = flow.getNode(activeId);
      if (!node) return;
      followed.current = activeId;
      const w = node.measured?.width ?? 256;
      const h = node.measured?.height ?? 160;
      flow.setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1.15, duration: 900 });
    } else if (!activeId && shownFinal && followed.current !== 'all') {
      followed.current = 'all';
      flow.fitView({ duration: 900, padding: 0.2 });
    }
  }, [views, shownFinal, follow, replaying]);

  return (
    <div className="flex h-[calc(100vh-88px)] min-h-[520px] flex-col overflow-hidden rounded-lg border border-[#30363d]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#30363d] bg-[#161b22] px-3 py-2">
        <input
          className="input w-48 py-1 font-semibold"
          value={doc.name}
          onChange={(e) => setDoc((d) => ({ ...d, name: e.target.value }))}
          aria-label="Canvas name"
        />
        {dirty && !replaying && <span className="text-xs text-amber-400" title="Kept as a draft in this browser until you save">unsaved</span>}
        <button className="btn-ghost" onClick={() => save().catch(() => {})} title="Ctrl+S">
          Save
        </button>
        <select
          className="input w-auto py-1"
          value=""
          onChange={(e) => {
            const c = canvases.find((x) => x.id === e.target.value);
            if (c) openCanvas(c);
          }}
        >
          <option value="">Open… ({mine.length})</option>
          {mine.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.shared ? ' (shared)' : ''}
            </option>
          ))}
        </select>
        <div className="relative">
          <button className="btn-ghost" onClick={() => setShowFile((s) => !s)} disabled={replaying}>
            File ▾
          </button>
          {showFile && (
            <div className="absolute z-40 mt-1 w-64 space-y-0.5 rounded-lg border border-[#30363d] bg-[#161b22] p-1 shadow-xl" onMouseLeave={() => setShowFile(false)}>
              <button
                className="block w-full rounded px-3 py-2 text-left text-sm hover:bg-[#21262d]"
                onClick={() => {
                  setShowFile(false);
                  // The canvas as it is on screen, saved or not.
                  downloadText(`${doc.name || 'canvas'}.hivemind.json`, JSON.stringify({ hivemind: 1, type: 'canvas', name: doc.name, ...graph }, null, 2), 'application/json');
                }}
              >
                Export this canvas
                <span className="block text-xs text-slate-500">a .hivemind.json file to share or back up</span>
              </button>
              <a className="block rounded px-3 py-2 text-sm hover:bg-[#21262d]" href="/api/export/canvases.zip" onClick={() => setShowFile(false)}>
                Export all canvases
                <span className="block text-xs text-slate-500">one ZIP with every saved canvas</span>
              </a>
              <label className="block cursor-pointer rounded px-3 py-2 text-sm hover:bg-[#21262d]">
                Import canvases…
                <span className="block text-xs text-slate-500">.hivemind.json or ZIP — added as new canvases</span>
                <input
                  type="file"
                  className="hidden"
                  accept=".json,.zip,application/json,application/zip"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    setShowFile(false);
                    if (!f) return;
                    const zip = f.name.toLowerCase().endsWith('.zip');
                    const res = await fetch('/api/import/canvases', {
                      method: 'POST',
                      headers: { 'content-type': zip ? 'application/zip' : 'application/json' },
                      body: zip ? f : await f.text(),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) return toast(data.error ?? `Import failed (HTTP ${res.status})`);
                    const created = data.created as { id: string; name: string }[];
                    const list = await api<Canvas[]>('/api/canvases', { quiet: true }).catch(() => canvases);
                    setCanvases(list);
                    toast(`Imported ${created.length} canvas${created.length === 1 ? '' : 'es'}`, 'ok');
                    const first = list.find((c) => c.id === created[0]?.id);
                    if (first) openCanvas(first);
                  }}
                />
              </label>
            </div>
          )}
        </div>
        <div className="relative">
          <button className="btn-ghost" onClick={() => setShowHistory((s) => !s)}>
            History ▾
          </button>
          {showHistory && <History onPick={enterReplay} onClose={() => setShowHistory(false)} />}
        </div>
        <div className="relative">
          <button className="btn-ghost" disabled={replaying} onClick={() => setShowTemplates((s) => !s)}>
            New ▾
          </button>
          {showTemplates && (
            <div className="absolute z-30 mt-1 w-[520px] rounded-lg border border-[#30363d] bg-[#161b22] shadow-xl">
              <div className="flex flex-wrap gap-1 border-b border-[#30363d] p-2">
                {TEMPLATE_GROUPS.map((g) => (
                  <button
                    key={g}
                    className={`rounded-full px-3 py-1 text-xs ${templateGroup === g ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-[#21262d]'}`}
                    onClick={() => setTemplateGroup(g)}
                  >
                    {g}
                  </button>
                ))}
              </div>
              <div className="grid max-h-[60vh] grid-cols-2 gap-1 overflow-y-auto p-2">
                {TEMPLATES.filter((t) => t.group === templateGroup).map((t) => {
                  const noImage = t.needsImage && !models.some((m) => m.kind === 'image');
                  return (
                    <button
                      key={t.id}
                      className="rounded-lg border border-[#30363d] px-3 py-2 text-left hover:border-indigo-500 hover:bg-[#21262d]"
                      onClick={() => applyTemplate(t.id)}
                    >
                      <div className="text-sm font-medium">{t.name}</div>
                      <div className="text-xs text-slate-400">{t.description}</div>
                      {noImage && <div className="mt-1 text-[11px] text-amber-300">Needs an image model: add ComfyUI in Settings</div>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        {doc.id && (
          <button
            className={`btn-ghost ${sharedNow ? 'border-emerald-700 text-emerald-300' : ''}`}
            title={sharedNow ? 'Everyone (also viewers) can use this canvas in Use mode and through the API. Click to make it private (saves).' : 'Let everyone (also viewers) use this canvas in Use mode and through the API — it runs with your AI providers. Saves the canvas.'}
            onClick={() => save(!sharedNow).catch(() => {})}
          >
            {sharedNow ? 'Shared' : 'Share'}
          </button>
        )}
        {doc.id && (
          <button className="btn-ghost text-red-400" onClick={() => remove().catch(() => {})}>
            Delete
          </button>
        )}
        {replaying ? (
          <div className="ml-auto flex min-w-[320px] flex-1 basis-[420px] items-center gap-2 overflow-hidden rounded-md border border-violet-700 bg-violet-950/40 px-3 py-1.5 text-sm">
            <span className="shrink-0 font-semibold text-violet-200">Replay</span>
            <span className="min-w-0 flex-1 truncate text-slate-300" title={replay.run!.question}>“{replay.run!.question}”</span>
            <button className="btn-ghost shrink-0" onClick={editCopy} title="Open this run’s canvas for editing">
              Edit a copy
            </button>
            <button className="btn shrink-0" onClick={exitReplay}>
              Exit replay
            </button>
          </div>
        ) : (
        <div className="ml-auto flex min-w-[320px] flex-1 items-center gap-2">
          <input
            className="input py-1"
            placeholder="Ask this canvas a question…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !run.running && startRun()}
          />
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-slate-400" title="The view glides to the block that is working">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
          </label>
          {run.running ? (
            <button className="btn bg-red-600 hover:bg-red-500" onClick={run.cancel}>
              Stop
            </button>
          ) : (
            <button className="btn" onClick={() => startRun()}>
              Run
            </button>
          )}
        </div>
        )}
      </div>

      {run.connLost && run.running && (
        <div role="alert" className="bg-amber-900/60 px-3 py-1 text-center text-xs text-amber-100">
          Lost the live connection to this run. Reconnecting… the run keeps going on the server.
        </div>
      )}

      <Clock.Provider value={replaying ? replay.now : Date.now}>
      <div className="flex min-h-0 flex-1">
        <aside className={`w-52 shrink-0 space-y-4 overflow-y-auto border-r border-[#30363d] bg-[#11161d] p-3 ${replaying ? 'pointer-events-none opacity-40' : ''}`}>
          <div className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">Drag onto the canvas</div>
          {PALETTE.map((g) => (
          <div key={g.group} className="space-y-1.5">
            <div className="text-xs font-semibold text-slate-500">{g.group}</div>
            {g.types.map((kind) => {
              const m = NODE_META[kind];
              return (
                <button
                  key={kind}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/hivemind', kind);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => addNode(kind)}
                  title={m.description}
                  className="flex w-full cursor-grab items-center gap-2 rounded-lg border border-[#30363d] bg-[#161b22] px-2.5 py-2 text-left text-sm hover:border-slate-500 active:cursor-grabbing"
                >
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: m.color }} />
                  {m.title}
                </button>
              );
            })}
          </div>
          ))}
          {COMING_SOON.map((g) => (
            <div key={g.group} className="space-y-1">
              <div className="text-xs font-semibold text-slate-500">
                {g.group} <span className="font-normal">· coming soon</span>
              </div>
              {g.items.map((i) => (
                <div key={i} className="rounded-lg border border-dashed border-[#30363d] px-2.5 py-1.5 text-xs text-slate-600">
                  {i}
                </div>
              ))}
            </div>
          ))}
        </aside>

        <div className="relative min-w-0 flex-1" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
          <InputMic.Provider value={onSpoken}>
          <RunViews.Provider value={views}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              edgeTypes={edgeTypes}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodesConnectable={!replaying}
              isValidConnection={isValidConnection}
              onPaneClick={() => setShowTemplates(false)}
              colorMode="dark"
              fitView
              fitViewOptions={{ padding: 0.2 }}
              deleteKeyCode={replaying ? null : ['Backspace', 'Delete']}
              defaultEdgeOptions={{ type: 'hive' }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#30363d" />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor={(n) => NODE_META[(n as HiveFlowNode).data.kind]?.color ?? '#444'} maskColor="rgba(13,17,23,0.7)" />
            </ReactFlow>
          </RunViews.Provider>
          </InputMic.Provider>
          {replaying && <ReplayBar replay={replay} />}
        </div>

        <aside className="flex w-96 shrink-0 flex-col border-l border-[#30363d] bg-[#11161d]">
          <div className="flex shrink-0 border-b border-[#30363d] text-sm">
            {(['inspector', 'builder'] as const).map((t) => (
              <button
                key={t}
                className={`flex-1 px-3 py-2 ${panel === t ? 'border-b-2 border-indigo-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                onClick={() => setPanel(t)}
              >
                {t === 'inspector' ? 'Inspector' : '✨ Builder'}
              </button>
            ))}
          </div>
          <div className={`min-h-0 flex-1 overflow-y-auto ${panel === 'builder' ? 'hidden' : ''}`}>
          <Inspector
            node={selected}
            view={selected ? views[selected.id] : undefined}
            models={models}
            providers={providers}
            onChange={(patch) => selected && !replaying && updateNode(selected.id, patch)}
            onDelete={() => selected && !replaying && flow.deleteElements({ nodes: [{ id: selected.id }] })}
            final={shownFinal}
            errors={shownErrors}
            running={run.running || (replaying && replay.playing)}
            runId={replaying ? replay.run!.id : run.final ? run.runId : undefined}
          />
          </div>
          <div className={`min-h-0 flex-1 ${panel === 'builder' ? '' : 'hidden'}`}>
            <BuilderPanel
              graph={graph}
              models={models}
              providers={providers}
              disabled={replaying}
              onApply={(g) => {
                undoStack.current.push({ nodes: nodes.map((n) => ({ ...n, selected: false })), edges });
                show(g);
              }}
              onUndo={
                undoStack.current.length
                  ? () => {
                      const prev = undoStack.current.pop();
                      if (prev) {
                        setNodes(prev.nodes);
                        setEdges(prev.edges);
                        setTimeout(() => flow.fitView({ padding: 0.2, duration: 300 }), 50);
                      }
                    }
                  : undefined
              }
            />
          </div>
        </aside>
      </div>
      </Clock.Provider>
    </div>
  );
}
