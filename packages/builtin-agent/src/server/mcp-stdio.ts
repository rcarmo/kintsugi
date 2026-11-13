import {McpClient,PipeTransport,type McpPipe,type McpPipeHandlers} from "@earendil-works/pi-mcp";
import {startInWorkspace} from "@kintsugi/workspace";
import type {McpConnection} from "./mcp-connections.ts";
/** Only the workspace helper may launch this command, always as the unprivileged Agent user. */
export function workspaceMcpPipe(config:McpConnection,handlers:McpPipeHandlers,start:typeof startInWorkspace=startInWorkspace):McpPipe {
  if(config.transport!=="stdio"||!config.command?.length)throw new Error("Missing workspace MCP command.");
  const process=start(config.workspaceId,{argv:config.command,user:"agent",workdir:config.workdir||"/work",stdin:true});
  async function pump(stream:ReadableStream<Uint8Array>,receive:(bytes:Uint8Array)=>void){
    const reader=stream.getReader();try {while(true){const chunk=await reader.read();if(chunk.done)return;receive(chunk.value);}}finally{reader.releaseLock();}
  }
  const exited=Promise.all([process.exited,pump(process.stdout,handlers.onStdout),pump(process.stderr,handlers.onStderr)]).then(([exit])=>{
    if(exit.signal!==undefined||exit.exitCode!==0)throw new Error("Workspace MCP process exited unsuccessfully.");
  });
  return {write:data=>process.write(data),closeStdin:()=>process.closeStdin(),close:()=>process.cancel(),exited};
}
export async function connectMcpStdio(config:McpConnection,start:typeof startInWorkspace=startInWorkspace){
  const client=new McpClient({name:"kintsugi",version:"1",requestTimeoutMs:config.timeoutSeconds*1000});
  const transport=new PipeTransport({open:async handlers=>workspaceMcpPipe(config,handlers,start),maxMessageBytes:4*1024*1024,maxStderrBytes:16*1024,closeTimeoutMs:500});
  try {await client.connect(transport);return {client,tools:await client.listTools()};}
  catch(error){await client.close();throw error;}
}
