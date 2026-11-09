import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { toast } from '../notify';

interface Robot {
  id: string;
  name: string;
  board?: string;
  room?: string;
  homeSsids: string[];
  wifi: { ssid: string }[];
  online: boolean;
  lastSeen?: string;
  battery?: number;
  firmware?: string;
  ip?: string;
  ssid?: string;
  configVersion: number;
  firmwareTarget?: string;
}

interface InstallerApp {
  app: string;
  githubRepo?: string;
  versions: { version: string; added: string; notes?: string; files: { name: string; size: number }[] }[];
}

const BOARDS: [string, string][] = [
  ['cores3', 'M5Stack CoreS3'],
  ['t-dongle-s3', 'LilyGO T-Dongle-S3'],
  ['sticks3', 'M5Stack StickS3'],
];

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n > 10 * 1024 * 1024 ? 0 : 1)} MB`;
const ago = (iso?: string) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

/**
 * Settings → Robots & installers (admins): HiveBot robots (each with its own token, online/battery/firmware from
 * its heartbeat), installing a robot from the browser (flash over USB, then send Wi-Fi, address, token and PIN),
 * and the apps that work with HiveMind (HiveBot.exe, robot firmware) to download.
 */
export function RobotsPanel({ active }: { active: boolean }) {
  const [robots, setRobots] = useState<Robot[]>([]);
  const [urls, setUrls] = useState<{ home?: string; public?: string }>({});
  const [apps, setApps] = useState<InstallerApp[]>([]);
  const [firmwareApp, setFirmwareApp] = useState('hivebot-robot');
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [form, setForm] = useState({ name: '', board: 'cores3', ssid: '', pass: '' });

  const load = async () => {
    const r = await api<{ robots: Robot[]; urls: typeof urls }>('/api/robots', { quiet: true }).catch(() => null);
    if (r) {
      setRobots(r.robots);
      setUrls(r.urls);
    }
    const i = await api<{ apps: InstallerApp[]; firmwareApp: string }>('/api/installers', { quiet: true }).catch(() => null);
    if (i) {
      setApps(i.apps);
      setFirmwareApp(i.firmwareApp);
    }
  };
  useEffect(() => {
    if (!active) return;
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [active]);

  const add = async () => {
    try {
      const r = await api<{ robot: Robot; token: string }>('/api/robots', {
        body: { name: form.name, board: form.board, ...(form.ssid && { homeSsids: [form.ssid], wifi: [{ ssid: form.ssid, pass: form.pass }] }) },
      });
      setFresh({ name: r.robot.name, token: r.token });
      setForm({ ...form, name: '', pass: '' });
      await load();
    } catch {}
  };

  const fw = apps.find((a) => a.app === firmwareApp);
  return (
    <div className="max-w-3xl space-y-4">
      <div className="card space-y-3">
        <h2 className="font-semibold">Robots</h2>
        <p className="text-sm text-slate-400">
          HiveBot robots. Each one has its own token: it may only report in, get its settings, listen and speak, and talk to the HiveBot workflows. Remove a robot and its token stops
          working.
        </p>
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Address at home (LAN)</span>
            <input className="input" placeholder="http://192.168.1.10:4820" defaultValue={urls.home ?? ''} onBlur={(e) => api('/api/settings/robot-urls', { method: 'PUT', body: { home: e.target.value } }).catch(() => {})} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-slate-400">Address away (HTTPS)</span>
            <input className="input" placeholder="https://hivemind.example.com" defaultValue={urls.public ?? ''} onBlur={(e) => api('/api/settings/robot-urls', { method: 'PUT', body: { public: e.target.value } }).catch(() => {})} />
          </label>
        </div>
        {robots.length === 0 && <p className="text-sm text-slate-500">No robots yet.</p>}
        {robots.map((r) => (
          <div key={r.id} className="space-y-1 rounded-md border border-[#30363d] p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${r.online ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <b>{r.name}</b>
              <span className="text-xs text-slate-500">
                {[BOARDS.find((b) => b[0] === r.board)?.[1] ?? r.board, r.firmware && `firmware ${r.firmware}`, r.battery !== undefined && `🔋 ${Math.round(r.battery)}%`, r.ssid && `Wi-Fi ${r.ssid}`, r.ip, `seen ${ago(r.lastSeen)}`]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {r.board && fw?.versions.some((v) => v.files.some((f) => f.name === `${r.board}-firmware.bin`)) && (
                <select
                  className="input w-auto py-0.5 text-xs"
                  value={r.firmwareTarget ?? ''}
                  title="The robot downloads this firmware at its next check"
                  onChange={async (e) => {
                    await api(`/api/robots/${r.id}`, { method: 'PATCH', body: { firmwareTarget: e.target.value } }).catch(() => {});
                    toast(e.target.value ? `${r.name} updates to ${e.target.value} at its next check` : `${r.name} follows the newest firmware`, 'ok');
                    await load();
                  }}
                >
                  <option value="">Firmware: newest</option>
                  {fw.versions
                    .filter((v) => v.files.some((f) => f.name === `${r.board}-firmware.bin`))
                    .map((v) => (
                      <option key={v.version} value={v.version}>
                        Firmware: {v.version}
                      </option>
                    ))}
                </select>
              )}
              <button
                className="btn-ghost px-2 py-0.5 text-xs"
                onClick={async () => {
                  if (!confirm(`A new token for ${r.name}? The robot stops working until it has the new one.`)) return;
                  const t = await api<{ token: string }>(`/api/robots/${r.id}/token`, { method: 'POST' }).catch(() => null);
                  if (t) setFresh({ name: r.name, token: t.token });
                }}
              >
                New token
              </button>
              <button
                className="btn-ghost px-2 py-0.5 text-xs text-red-400"
                onClick={async () => {
                  if (!confirm(`Remove ${r.name}? Its token stops working.`)) return;
                  await api(`/api/robots/${r.id}`, { method: 'DELETE' }).catch(() => {});
                  await load();
                }}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <div className="grid gap-2 text-sm sm:grid-cols-[1fr_10rem]">
          <input className="input" placeholder="Name, e.g. desk-bot" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select className="input" value={form.board} onChange={(e) => setForm({ ...form, board: e.target.value })}>
            {BOARDS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <input className="input" placeholder="Home Wi-Fi name (optional)" value={form.ssid} onChange={(e) => setForm({ ...form, ssid: e.target.value })} />
          <input className="input" type="password" placeholder="Wi-Fi password" value={form.pass} onChange={(e) => setForm({ ...form, pass: e.target.value })} />
        </div>
        <button className="btn" disabled={!form.name.trim()} onClick={add}>
          Add robot
        </button>
        {fresh && (
          <div className="rounded-md border border-amber-700 bg-amber-950/40 p-2 text-sm">
            Token for <b>{fresh.name}</b>, shown only now: <code className="break-all">{fresh.token}</code>
            <p className="mt-1 text-xs text-slate-400">Install the robot below and it gets this token by itself, or type it on the robot&apos;s serial console: <code>token …</code></p>
          </div>
        )}
      </div>

      <FlashRobot firmwareApp={firmwareApp} hasFirmware={(board) => !!fw?.versions.some((v) => v.files.some((f) => f.name === `${board}-firmware.bin`))} urls={urls} token={fresh?.token} />

      <div className="card space-y-3">
        <h2 className="font-semibold">Installers</h2>
        <p className="text-sm text-slate-400">
          Apps that work with HiveMind, kept inside HiveMind. An app&apos;s build script uploads each release (<code>PUT /api/installers/&lt;app&gt;/&lt;version&gt;/&lt;file&gt;</code> with a token that has
          the <b>installers</b> permission), or HiveMind fetches the newest GitHub release with your GitHub token (Settings → GitHub).
        </p>
        {apps.length === 0 && <p className="text-sm text-slate-500">Nothing here yet.</p>}
        {apps.map((a) => (
          <InstallerCard key={a.app} app={a} onChanged={load} />
        ))}
        <AddApp onAdded={load} />
      </div>
    </div>
  );
}

function InstallerCard({ app, onChanged }: { app: InstallerApp; onChanged: () => void }) {
  const [repo, setRepo] = useState(app.githubRepo ?? '');
  const [busy, setBusy] = useState(false);
  const latest = app.versions[0];
  return (
    <div className="space-y-2 rounded-md border border-[#30363d] p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <b>{app.app}</b>
        {latest && <span className="text-xs text-slate-500">newest {latest.version}</span>}
        <input className="input ml-auto w-56 py-0.5 text-xs" placeholder="GitHub owner/repository" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <button
          className="btn-ghost px-2 py-0.5 text-xs"
          disabled={busy || !repo.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/installers/${encodeURIComponent(app.app)}/repo`, { method: 'PUT', body: { repo } });
              const r = await api<{ version: string; files: string[] }>(`/api/installers/${encodeURIComponent(app.app)}/github`, { method: 'POST' });
              toast(`${app.app} ${r.version}: ${r.files.length} files from GitHub`, 'ok');
              onChanged();
            } catch {}
            setBusy(false);
          }}
        >
          {busy ? 'Fetching…' : 'Get newest from GitHub'}
        </button>
      </div>
      {app.versions.slice(0, 5).map((v) => (
        <details key={v.version} open={v === latest}>
          <summary className="cursor-pointer text-xs text-slate-300">
            {v.version} <span className="text-slate-500">· {v.added.slice(0, 10)}</span>
          </summary>
          <div className="mt-1 flex flex-wrap gap-1">
            {v.files.map((f) => (
              <a key={f.name} className="btn-ghost px-2 py-0.5 text-xs" href={`/api/installers/${encodeURIComponent(app.app)}/${encodeURIComponent(v.version)}/${encodeURIComponent(f.name)}`}>
                ⬇ {f.name} <span className="text-slate-500">{mb(f.size)}</span>
              </a>
            ))}
            <button
              className="btn-ghost px-2 py-0.5 text-xs text-red-400"
              onClick={async () => {
                if (!confirm(`Delete ${app.app} ${v.version} from HiveMind?`)) return;
                await api(`/api/installers/${encodeURIComponent(app.app)}/${encodeURIComponent(v.version)}`, { method: 'DELETE' }).catch(() => {});
                onChanged();
              }}
            >
              Delete
            </button>
          </div>
          {v.notes && <pre className="mt-1 max-h-40 overflow-auto text-xs whitespace-pre-wrap text-slate-400">{v.notes}</pre>}
        </details>
      ))}
    </div>
  );
}

/** A new app to fetch from GitHub (e.g. hivebot with its repository). */
function AddApp({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  return (
    <div className="flex flex-wrap gap-1 text-sm">
      <input className="input w-36 py-1" placeholder="app, e.g. hivebot" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="input w-56 py-1" placeholder="GitHub owner/repository" value={repo} onChange={(e) => setRepo(e.target.value)} />
      <button
        className="btn-ghost"
        disabled={!/^[A-Za-z0-9][\w.+-]*$/.test(name) || !repo.includes('/')}
        onClick={async () => {
          try {
            await api(`/api/installers/${encodeURIComponent(name)}/repo`, { method: 'PUT', body: { repo } });
            toast(`${name} added: press "Get newest from GitHub"`, 'ok');
            setName('');
            setRepo('');
            onAdded();
          } catch {}
        }}
      >
        Add app
      </button>
    </div>
  );
}

// ---- Install a robot from the browser ----

declare global {
  interface Navigator {
    serial?: { requestPort(): Promise<SerialPortLike> };
  }
}
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  writable: WritableStream<Uint8Array> | null;
  readable: ReadableStream<Uint8Array> | null;
}

/**
 * Install a robot: step 1 writes the firmware over USB with Espressif's esp-web-tools (Web Serial, Chrome/Edge, over
 * HTTPS); step 2 sends the setup lines the robot's console knows (wifi add, url, token, pin). The PIN goes straight
 * to the robot, which keeps only a salted hash; HiveMind never stores it.
 */
function FlashRobot({ firmwareApp, hasFirmware, urls, token }: { firmwareApp: string; hasFirmware: (board: string) => boolean; urls: { home?: string; public?: string }; token?: string }) {
  const [board, setBoard] = useState('cores3');
  const [ready, setReady] = useState(false);
  const [setup, setSetup] = useState({ ssid: '', pass: '', url: '', token: '', pin: '' });
  const [log, setLog] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const serial = typeof navigator !== 'undefined' && !!navigator.serial && window.isSecureContext;

  useEffect(() => {
    setSetup((s) => ({ ...s, url: s.url || urls.home || location.origin, token: token ?? s.token }));
  }, [urls.home, token]);

  useEffect(() => {
    if (!serial || customElements.get('esp-web-install-button')) return setReady(true);
    const s = document.createElement('script');
    s.type = 'module';
    s.src = 'https://unpkg.com/esp-web-tools@10.1.0/dist/web/install-button.js?module';
    s.onload = () => setReady(true);
    document.head.appendChild(s);
  }, [serial]);

  useEffect(() => {
    if (!ready || !box.current) return;
    box.current.innerHTML = '';
    const btn = document.createElement('esp-web-install-button');
    btn.setAttribute('manifest', `/api/installers/firmware-manifest?board=${encodeURIComponent(board)}`);
    const b = document.createElement('button');
    b.setAttribute('slot', 'activate');
    b.className = 'btn';
    b.textContent = 'Install firmware over USB';
    btn.appendChild(b);
    box.current.appendChild(btn);
  }, [ready, board]);

  const send = async () => {
    try {
      const port = await navigator.serial!.requestPort();
      await port.open({ baudRate: 115200 });
      const w = port.writable!.getWriter();
      const lines = [
        setup.ssid && `wifi add ${setup.ssid} ${setup.pass}`,
        setup.url && `url ${setup.url}`,
        setup.token && `token ${setup.token}`,
        setup.pin && `pin ${setup.pin}`,
      ].filter(Boolean) as string[];
      for (const l of lines) {
        await w.write(new TextEncoder().encode(`${l}\n`));
        await new Promise((r) => setTimeout(r, 400));
      }
      w.releaseLock();
      await port.close();
      // Never show the password, token or PIN back.
      setLog(`Sent: ${lines.map((l) => l.split(' ').slice(0, l.startsWith('wifi') ? 3 : 1).join(' ')).join(', ')}. The robot restarts its Wi-Fi and should show up under Robots within a minute.`);
      setSetup((s) => ({ ...s, pass: '', pin: '' }));
    } catch (err) {
      setLog(`Could not send: ${(err as Error).message}`);
    }
  };

  return (
    <div className="card space-y-3">
      <h2 className="font-semibold">Install a robot</h2>
      {!serial && (
        <p className="text-sm text-amber-300">
          Installing over USB needs Chrome or Edge on a computer, and HiveMind opened over HTTPS (your public address) or as localhost. You can still download the firmware under Installers.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-400">1.</span>
        <select className="input w-auto" value={board} onChange={(e) => setBoard(e.target.value)}>
          {BOARDS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        {hasFirmware(board) ? (
          serial && <div ref={box} />
        ) : (
          <span className="text-xs text-slate-500">
            No firmware for this board yet: upload <code>{board}-firmware.bin</code> (and bootloader, partitions, ota_data_initial) to <code>{firmwareApp}</code>.
          </span>
        )}
      </div>
      <div className="space-y-2 text-sm">
        <div className="text-slate-400">2. Then send it its setup (the robot on USB, after the install):</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="input" placeholder="Wi-Fi name" value={setup.ssid} onChange={(e) => setSetup({ ...setup, ssid: e.target.value })} />
          <input className="input" type="password" placeholder="Wi-Fi password" value={setup.pass} onChange={(e) => setSetup({ ...setup, pass: e.target.value })} />
          <input className="input" placeholder="HiveMind address" value={setup.url} onChange={(e) => setSetup({ ...setup, url: e.target.value })} />
          <input className="input" type="password" placeholder="Robot token (Add robot above)" value={setup.token} onChange={(e) => setSetup({ ...setup, token: e.target.value })} />
          <input className="input" type="password" inputMode="numeric" placeholder="Unlock PIN (only the robot keeps it, as a hash)" value={setup.pin} onChange={(e) => setSetup({ ...setup, pin: e.target.value.replace(/\D/g, '') })} />
        </div>
        <button className="btn" disabled={!serial || (!setup.ssid && !setup.token)} onClick={send}>
          Send setup over USB
        </button>
        {log && <p className="text-xs text-slate-400">{log}</p>}
      </div>
    </div>
  );
}
