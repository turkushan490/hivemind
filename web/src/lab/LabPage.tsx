import type { ProviderInfo } from '@hivemind/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStored } from '../stored';
import { DatasetsPanel } from './DatasetsPanel';
import { NewModel } from './NewModel';

/**
 * The Training Lab: datasets and new models made from them. Simulating, reviewing and scoring D&D games is done by
 * DungeonMind itself; it fills its datasets and starts training here over the API.
 */

const TABS = { train: 'New model', data: 'Datasets' } as const;
type LabTab = keyof typeof TABS;

export function LabPage({ active }: { active: boolean }) {
  const [stored, setTab] = useStored<LabTab>('lab.tab', 'train');
  // An older browser may still remember a tab that is gone (the D&D simulator or scoreboard).
  const tab: LabTab = stored in TABS ? stored : 'train';
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    if (!active) return;
    api<ProviderInfo[]>('/api/providers', { quiet: true }).then(setProviders).catch(() => {});
  }, [active]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">
          Training Lab <span className="text-sm font-normal text-slate-400">· make your own AI models</span>
        </h2>
        <nav className="flex gap-1 rounded-lg bg-[#161b22] p-0.5">
          {(Object.keys(TABS) as LabTab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 text-sm ${tab === t ? 'bg-indigo-500/25 text-indigo-100' : 'text-slate-400 hover:text-white'}`}>
              {TABS[t]}
            </button>
          ))}
        </nav>
      </div>
      <div hidden={tab !== 'data'}>{tab === 'data' && <DatasetsPanel />}</div>
      <div hidden={tab !== 'train'}>{tab === 'train' && <NewModel active={active} providers={providers} onDatasets={() => setTab('data')} />}</div>
    </div>
  );
}
