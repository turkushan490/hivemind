/**
 * The built web UI, baked into the Windows .exe so it is a single file.
 *
 * This placeholder is empty on purpose: `scripts/embed-web.mjs` overwrites it during the exe build
 * (after `web` is built) with every file in `web/dist` as base64. In the Docker image and in dev this
 * file is never imported, so the web UI there is served straight from disk as before.
 */
export const webAssets: Record<string, string> = {};
/** Changes with each build so the exe re-extracts the UI only when it is new. */
export const webBuildId = '';
/** The version the exe reports at /api/health (set by the embed script from APP_RELEASE / package.json). */
export const appRelease = '';
