/** Manual acceptance for the owned Files fixture; never run by CI/test suites.
 * The fixture uses production Files routes/renderers and a private temporary filesystem,
 * not a real Docker workspace. Run with --expect-missing to capture the original failure.
 */
import {chromium} from '@playwright/test';
import {parseArgs} from 'node:util';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const {values}=parseArgs({options:{fixture:{type:'string',default:'http://localhost:3162'},out:{type:'string',default:'artifacts/files-browser-fix/manual'},'expect-missing':{type:'boolean',default:false}}});
const url=new URL(values.fixture!);if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('Use only the owned loopback Files fixture');
const out=resolve(values.out!);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});const checks:Array<{name:string;pass:boolean;detail?:string}>=[];const errors:string[]=[];
try {
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1250,height:900}});
 const fixture=await(await context.request.get(new URL('/__fixture/status',url).href)).json();if(fixture.fixture!=='files-browser')throw new Error('Wrong server: refusing to drive a non-fixture instance');
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.goto(new URL('/workspaces/files-fixture?workView=files:workspace',url).href,{waitUntil:'domcontentloaded'});
 if(values['expect-missing']) {
  await page.getByText('Content missing',{exact:true}).waitFor();
  checks.push({name:'Original root listing failure reproduced',pass:true});
  await page.screenshot({path:join(out,'content-missing-before.png')});
 } else {
  const tree=page.getByRole('tree',{name:'Files in /work',exact:true});await tree.waitFor();
  await tree.getByRole('treeitem',{name:/^README\.md/}).waitFor();
  checks.push({name:'/work listing loads its filenames',pass:true});
  const folder=tree.getByRole('treeitem',{name:/^src(?:\s|$)/});await folder.click();
  await tree.getByRole('treeitem',{name:/^index\.ts/}).waitFor();
  checks.push({name:'Directory expansion loads its children',pass:true});
  await folder.click();await tree.getByRole('treeitem',{name:/^index\.ts/}).waitFor({state:'hidden'});
  checks.push({name:'Directory collapse removes its children',pass:true});
  const filter=page.getByRole('searchbox',{name:'Filter files by name',exact:true});await filter.fill('README');
  await folder.waitFor({state:'hidden'});
  await page.getByRole('tree',{name:'Matching files',exact:true}).getByRole('treeitem',{name:/^README\.md/}).waitFor();
  checks.push({name:'Filtering returns matching filenames',pass:true});
  await filter.fill('');await page.getByRole('tree',{name:'Files in /work',exact:true}).getByRole('treeitem',{name:/^src(?:\s|$)/}).waitFor();
  await page.getByRole('button',{name:'Refresh files',exact:true}).click();
  await page.getByRole('tree',{name:'Files in /work',exact:true}).getByRole('treeitem',{name:/^README\.md/}).waitFor();
  checks.push({name:'Refresh reloads the root listing',pass:true});
  await page.locator('.fixed-shell-work-pane').screenshot({path:join(out,'tree-working-after.png')});
  const content=page.waitForResponse(response=>response.url().includes('/files-view/content?')&&response.request().method()==='GET');
  await page.getByRole('treeitem',{name:/^README\.md/}).click();
  const response=await content;
  const data=await response.json();
  await page.getByRole('button',{name:'Rendered',exact:true}).click();
  await page.locator('.file-editor-rendered-markdown').getByText('This file is safe to open.',{exact:true}).waitFor();
  checks.push({name:'Opening a file loads its content in the editor',pass:response.status()===200&&data.content.includes('This file is safe to open.')});
  checks.push({name:'No Content missing notice remains',pass:await page.getByText('Content missing',{exact:true}).count()===0});
  checks.push({name:'No unexpected browser errors',pass:errors.length===0,detail:JSON.stringify(errors)});
  await page.locator('.fixed-shell-work-pane').screenshot({path:join(out,'files-working-after.png')});
 }
 await context.close();
} catch(error) {checks.push({name:'Acceptance completed',pass:false,detail:error instanceof Error?error.stack:String(error)});}
finally {await browser.close();}
const report={passed:checks.every(check=>check.pass),checks,errors,scope:'Owned no-container/no-inference fixture; production middleware and Files routes/renderers; private temporary filesystem adapter. Chromium only, not a live installed-workspace test.'};
await Bun.write(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
