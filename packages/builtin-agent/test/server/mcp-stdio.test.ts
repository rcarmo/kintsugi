import {expect,test} from "bun:test";
import {connectMcpStdio} from "../../src/server/mcp-stdio.ts";
import {McpConnectionStore} from "../../src/server/mcp-connections.ts";
import type {McpConnection} from "../../src/server/mcp-connections.ts";
import type {startInWorkspace} from "@kintsugi/workspace";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
const config={id:"stdio",name:"stdio",transport:"stdio",url:"",bearer:"",allowHttp:false,timeoutSeconds:2,enabled:true,workspaceId:"chosen-workspace",agentIds:["chosen-agent"],revision:1,command:["bun","/work/server.ts","literal;not-a-shell-command"],workdir:"/work/tools"} satisfies McpConnection;
for(const graceful of [true,false])test(`workspace stdio: helper-only execution, structured results and ${graceful?"graceful exit":"process-group cancellation"}`,async()=>{
  let output!:ReadableStreamDefaultController<Uint8Array>,errors!:ReadableStreamDefaultController<Uint8Array>,cancelled=false,ended=false;
  const exited=Promise.withResolvers<{exitCode:number}>(),calls:Parameters<typeof startInWorkspace>[]=[];
  const finish=()=>{if(ended)return;ended=true;output.close();errors.close();exited.resolve({exitCode:0});};
  const start:typeof startInWorkspace=(...args)=>{
    calls.push(args);return {stdout:new ReadableStream({start(controller){output=controller;}}),stderr:new ReadableStream({start(controller){errors=controller;}}),exited:exited.promise,
      write(data){const text=Buffer.from(data).toString();for(const line of text.split("\n").filter(Boolean)){
        // SAFETY: Only this test's SDK client writes to the isolated fake workspace process.
        const rpc=JSON.parse(line) as {id?:number;method:string};if(rpc.id===undefined)continue;
        const result=rpc.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"stdio-fixture",version:"1"}}:rpc.method==="tools/list"?{tools:[{name:"identity",inputSchema:{type:"object",properties:{}}}]}:{content:[{type:"text",text:"workspace-only"}],structuredContent:{workspace:"chosen-workspace",user:"agent"}};
        output.enqueue(new TextEncoder().encode(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result})+"\n"));
      }},closeStdin(){if(graceful)finish();},cancel(){cancelled=true;finish();},signal(){finish();},resize(){throw new Error("MCP must not request a terminal");}};
  };
  const {client,tools}=await connectMcpStdio(config,start);
  try{expect(tools.map(tool=>tool.name)).toEqual(["identity"]);expect((await client.callTool("identity",{})).structuredContent).toEqual({workspace:"chosen-workspace",user:"agent"});}
  finally{await client.close();}
  expect(calls).toHaveLength(1);expect(calls[0]![0]).toBe("chosen-workspace");expect(calls[0]![1]).toEqual({argv:config.command,user:"agent",workdir:"/work/tools",stdin:true});expect(cancelled).toBe(!graceful);expect(ended).toBe(true);
});
test("stdio config requires explicit arguments, clears HTTP credentials and survives reopen",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"mcp-stdio-"));try{
    const store=new McpConnectionStore(directory);await expect(store.save({...config,command:[]})).rejects.toThrow();await expect(store.save({...config,workdir:"relative"})).rejects.toThrow();
    await store.save({...config,url:"https://unused.example/mcp",bearer:"never-send-to-process",auth:"oauth",oauth:{clientSecret:"never-send-to-process"}});
    const reopened=new McpConnectionStore(directory);await reopened.load();expect(reopened.credential(config.id)).toMatchObject({transport:"stdio",command:config.command,bearer:"",url:""});expect(reopened.credential(config.id)?.oauth).toBeUndefined();
  }finally{await rm(directory,{recursive:true,force:true});}
});
