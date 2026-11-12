/**
 * The Windows whisper.cpp binary, baked into the .exe so the built-in speech engine ships with it.
 *
 * Empty placeholder: `scripts/embed-bin.mjs` overwrites it in the exe build with the whisper files as base64.
 * In Docker and dev this file is never imported (the binary comes from /opt/whisper), so it stays empty.
 */
export const whisperBin: Record<string, string> = {};
/** Changes when the embedded binary changes, so the exe re-extracts it only when new. */
export const whisperBinId = '';
