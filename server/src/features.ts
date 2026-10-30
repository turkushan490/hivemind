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
];
