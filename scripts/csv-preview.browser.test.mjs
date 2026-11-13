import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait } from './perf/cdp.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));

test('wide CSV previews keep bounded rows, stable columns and a reachable final row', { timeout: 45_000 }, async (t) => {
  let chrome;
  try { chrome = resolveChrome(); } catch { t.skip('Chrome is required for real layout verification'); return; }
  const scratch = await mkdtemp(join(tmpdir(), 'superwagie-csv-preview-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await symlink(resolve(repo, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  const component = process.env.CSV_PREVIEW_COMPONENT || resolve(repo, 'packages/ui/src/components/views/files/previews/TableArtifact.tsx');
  const entry = join(scratch, 'fixture.tsx');
  await writeFile(entry, `
    import React from ${JSON.stringify(resolve(repo, 'node_modules/react'))};
    import { createRoot } from ${JSON.stringify(resolve(repo, 'node_modules/react-dom/client'))};
    import { I18nProvider, useI18nStore } from ${JSON.stringify(resolve(repo, 'packages/ui/src/lib/i18n/index.ts'))};
    import { TableArtifact } from ${JSON.stringify(component)};
    const root = createRoot(document.getElementById('root'));
    const makeContent = (columns) => [Array.from({length:columns},(_,c)=>'column'+c).join(','), ...Array.from({length:2000},(_,r)=>Array.from({length:columns},(_,c)=>r===1&&c===0?'x'.repeat(1000):r+':'+c).join(','))].join('\\n');
    const content = makeContent(1000);
    await useI18nStore.getState().setLocale('en');
    window.showPreview = (next = content) => root.render(<I18nProvider><TableArtifact path="wide.csv" content={next} sizeBytes={null} onQuote={(quote) => { window.quoted = quote; return true; }}/></I18nProvider>);
    window.showWide = (columns) => window.showPreview(makeContent(columns));
    window.showPreview();
  `);
  const build = spawnSync('bun', ['build', entry, '--target=browser', '--minify', '--outdir', scratch,
    '--tsconfig-override', resolve(repo, 'packages/ui/tsconfig.json')], { cwd: repo, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;height:100%;font:12px/16px monospace}#root{height:480px;width:900px}
    [class~="flex"]{display:flex}[class~="h-full"]{height:100%}[class~="flex-col"]{flex-direction:column}
    [class~="min-h-0"]{min-height:0}[class~="flex-1"]{flex:1 1 0%}[class~="overflow-auto"]{overflow:auto}
    table{border-spacing:0;min-width:100%}[class~="table-fixed"]{table-layout:fixed}
    th,td{padding:4px 8px;border-bottom:1px solid #ccc;border-inline-end:1px solid #ccc;text-align:start;white-space:nowrap}
    [class~="truncate"]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}thead{position:sticky;top:0;background:white}
  </style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;
  const server = createServer(async (request, response) => {
    if (request.url === '/fixture.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(join(scratch, 'fixture.js')));
    } else { response.setHeader('Content-Type', 'text/html'); response.end(html); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const debugPort = await reservePort();
  const child = launchChrome({ chrome, profileDir: join(scratch, 'profile'), port: debugPort, headless: true });
  let client;
  try {
    const target = await createPageTarget(debugPort);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !await evaluateValue(client, 'document.querySelectorAll("tbody td").length > 0')) await wait(100);
    const before = await evaluateValue(client, `(() => {
      const s=document.querySelector('[class~="overflow-auto"]');
      return {rows:document.querySelectorAll('tbody tr:not([aria-hidden])').length,cells:document.querySelectorAll('tbody td[aria-colindex]').length || document.querySelectorAll('tbody td').length,columns:document.querySelectorAll('th').length,width:document.querySelector('th').getBoundingClientRect().width,scrollHeight:s?.scrollHeight,clientHeight:s?.clientHeight};
    })()`);
    console.log('CSV viewport', JSON.stringify(before));
    assert.ok(before.rows > 0, 'the fixture rendered the real preview');
    assert.ok(before.rows < 80, `rendered ${before.rows} rows in a 480px viewport`);
    assert.ok(before.columns < 30, 'only viewport columns and buffer mount');
    assert.ok(before.scrollHeight > before.clientHeight * 10, 'virtual tail contributes to scroll height');
    assert.ok(before.width < 700, 'a 1000-character cell respects the column width cap');
    await evaluateValue(client, `(() => { const s=document.querySelector('[class~="overflow-auto"]');s.scrollTop=1e9;s.scrollLeft=1e9; })()`);
    await wait(300);
    const after = await evaluateValue(client, `({rows:document.querySelectorAll('tbody tr:not([aria-hidden])').length,last:document.querySelector('tbody tr:last-of-type')?.textContent,visibleTail:[...document.querySelectorAll('tbody td')].some(x=>x.textContent==='1999:999'),width:document.querySelector('th').getBoundingClientRect().width,aligned:[...document.querySelectorAll('th')].every(h=>{const c=document.querySelector('td[aria-colindex="'+h.getAttribute('aria-colindex')+'"]');return c&&Math.abs(c.getBoundingClientRect().left-h.getBoundingClientRect().left)<1})})`);
    assert.ok(after.visibleTail, 'the final data cell is reachable from the preview scroller');
    assert.ok(after.rows < 80);
    assert.ok(after.aligned, 'right-side headers and data align');
    await evaluateValue(client, `document.getElementById('root').style.width='600px';document.querySelector('[class~="overflow-auto"]').scrollLeft=0`);
    await wait(200);
    assert.ok(await evaluateValue(client, `[...document.querySelectorAll('td[aria-colindex="1"]')].some(x=>x.textContent==='1999:0')`), 'the original first column is reachable after resize');
    await evaluateValue(client, `document.getElementById('root').style.width='900px';document.querySelector('[class~="overflow-auto"]').scrollTop=0;window.showWide(2000)`);
    await wait(300);
    const doubled = await evaluateValue(client, `({cells:document.querySelectorAll('tbody td[aria-colindex]').length || document.querySelectorAll('tbody td').length,columns:document.querySelectorAll('th').length})`);
    assert.equal(doubled.columns, before.columns, 'doubling source columns does not increase mounted columns at the same viewport');
    console.log('CSV doubled columns', JSON.stringify(doubled));
    await evaluateValue(client, `window.showPreview('name,value\\nshort,42')`);
    await wait(200);
    assert.equal(await evaluateValue(client, `document.querySelector('tbody')?.textContent`), 'short42', 'a shorter file replaces the scrolled data');
    await evaluateValue(client, `window.showPreview('id,name,value\\n1,first,skip\\n2,中文,\\n3,middle,=1+2\\n4,last,42')`);
    await wait(200);
    await evaluateValue(client, `(() => {
      const start=document.querySelector('tr[data-index="1"] td[aria-colindex="2"]');
      const end=document.querySelector('tr[data-index="3"] td[aria-colindex="3"]');
      start.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse'}));
      end.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerType:'mouse',shiftKey:true}));
    })()`);
    await wait(100);
    await evaluateValue(client, `document.querySelector('button').click()`);
    await wait(100);
    assert.deepEqual(await evaluateValue(client, `window.quoted`), {range:'B3:C5', values:JSON.stringify([['中文',''],['middle','=1+2'],['last','42']])}, 'the real table quotes only the selected original cells');
    assert.equal(await evaluateValue(client, `document.querySelector('button').disabled`), true, 'success clears the selection');
    await evaluateValue(client, `window.showPreview('')`);
    await wait(100);
    assert.equal(await evaluateValue(client, `document.querySelectorAll('table').length`), 0, 'an empty file clears the table');
    await evaluateValue(client, `window.showPreview()`);
    await wait(200);
    assert.ok(await evaluateValue(client, `document.querySelectorAll('tbody td').length > 0`), 'the preview mounts rows after an empty file');
    if (process.env.CSV_PREVIEW_EVIDENCE_DIR) {
      await writeFile(join(process.env.CSV_PREVIEW_EVIDENCE_DIR, 'csv-browser.json'), JSON.stringify({ before, after }, null, 2));
    }
  } finally {
    if (client) { await client.send('Browser.close', {}, { timeoutMs: 3000 }).catch(() => {}); client.close(); }
    if (child.exitCode === null) { await wait(200); if (child.exitCode === null) child.kill(); }
    await new Promise((done) => server.close(done));
    await rm(scratch, { recursive: true, force: true });
  }
});
