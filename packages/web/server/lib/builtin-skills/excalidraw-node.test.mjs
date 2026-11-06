import assert from 'node:assert/strict';
import { test } from 'vitest';
import { requestAllowed, selectBrowser, validateDriver, rasterFits } from '../../builtin-skills/skills/obsidian-excalidraw/references/render-node.mjs';
const origin='http://127.0.0.1:45678';
const assets=new Set(['/render.html','/fonts/Excalifont/a.woff2']);
test('allows only exact renderer asset requests and bounded embedded resources',()=>{
  assert.equal(requestAllowed(`${origin}/render.html`,origin,assets,'GET'),true);
  assert.equal(requestAllowed(`${origin}/fonts/Excalifont/a.woff2`,origin,assets,'GET'),true);
  for(const url of ['https://example.com/a', 'file:///etc/passwd', 'http://127.0.0.1:45679/render.html', `${origin}@example.com/a`,`${origin}/../generate.py`,`${origin}/%2e%2e/render.html`,`${origin}/render.html?q=1`,`${origin}/generate.py`,`blob:https://example.com/id`,'ws://127.0.0.1:45678/render.html']) assert.equal(requestAllowed(url,origin,assets,'GET'),false,url);
  assert.equal(requestAllowed(`${origin}/render.html`,origin,assets,'POST'),false);
});
test('an explicit missing browser never falls back to another installed browser',async()=>{
  await assert.rejects(selectBrowser('/missing/Chrome',{}),/browser.*unavailable/i);
});
test('a global or arbitrary driver binding is refused before import',async()=>{
  await assert.rejects(validateDriver('/usr/local/lib/node_modules/playwright-core'),/owned/);
});

test('final screenshot bounds count device scale and round both raster edges up',()=>{
  assert.equal(rasterFits({width:1876,height:363},2,3752*726),true);
  assert.equal(rasterFits({width:1876,height:363.01},2,3752*726),false);
  assert.equal(rasterFits({width:2400,height:12000},2,32_000_000),false);
  for(const width of [NaN,Infinity,0,-1]) assert.equal(rasterFits({width,height:20},2,32_000_000),false);
});
