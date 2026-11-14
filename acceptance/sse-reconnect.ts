/** Manual, no-inference recovery review against a running app. Chromium lifecycle/fault
 * injection is not actual iPad/WebKit verification. Never run as a UI test suite.
 * bun acceptance/sse-reconnect.ts --kintsugi http://localhost:3120 --workspace 5583b635 --agent <id> --out <dir>
 */
import {parseArgs} from "node:util";
import {chromium} from "@playwright/test";
import {Report} from "./lib/report.ts";
import {check} from "./lib/trace.ts";
const {values:args}=parseArgs({options:{kintsugi:{type:"string",default:"http://localhost:3120"},workspace:{type:"string"},agent:{type:"string"},cdp:{type:"string",default:"http://127.0.0.1:9222"},out:{type:"string"}}});
if(!args.workspace||!args.agent||!args.out)throw Error("Supply --workspace, --agent and --out for an existing offline review workspace.");
type Faults={streams:number;commands:number;hangCommands:number;dropConfirmations:boolean;welcome:string};
declare global {interface Window {sseReview:Faults;}}
const browser=await chromium.connectOverCDP(args.cdp),context=browser.contexts()[0]!;
const page=await context.newPage(),cdp=await context.newCDPSession(page),origin=new URL(args.kintsugi).origin;
const cookies=(await context.cookies(origin)).filter(cookie=>cookie.name==="kintsugi-live-transport");
const report=new Report(args.out,"SSE recovery — no inference",{scope:"Chromium tablet emulation with missed lifecycle events and stalled HTTP/confirmation paths. Not an actual iPad test.",origin});
let sends=0;page.on("request",request=>{if(request.method()==="POST"&&new URL(request.url()).pathname.endsWith("/messages"))sends++;});
async function waitReady(timeout:number){try{await page.waitForFunction(()=>window.KintsugiCable?.ready(),{},{timeout});return true;}catch{return false;}}
try{
  await context.addCookies([{name:"kintsugi-live-transport",value:"sse",url:origin}]);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1024,height:900,deviceScaleFactor:2,mobile:false});
  await cdp.send("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:5});
  await page.addInitScript(()=>{
    window.sseReview={streams:0,commands:0,hangCommands:0,dropConfirmations:false,welcome:""};
    const nativeFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const path=new URL(input instanceof Request?input.url:String(input),location.href).pathname;
      if(path.startsWith("/cable/")){
        window.sseReview.commands++;
        if(window.sseReview.hangCommands-->0)return new Promise<Response>((_resolve,reject)=>{
          const abort=()=>reject(new DOMException("Injected command stall cancelled","AbortError"));
          if(init?.signal?.aborted)abort();else init?.signal?.addEventListener("abort",abort,{once:true});
        });
      }
      const response=await nativeFetch(input,init);
      if(path!=="/cable"||!response.body||!response.headers.get("content-type")?.startsWith("text/event-stream"))return response;
      window.sseReview.streams++;
      const suppress=window.sseReview.dropConfirmations;window.sseReview.dropConfirmations=false;
      const decoder=new TextDecoder(),encoder=new TextEncoder();let pending="";
      const body=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
        pending+=decoder.decode(chunk,{stream:true});let boundary:number;
        while((boundary=pending.indexOf("\n\n"))!==-1){const frame=pending.slice(0,boundary);pending=pending.slice(boundary+2);
          if(frame.includes('"type":"welcome"'))window.sseReview.welcome=frame;
          if(suppress&&frame.includes('"type":"confirm_subscription"'))continue;
          controller.enqueue(encoder.encode(frame+"\n\n"));
        }
      }}));
      return new Response(body,{status:response.status,headers:response.headers});
    };
  });
  await page.goto(`${origin}/workspaces/${args.workspace}?agent=${args.agent}`);
  if(!await waitReady(20000))throw Error("Initial SSE connection did not become ready");
  const input=page.locator(".agent-pane-composer .composer-input").first();
  const opener=page.locator('[data-agent-composer-target="opener"]').first();if(await opener.isVisible())await opener.click();
  const draft=await input.inputValue();await input.fill("SSE recovery draft — not sent.");
  const fresh=async()=>{await page.evaluate(()=>{window.sseReview.hangCommands=0;window.sseReview.dropConfirmations=false;window.KintsugiCable!.reconnect();});if(!await waitReady(10000))throw Error("Could not reset review connection");};
  for(const fault of ["missed-hide","command-stall","confirmation-stall","offline-online"]){
    await fresh();await page.waitForTimeout(1200);
    const before=await page.evaluate(()=>({...window.sseReview})),started=Date.now();
    if(fault==="missed-hide")await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));document.dispatchEvent(new Event("visibilitychange"));});
    else if(fault==="command-stall")await page.evaluate(()=>{window.sseReview.hangCommands=1;window.KintsugiCable!.reconnect();});
    else if(fault==="confirmation-stall")await page.evaluate(()=>{window.sseReview.dropConfirmations=true;window.KintsugiCable!.reconnect();});
    else{
      await cdp.send("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});await page.waitForTimeout(250);
      await cdp.send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    }
    const budget=fault==="confirmation-stall"?23000:fault==="command-stall"?11000:3000;
    if(fault==="missed-hide")await page.waitForFunction(streams=>window.sseReview.streams>streams,before.streams,{timeout:budget}).catch(()=>{});
    const ready=await waitReady(budget),elapsed=Date.now()-started,after=await page.evaluate(()=>({...window.sseReview}));
    const scenario=await report.scenario(fault,"Recover a fresh, ready snapshot while preserving the unsent draft.");
    scenario.add(check("connection recovered within budget",ready&&elapsed<budget,`${elapsed}ms; budget ${budget}ms`),check("fresh stream and welcome",after.streams>before.streams&&after.welcome!==before.welcome,`streams ${before.streams} → ${after.streams}`),check("unsent draft preserved",await input.inputValue()==="SSE recovery draft — not sent.","draft retained"),check("no prompt submissions",sends===0,`${sends} sends`));
    await scenario.file("recovered.png",await page.screenshot());
  }
  await input.fill(draft);
  const result=await report.write();console.log(`${result.passed?"PASS":"FAIL"}: ${result.index}`);if(!result.passed)process.exitCode=1;
}finally{
  await cdp.send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await page.close();await context.clearCookies({name:"kintsugi-live-transport",domain:new URL(origin).hostname});if(cookies.length)await context.addCookies(cookies);
}
// Disconnect this review process without closing the managed Chromium browser.
process.exit(process.exitCode??0);
