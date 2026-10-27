import { useStored } from '../stored';
import { Models } from './Models';
import { Providers } from './Providers';
import { BuilderSettings, MemorySettings, OpenAIApiSettings, SearchSettingsPanel } from './SettingsExtra';
import { Tokens } from './Tokens';

const SECTIONS = { providers: 'AI providers', models: 'Download models', builder: 'Builder AI', search: 'Web search', memory: 'Memory', tokens: 'API tokens', api: 'OpenAI API' } as const;
type Section = keyof typeof SECTIONS;

export function Settings({ isAdmin, active, onWizard }: { isAdmin: boolean; active: boolean; onWizard: () => void }) {
  const [section, setSection] = useStored<Section>('settings.section', 'providers');
  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <nav className="flex shrink-0 gap-1 md:w-48 md:flex-col">
        {(Object.keys(SECTIONS) as Section[]).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`rounded-md px-3 py-2 text-left text-sm ${section === s ? 'bg-[#21262d] text-white' : 'text-slate-400 hover:text-white'}`}
          >
            {SECTIONS[s]}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {/* All sections stay mounted, so switching never loses a search or a half-typed key. */}
        <div hidden={section !== 'providers'}>
          <Providers isAdmin={isAdmin} />
        </div>
        <div hidden={section !== 'models'}>
          <Models active={active && section === 'models'} />
        </div>
        <div hidden={section !== 'builder'}>
          <BuilderSettings active={active && section === 'builder'} onWizard={onWizard} />
        </div>
        <div hidden={section !== 'search'}>
          <SearchSettingsPanel isAdmin={isAdmin} />
        </div>
        <div hidden={section !== 'memory'}>
          <MemorySettings active={active && section === 'memory'} />
        </div>
        <div hidden={section !== 'tokens'}>
          <Tokens />
        </div>
        <div hidden={section !== 'api'}>
          <OpenAIApiSettings active={active && section === 'api'} onTokens={() => setSection('tokens')} />
        </div>
      </div>
    </div>
  );
}
