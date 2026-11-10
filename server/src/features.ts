/**
 * What this HiveMind can do, for clients that need a minimum (DungeonMind refuses to start a game
 * until its required features are listed). GET /api/health returns this list; add a flag in the
 * same change as its feature, never before.
 */
export const FEATURES: readonly string[] = [
  'vars',
  'memoryKeyTemplate',
  'nodeOutputs',
  'jsonMode',
  'numCtx',
  'history',
  'memorySearch',
  'memoryImport',
  'imageBatch',
  'decisionProviders',
  'decide',
  'autoModel',
  // M9: workflow schedules, the training window, training with limited tokens, per-run models, the messages
  // each block sent (?inputs=1) and live training events.
  'schedules',
  'trainingWindow',
  'scopedTraining',
  'modelOverride',
  'nodeInputs',
  'trainEvents',
  // Lab → Datasets: import a Hugging Face dataset (POST /api/datasets/:id/import).
  'datasetImport',
  // POST /api/runs → cancelWhenAlone: the run stops when nobody has followed its events for 30 seconds.
  'cancelWhenAlone',
  // The Activity page: GET /api/activity/running and /api/activity/calls.
  'activity',
  // Settings → Access: GET /api/models, /api/providers/:id/models and /loras list only what the user (and the
  // API token) may use; runs with anything else are refused (403). Files are private to their owner.
  'accessProfiles',
  'privateFiles',
  // Projects (folders that stay, with Read project / Write files / Update notes blocks), builds with npm inside
  // the container, GitHub (Settings → GitHub, the Git block), the Pause block (POST /api/runs/:id/resume), and
  // skills (Settings → Skills, the Skills setting of AI model blocks).
  'projects',
  'projectBuild',
  'github',
  'pause',
  'skills',
  // HiveBot (and other apps): Auto model falls back to another size when one fails, POST /api/canvases/:id/warm and
  // keepAlive, /api/voice/speak with a voice per request, /v1 says which model answered, canvases marked managedBy.
  'autoFallback',
  'warm',
  'ttsVoiceOverride',
  'routeInfo',
  'managedBy',
  'hivebot',
  // M15: colibri inside the container (Settings → Colibri; providers "colibri" and "colibri-decisions").
  'colibri',
  // M20: voice training (HiveBot's Voice trainer): the blocks Audio prep, Voice dataset, Voice clone and Speak, and
  // cloned voices ("clone:<name>") in /api/voice/speak, listed by GET /api/voice/voices.
  'audioPrep',
  'voiceDataset',
  'voiceClone',
  'speak',
  // A voice name with a cloned voice of its own ("jarvis" -> clone:jarvis) speaks in it without a setting.
  'autoCloneVoice',
];
