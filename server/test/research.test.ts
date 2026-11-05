import { describe, expect, it } from 'vitest';
import { researchList } from '../src/nodes/index.js';
import { listItems } from '../src/nodes/projects.js';
import { parseDuckDuckGo, readPage } from '../src/services/search.js';

/** Looking things up online: DuckDuckGo's results, lists of things to look up, and reading pages safely. */

const DDG = `
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fstackoverflow.com%2Fquestions%2F8173232%2Fexe&amp;rut=abc">How to make <b>exe</b> files from a node.js app?</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Use <b>pkg</b> &#x27;to package&#x27; your app &amp; ship it.</a>
</div>
<div class="result results_links web-result result--ad">
  <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">An ad</a>
</div>
<div class="result results_links web-result ">
  <a class="result__a" href="https://nodejs.org/api/single-executable-applications.html">Single executable applications</a>
  <div class="result__snippet">Node.js SEA docs</div>
</div>`;

describe('online research', () => {
  it('reads DuckDuckGo results: the real links, titles and snippets, without ads', () => {
    expect(parseDuckDuckGo(DDG)).toEqual([
      { title: 'How to make exe files from a node.js app?', url: 'https://stackoverflow.com/questions/8173232/exe', text: "Use pkg 'to package' your app & ship it." },
      { title: 'Single executable applications', url: 'https://nodejs.org/api/single-executable-applications.html', text: 'Node.js SEA docs' },
    ]);
  });

  it('finds the things to look up in a plan, a JSON list or lines; NONE is nothing', () => {
    expect(researchList('{"files": [{"path": "a.js"}], "research": ["pkg exe targets", "read csv node"]}')).toEqual(['pkg exe targets', 'read csv node']);
    expect(researchList('["one", "two"]')).toEqual(['one', 'two']);
    expect(researchList('- how to use commander\n2. node fs promises\n')).toEqual(['how to use commander', 'node fs promises']);
    expect(researchList('NONE')).toEqual([]);
    expect(researchList('{"files": []}')).toEqual([]);
  });

  it('For each goes through the files of a plan, also when other lists come first', () => {
    expect(listItems('{"research": ["x"], "files": [{"path": "a.js"}, {"path": "b.js"}]}')).toEqual(['{"path":"a.js"}', '{"path":"b.js"}']);
  });

  it('never reads a page in the local network, also not through a redirect', async () => {
    await expect(readPage('http://127.0.0.1:4820/api/health')).rejects.toThrow(/may not call/);
    await expect(readPage('http://192.168.1.10/')).rejects.toThrow(/may not call/);
    await expect(readPage('file:///etc/passwd')).rejects.toThrow(/http/);
  });
});
