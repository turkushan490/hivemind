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
import { toast } from '../notify';
import { useRun } from '../run/state';
import { useStored } from '../stored';
import { HiveEdge } from './HiveEdge';
import { HiveNode, RunViews, type HiveFlowNode } from './HiveNode';
import { Inspector } from './Inspector';
import { COMING_SOON, NODE_META } from './meta';
import { newNodeId, TEMPLATES } from './templates';

const nodeTypes = { hive: HiveNode };
const edgeTypes = { hive: HiveEdge };
const PALETTE: NodeType[] = ['input', 'llm', 'review', 'judge', 'output'];
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
function prefillModels(ms: ModelInfo[]): (ModelRef | undefined)[] {
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
  const run = useRun(onProblem);

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
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ id: doc.id, name: doc.name, graph: JSON.parse(graphJson), saved } satisfies Draft));
    } catch {}
  }, [graphJson, doc, saved]);

  const confirmDiscard = () => !dirty || nodes.length === 0 || confirm('You have unsaved changes on this canvas. Throw them away?');

  const show = (g: CanvasGraph) => {
    const f = toFlow(g);
    setNodes(f.nodes);
    setEdges(f.edges);
    run.reset();
    setTimeout(() => flow.fitView({ padding: 0.2, duration: 300 }), 50);
  };

  function applyTemplate(id: string, ms = models, skipConfirm = false) {
    if (!skipConfirm && !confirmDiscard()) return;
    const t = TEMPLATES.find((x) => x.id === id)!;
    show(t.build(prefillModels(ms)));
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

  const save = async () => {
    const name = doc.name.trim() || 'My canvas';
    const c = await api<Canvas>(`/api/canvases${doc.id ? `/${doc.id}` : ''}`, { method: 'PUT', body: { name, ...graph } });
    setDoc({ id: c.id, name: c.name });
    setSaved(JSON.stringify({ name: c.name, graph: { nodes: c.nodes, edges: c.edges } }));
    setCanvases(await api<Canvas[]>('/api/canvases', { quiet: true }).catch(() => canvases));
    toast(`Saved "${c.name}"`, 'ok');
  };

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
    const lastModel = [...nodes].reverse().find((n) => n.data.config.model)?.data.config.model;
    const config: NodeConfig = NODE_META[kind].usesModel && lastModel ? { model: lastModel } : {};
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
  const startRun = async () => {
    followed.current = '';
    if (!question.trim()) return toast('Type a question first', 'info');
    const input = nodes.find((n) => n.data.kind === 'input');
    if (!input) return toast('Add a Question block', 'info');
    if (!edges.some((e) => e.source === input.id)) return toast('Wire the Question block to something', 'info');
    const noModel = nodes.filter((n) => NODE_META[n.data.kind].usesModel && !n.data.config.model);
    if (noModel.length) {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === noModel[0].id })));
      return toast(`Pick a model for "${noModel[0].data.label || NODE_META[noModel[0].data.kind].title}"`, 'info');
    }
    setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
    try {
      await run.start({ question: question.trim(), graph, canvasId: doc.id });
    } catch {}
  };

  // Camera follows the block that is working, then shows the whole canvas when the run ends.
  const [follow, setFollow] = useStored('canvas.follow', true);
  const followed = useRef('');
  useEffect(() => {
    if (!follow || !run.runId) return;
    const activeId = Object.entries(run.views).find(([, v]) => ACTIVE.has(v.state))?.[0];
    if (activeId && activeId !== followed.current) {
      const node = flow.getNode(activeId);
      if (!node) return;
      followed.current = activeId;
      const w = node.measured?.width ?? 256;
      const h = node.measured?.height ?? 160;
      flow.setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1.15, duration: 900 });
    } else if (!activeId && run.final && followed.current !== 'all') {
      followed.current = 'all';
      flow.fitView({ duration: 900, padding: 0.2 });
    }
  }, [run.views, run.final, follow]);

  return (
    <div className="flex h-[calc(100vh-88px)] min-h-[520px] flex-col overflow-hidden rounded-lg border border-[#30363d]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[#30363d] bg-[#161b22] px-3 py-2">
        <input
          className="input w-48 py-1 font-semibold"
          value={doc.name}
          onChange={(e) => setDoc((d) => ({ ...d, name: e.target.value }))}
          aria-label="Canvas name"
        />
        {dirty && <span className="text-xs text-amber-400" title="Kept as a draft in this browser until you save">unsaved</span>}
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
          <option value="">Open… ({canvases.length})</option>
          {canvases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="relative">
          <button className="btn-ghost" onClick={() => setShowTemplates((s) => !s)}>
            New ▾
          </button>
          {showTemplates && (
            <div className="absolute z-30 mt-1 w-72 space-y-1 rounded-lg border border-[#30363d] bg-[#161b22] p-2 shadow-xl">
              {TEMPLATES.map((t) => (
                <button key={t.id} className="w-full rounded px-2 py-1.5 text-left hover:bg-[#21262d]" onClick={() => applyTemplate(t.id)}>
                  <div className="text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-slate-400">{t.description}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        {doc.id && (
          <button className="btn-ghost text-red-400" onClick={() => remove().catch(() => {})}>
            Delete
          </button>
        )}
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
            <button className="btn" onClick={startRun}>
              Run
            </button>
          )}
        </div>
      </div>

      {run.connLost && run.running && (
        <div role="alert" className="bg-amber-900/60 px-3 py-1 text-center text-xs text-amber-100">
          Lost the live connection to this run. Reconnecting… the run keeps going on the server.
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="w-52 shrink-0 space-y-4 overflow-y-auto border-r border-[#30363d] bg-[#11161d] p-3">
          <div className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">Drag onto the canvas</div>
          <div className="space-y-1.5">
            {PALETTE.map((kind) => {
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
          <RunViews.Provider value={run.views}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              edgeTypes={edgeTypes}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onPaneClick={() => setShowTemplates(false)}
              colorMode="dark"
              fitView
              fitViewOptions={{ padding: 0.2 }}
              deleteKeyCode={['Backspace', 'Delete']}
              defaultEdgeOptions={{ type: 'hive' }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#30363d" />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor={(n) => NODE_META[(n as HiveFlowNode).data.kind]?.color ?? '#444'} maskColor="rgba(13,17,23,0.7)" />
            </ReactFlow>
          </RunViews.Provider>
        </div>

        <aside className="w-96 shrink-0 overflow-y-auto border-l border-[#30363d] bg-[#11161d]">
          <Inspector
            node={selected}
            view={selected ? run.views[selected.id] : undefined}
            models={models}
            providers={providers}
            onChange={(patch) => selected && updateNode(selected.id, patch)}
            onDelete={() => selected && flow.deleteElements({ nodes: [{ id: selected.id }] })}
            final={run.final}
            errors={run.errors}
            running={run.running}
          />
        </aside>
      </div>
    </div>
  );
}
