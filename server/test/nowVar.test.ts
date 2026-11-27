import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

/** {{now}}: the date and time in templates (history entries get a timestamp). */
describe('{{now}}', () => {
  it('fills the local date and time', async () => {
    await testApp('nowvar');
    const { fill } = await import('../src/nodes/index.js');
    expect(fill('## Prompt {{now}}', { question: 'q', vars: {} })).toMatch(/^## Prompt \d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(fill('{{ now }} {{question}}', { question: 'q', vars: {} })).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d q$/);
  });
});
