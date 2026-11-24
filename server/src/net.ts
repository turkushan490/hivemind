import { Agent, setGlobalDispatcher } from 'undici';

/**
 * Node's fetch waits at most 300 s for the response headers (and 300 s between body chunks). Ollama sends its headers only
 * once the model is loaded, and gemma4:26b loading partly on the CPU next to another model takes longer: every agent job
 * then died with a bare "fetch failed" (owner, 2026-11-24: Ultron's and Jarvis's Warhammer builds, the night index).
 * Blocks and jobs have their own time limits (AbortSignal), so the network layer only stops what really hangs.
 */
const HOUR = 60 * 60_000;
setGlobalDispatcher(new Agent({ headersTimeout: HOUR, bodyTimeout: HOUR }));
