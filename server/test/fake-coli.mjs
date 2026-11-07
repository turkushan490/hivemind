// A stand-in for `coli serve` in the colibri tests: the same command line and endpoints, canned answers.
// FAKE_COLI_FAIL=1 exits at once with a message, FAKE_COLI_DELAY_MS slows every answer down.
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const port = Number(arg('--port'));
const model = arg('--model-id');
if (process.env.FAKE_COLI_FAIL) {
  console.log(process.env.FAKE_COLI_FAIL);
  process.exit(3);
}
const delay = Number(process.env.FAKE_COLI_DELAY_MS || 0);
let active = 0;
let completed = 0;
console.log(`fake coli serving ${model} on ${port} (${args.join(' ')})`);

const body = (req) => new Promise((r) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => r(s ? JSON.parse(s) : {}));
});

createServer(async (req, res) => {
  if (req.url === '/health') return res.end(JSON.stringify({ ok: true, active, queued: 0, completed, model }));
  if (req.url === '/v1/chat/completions') {
    const b = await body(req);
    active++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await new Promise((r) => setTimeout(r, delay));
    const last = b.messages[b.messages.length - 1].content;
    for (const word of [`${model}`, ' says: ', last, b.enable_thinking === false ? ' (no thinking)' : '']) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 4 } })}\n\n`);
    res.end('data: [DONE]\n\n');
    active--;
    completed++;
    return;
  }
  if (req.url === '/v1/systemone') {
    const b = await body(req);
    const answers = Object.fromEntries(
      Object.entries(b.questions).map(([k, q]) => {
        if (q.type === 'noul') return [k, { type: 'noul', noul: 0.9 }];
        const labels = Object.keys(q.criteria);
        return [k, { type: 'choice', choice: labels[0], probabilities: Object.fromEntries(labels.map((l, i) => [l, i === 0 ? 0.8 : 0.2 / (labels.length - 1)])), confidence: 0.6 }];
      }),
    );
    return res.end(JSON.stringify({ model, provider: 'colibri', answers, usage: { input_tokens: 12, output_tokens: 0 } }));
  }
  res.statusCode = 404;
  res.end('{}');
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
