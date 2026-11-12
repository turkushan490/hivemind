// Small helpers for the Windows .exe build. Safe to import anywhere: no web-UI assets are pulled in here.
import { spawn } from 'node:child_process';

/**
 * True when running as the packaged Windows .exe (pkg or a Node SEA), not the Docker image or dev. Container-only
 * features (local training, Colibri, Kokoro) are absent there, so their "missing" is expected, not a problem.
 */
export function isPackaged(): boolean {
  // pkg sets process.pkg on the packaged exe; exe-env.ts also sets HIVEMIND_PACKAGED as a belt-and-braces signal.
  return !!(process as { pkg?: unknown }).pkg || process.env.HIVEMIND_PACKAGED === '1';
}

/**
 * Opens the HiveMind UI for a desktop user. HIVEMIND_OPEN_BROWSER=app → a chrome/edge app window;
 * "browser"/"default"/"1"/"true" → the default browser; anything else (unset, "off", "none") → nothing opens.
 */
export function openBrowser(url: string): void {
  const mode = process.env.HIVEMIND_OPEN_BROWSER;
  if (!mode || !['app', 'browser', 'default', '1', 'true'].includes(mode)) return;
  try {
    if (process.platform === 'win32') {
      if (mode === 'app') {
        // A borderless app window looks like a desktop app; fall through to the default browser if neither is installed.
        const tryApp = (exe: string) => spawn(exe, [`--app=${url}`], { detached: true, stdio: 'ignore', shell: false });
        for (const exe of ['msedge', 'chrome']) {
          try {
            tryApp(exe).on('error', () => {}).unref();
            return;
          } catch {}
        }
      }
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Opening a window is a convenience; the server is reachable in any browser regardless.
  }
}
