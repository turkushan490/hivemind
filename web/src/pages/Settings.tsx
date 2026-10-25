import { useStored } from '../stored';
import { Models } from './Models';
import { Providers } from './Providers';
import { Tokens } from './Tokens';

const SECTIONS = { providers: 'AI providers', models: 'Download models', tokens: 'API tokens' } as const;
type Section = keyof typeof SECTIONS;

export function Settings({ isAdmin, active }: { isAdmin: boolean; active: boolean }) {
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
        <div hidden={section !== 'tokens'}>
          <Tokens />
        </div>
      </div>
    </div>
  );
}
