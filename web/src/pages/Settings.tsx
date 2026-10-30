import type { ReactNode } from 'react';
import { useStored } from '../stored';
import { Models } from './Models';
import { Providers } from './Providers';
import { BuilderSettings, HomeAssistantPanel, HuggingFacePanel, VoicePanel, MemorySettings, OpenAIApiSettings, SearchSettingsPanel, TrainingPanel } from './SettingsExtra';
import { Tokens } from './Tokens';
import { Users } from './Users';

type Role = 'admin' | 'user' | 'viewer';

const SECTIONS = {
  providers: 'AI providers',
  models: 'Download models',
  builder: 'Builder AI',
  search: 'Web search',
  memory: 'Memory',
  voice: 'Voice',
  homeassistant: 'Home Assistant',
  huggingface: 'Hugging Face',
  training: 'Training',
  users: 'Users',
  tokens: 'API tokens',
  api: 'OpenAI API',
} as const;
type Section = keyof typeof SECTIONS;

/** Viewers only get their API tokens; users everything but Users. */
const shown = (role: Role, s: Section) => (role === 'viewer' ? s === 'tokens' || s === 'api' : s !== 'users' || role === 'admin');

export function Settings({ role, meId, active, onWizard }: { role: Role; meId: string; active: boolean; onWizard: () => void }) {
  const [stored, setSection] = useStored<Section>('settings.section', 'providers');
  const isAdmin = role === 'admin';
  const section: Section = stored in SECTIONS && shown(role, stored) ? stored : role === 'viewer' ? 'tokens' : 'providers';
  const panel = (s: Section, node: ReactNode) => shown(role, s) && <div hidden={section !== s}>{node}</div>;
  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-48 md:flex-col">
        {(Object.keys(SECTIONS) as Section[])
          .filter((s) => shown(role, s))
          .map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`shrink-0 rounded-md px-3 py-2 text-left text-sm ${section === s ? 'bg-[#21262d] text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {SECTIONS[s]}
            </button>
          ))}
      </nav>
      <div className="min-w-0 flex-1">
        {/* All sections stay mounted, so switching never loses a search or a half-typed key. */}
        {panel('providers', <Providers isAdmin={isAdmin} />)}
        {panel('models', <Models active={active && section === 'models'} />)}
        {panel('builder', <BuilderSettings active={active && section === 'builder'} onWizard={onWizard} />)}
        {panel('search', <SearchSettingsPanel isAdmin={isAdmin} />)}
        {panel('memory', <MemorySettings active={active && section === 'memory'} />)}
        {panel('voice', <VoicePanel isAdmin={isAdmin} active={active && section === 'voice'} />)}
        {panel('homeassistant', <HomeAssistantPanel isAdmin={isAdmin} active={active && section === 'homeassistant'} />)}
        {panel('huggingface', <HuggingFacePanel isAdmin={isAdmin} active={active && section === 'huggingface'} />)}
        {panel('training', <TrainingPanel isAdmin={isAdmin} active={active && section === 'training'} />)}
        {panel('users', <Users meId={meId} active={active && section === 'users'} />)}
        {panel('tokens', <Tokens />)}
        {panel('api', <OpenAIApiSettings active={active && section === 'api'} onTokens={() => setSection('tokens')} />)}
      </div>
    </div>
  );
}
