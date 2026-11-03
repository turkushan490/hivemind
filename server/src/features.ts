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
];
