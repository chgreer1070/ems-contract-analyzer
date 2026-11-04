import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { chromium } from '@playwright/test';
const bundle = buildSync({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Reading from './components/MatterDocumentReading'; const root=createRoot(document.getElementById('root')); window.setMatter=id=>root.render(<Reading matterId={id}/>); window.setMatter('A');`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, alias: { '@': process.cwd() } }).outputFiles[0].text;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process'] });
try {
 const page = await browser.newPage();
 let finishReading;
 const pending = new Promise(resolve => { finishReading = resolve; });
 const reading = { disclaimer: 'Reading A only', notes: [], warnings: [], operativeStatusUncertain: false, facts: [{id:'a',kind:'fact',operative:true,statement:'A private term',citations:[]}], impacts:[] };
 await page.route('http://reading.test/**', async route => {
  const url = route.request().url();
  if (url.endsWith('/documents')) return route.fulfill({ json: { documents: [{ id: url.includes('/A/') ? 'doc-A' : 'doc-B', filename: url.includes('/A/') ? 'A.txt' : 'B.txt', document_type: 'MSA', extraction_method: 'PLAIN_TEXT', extraction_status: 'EXTRACTED', integrity_status: 'SERVER_VERIFIED', security_scan_status: 'CLEAN', deletion_status: 'ACTIVE', source_status: 'EXECUTED' }] } });
  if (url.endsWith('/reading')) { await pending; return route.fulfill({json:reading}); }
  return route.fulfill({contentType:'text/html',body:'<html><body><div id="root"></div></body></html>'});
 });
 await page.goto('http://reading.test/');
 await page.addScriptTag({content:bundle});
 await page.getByTestId('reading-base').selectOption('doc-A');
 await page.getByTestId('read-documents').click();
 await page.evaluate(()=>window.setMatter('B'));
 await page.getByRole('option', {name: 'B.txt (MSA, EXECUTED)'}).waitFor({state:'attached'});
 finishReading();
 // Wait for the pending A response to be delivered and React to finish rendering it.
 await page.waitForResponse(response=>response.url().endsWith('/A/reading'));
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.getByTestId('matter-reading-fact').count(),0,'Late reading from A must not render under B');
 assert.equal(await page.getByTestId('reading-base').inputValue(),'','Selection must reset on matter change');
 assert.equal(await page.getByTestId('read-documents').isDisabled(),true);
 console.log('PASS matter switch discards prior state and delayed responses');
 reading.impacts = [{ domain:'excess_and_obsolete',area:'inventory',summary:'Stated exposure',amount:'10000',determination:'supported',kind:'fact',source_fact_ids:['fact-eo'],citations:[{quote:'Customer shall pay USD 10000.',originalFilename:'B.txt',sourceDocumentId:'doc-B',section:'1.1'}] }];
 await page.getByTestId('reading-base').selectOption('doc-B');
 await page.getByTestId('read-documents').click();
 await page.getByTestId('matter-reading-impact').waitFor();
 const impactText=await page.getByTestId('matter-reading-impact').innerText();
 assert.match(impactText,/Contractual fact/);
 assert.match(impactText,/Customer shall pay USD 10000/);
 assert.match(impactText,/B.txt/);
 assert.match(impactText,/doc-B/);
 assert.match(impactText,/fact-eo/);
 console.log('PASS financial impact displays kind, full citation and source fact IDs');
} finally { await browser.close(); }
