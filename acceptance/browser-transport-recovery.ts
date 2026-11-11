/** Manual, no-inference acceptance against the owned loopback HTTPS fixture.
 * Never part of the test suite or CI. The fixture rejects WSS and exposes only
 * fake workspaces; unrelated settings sections deliberately never respond.
 * Run: bun acceptance/browser-transport-recovery.ts [--fixture https://localhost:3160] [--out artifacts/browser-transport/manual]
 * The self-signed exception is restricted to this loopback test context, not product TLS or provider requests.
 */
import {chromium} from '@playwright/test';
import type {KintsugiCableClient} from '@kintsugi/shared';
declare global { interface Window { KintsugiCable?: KintsugiCableClient } }
import {parseArgs} from 'node:util';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const {values}=parseArgs({options:{fixture:{type:'string',default:'https://localhost:3160'},out:{type:'string',default:'artifacts/browser-transport/manual'}}});
const origin=new URL(values.fixture!).origin;
if(new URL(origin).protocol!=='https:'||!['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname))throw new Error('Use only the owned loopback HTTPS fixture');
const out=resolve(values.out!);await mkdir(out,{recursive:true});
const checks:Array<{name:string;pass:boolean;detail?:string}>=[];
const errors:string[]=[];
const browser=await chromium.launch({headless:true});
try {
 const context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',viewport:{width:1250,height:900}});
 const fixture=await(await context.request.get(origin+'/__fixture/status')).json();
 if(fixture.fixture!=='browser-transport')throw new Error('Wrong server: refusing to mutate a non-fixture instance');
 await context.request.post(origin+'/__fixture/reset',{headers:{Origin:origin}});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/workspaces/one?agent=one-helper',{waitUntil:'domcontentloaded'});
 await page.locator('#live-connection-status').waitFor({state:'visible'});
 checks.push({name:'Recovery is visible while WSS is rejected',pass:await page.locator('#live-connection-status').isVisible()});
 checks.push({name:'Recovery tab already identifies the workspace',pass:await page.title()==='Workspace One',detail:await page.title()});
 const gear=page.locator('.workspace-boot').getByRole('link',{name:'Connection settings',exact:true});
 await gear.waitFor({state:'visible'});
 await page.screenshot({path:join(out,'recovery-desktop.png')});
 await gear.click();
 await page.getByRole('heading',{name:'Browser connection',exact:true}).waitFor();
 checks.push({name:'Settings opens over HTTPS without Cable',pass:await page.getByRole('button',{name:'SSE',exact:true}).isEnabled()});
 checks.push({name:'Global Settings keeps the product title',pass:await page.title()==='Kintsugi',detail:await page.title()});
 await page.getByRole('button',{name:'SSE',exact:true}).click();
 await page.waitForFunction(()=>window.KintsugiCable?.ready(),{},{timeout:15000});
 checks.push({name:'SSE restores live updates after the native form switch',pass:await page.getByRole('button',{name:'SSE',exact:true}).getAttribute('aria-pressed')==='true'});
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.KintsugiCable?.ready(),{},{timeout:15000});
 checks.push({name:'SSE preference survives reload',pass:await page.getByRole('button',{name:'SSE',exact:true}).getAttribute('aria-pressed')==='true'});
 const status=await(await context.request.get(origin+'/__fixture/status')).json();
 checks.push({name:'Focused recovery settings did not start unrelated section requests',pass:status.otherSections===0,detail:JSON.stringify(status)});
 await page.screenshot({path:join(out,'settings-sse.png')});
 await page.goto(origin+'/workspaces/one?agent=one-helper',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.title==='Workspace One - @Helper');
 checks.push({name:'Workspace tab includes the selected Agent',pass:await page.title()==='Workspace One - @Helper'});
 await page.getByRole('tab',{name:'Reviewer',exact:true}).click();
 await page.waitForFunction(()=>document.title==='Workspace One - @Reviewer');
 checks.push({name:'Agent selection refreshes the tab title',pass:true});
 await context.request.post(origin+'/__fixture/rename',{headers:{Origin:origin}});
 await page.waitForFunction(()=>document.title==='Renamed Workspace - @Auditor');
 checks.push({name:'Workspace and Agent renames refresh the tab title',pass:true});
 await page.screenshot({path:join(out,'workspace-renamed.png')});
 await page.goto(origin+'/workspaces/two?agent=two-helper',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.title==='Workspace Two - @Helper');
 checks.push({name:'Changing workspace refreshes the tab title',pass:true});
 await page.goto(origin+'/settings?section=browser-transport',{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'WebSocket',exact:true}).click();
 await page.getByRole('heading',{name:'Browser connection',exact:true}).waitFor();
 checks.push({name:'Switching back to failed WSS still leaves the transport selector usable',pass:await page.getByRole('button',{name:'SSE',exact:true}).isEnabled()});
 await page.setViewportSize({width:390,height:844});
 await page.goto(origin+'/workspaces/one?agent=one-helper',{waitUntil:'domcontentloaded'});
 const mobileGear=page.locator('.workspace-boot').getByRole('link',{name:'Connection settings',exact:true});
 await mobileGear.waitFor({state:'visible'});await mobileGear.click();
 await page.getByRole('heading',{name:'Browser connection',exact:true}).waitFor();
 checks.push({name:'Mobile recovery gear opens connection settings',pass:await page.getByRole('button',{name:'SSE',exact:true}).isVisible()});
 await page.screenshot({path:join(out,'settings-mobile.png')});
 await page.getByRole('button',{name:'Close settings',exact:true}).click();
 await page.getByRole('heading',{name:'Browser connection',exact:true}).waitFor({state:'hidden'});
 checks.push({name:'Recovery status does not cover the mobile Settings controls',pass:true});
 await context.close();
 const native=await browser.newContext({ignoreHTTPSErrors:true,javaScriptEnabled:false,serviceWorkers:'block'});
 const nativePage=await native.newPage();
 await nativePage.goto(origin+'/workspaces/one',{waitUntil:'domcontentloaded'});
 await nativePage.locator('.workspace-boot').getByRole('link',{name:'Connection settings',exact:true}).click();
 await nativePage.getByRole('button',{name:'SSE',exact:true}).click();
 checks.push({name:'Recovery gear and selector work without JavaScript',pass:await nativePage.getByRole('button',{name:'SSE',exact:true}).getAttribute('aria-pressed')==='true'});
 await native.close();
 checks.push({name:'No browser page errors',pass:errors.length===0,detail:JSON.stringify(errors)});
} catch(error) {
 checks.push({name:'Acceptance completed',pass:false,detail:error instanceof Error?error.stack:String(error)});
} finally {await browser.close();}
const result={passed:checks.every(check=>check.pass),checks,scope:'Owned HTTPS fixture, WSS deliberately rejected, browser context explicitly accepts the local self-signed certificate. No provider inference, containers or user work. Chromium desktop/mobile emulation; physical iOS certificate handling is not qualified.'};
await Bun.write(join(out,'report.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
process.exitCode=result.passed?0:1;
