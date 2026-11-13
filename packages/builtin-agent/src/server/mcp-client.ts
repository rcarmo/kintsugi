import { McpClient, StreamableHttpTransport, createMcpToolName, normalizeMcpInputSchema, toLlmContent, type Tool as McpTool, type McpFetch, type AuthProvider } from "@earendil-works/pi-mcp";
import { defineExtension, defineTool, type JsonObject, type ConversationId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { Context } from "@earendil-works/chord/context";
export type McpHttpConnection = {id:string;name:string;url:string;bearer:string;allowHttp:boolean;timeoutSeconds:number};
export function mcpEndpoint(value:string,allowHttp=false):string {
  const url = new URL(value);
  if (!["https:","http:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error("Use an HTTP(S) MCP endpoint without credentials, query or fragment.");
  if (url.protocol === "http:" && !allowHttp) throw new Error("Allow HTTP for this trusted-network connection, or use HTTPS.");
  return url.href;
}
/** An authenticated Streamable HTTP session. No OAuth discovery is required for a Memento principal token. */
export async function connectMcpHttp(config:McpHttpConnection,fetcher:McpFetch = fetch,authProvider?:AuthProvider) {
  const endpoint = mcpEndpoint(config.url,config.allowHttp);
  if (!authProvider && (!config.bearer || /[\r\n]/.test(config.bearer))) throw new Error("Enter a bearer token without line breaks.");
  const client = new McpClient({name:"kintsugi",version:"1",requestTimeoutMs:config.timeoutSeconds*1000});
  const transport = new StreamableHttpTransport({url:endpoint,headers:authProvider?undefined:{Authorization:`Bearer ${config.bearer}`},authProvider,fetch:async (input,init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.href !== endpoint) throw new Error("MCP request left the configured endpoint.");
    return fetcher(input,{...init,redirect:"error"});
  }});
  try {await client.connect(transport);return {client,tools:await client.listTools()};}
  catch (error) {await client.close();throw error;}
}
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Transport exceptions are external input; expose only known status classes, never raw bodies.
export function mcpFailure(error:unknown):string {
  // External errors are deliberately not echoed: HTTP bodies may contain credentials or server diagnostics.
  if (error instanceof Error && error.name === "McpOAuthAuthorizationRequiredError") return "Sign in to this MCP server in Settings.";
  if (error instanceof Error && "status" in error) {
    if (error.status === 401) return "Authentication failed. Replace the server token.";
    if (error.status === 403) return "This credential is not allowed to perform that operation.";
    if (error.status === 404) return "The MCP endpoint or session is no longer available. Reconnect.";
  }
  return "MCP request failed. Check the endpoint, certificate and server availability.";
}
/** Register actual MCP tools behind code mode. Every call rechecks the grant and credential revision. */
export function mcpToolsExtension(config:Pick<McpHttpConnection,"id"|"name"> & {revision?:number},tools:readonly McpTool[],clientFor:(conversationId:ConversationId,context:Context) => Promise<McpClient>) {
  const details=(tool:string)=>({mcpConnectionId:config.id,mcpConnectionRevision:config.revision??0,mcpServer:config.name,mcpTool:tool});
  const taken = new Set<string>();
  const name = (remote:string) => {const value = createMcpToolName(config.name,remote,item => taken.has(item));taken.add(value);return value;};
  const registered = tools.map(tool => defineTool({
    name:name(tool.name),description:tool.description ?? tool.name,parameters:Type.Unsafe<JsonObject>(normalizeMcpInputSchema(tool.inputSchema)),structuredOutputSchema:tool.outputSchema,
    callers:["tools"],replay:"unsafe",
    async execute(args,api,context) {
      const client = await clientFor(api.conversationId,context);
      await api.details(details(tool.name),context);
      try {
        const result = await client.callTool(tool.name,args,{signal:context.abortSignal,onProgress:progress => api.output(`${progress.message ?? "MCP request in progress"}\n`)});
        return {output:toLlmContent(result),structuredOutput:result.structuredContent === undefined ? undefined : JSON.parse(JSON.stringify(result.structuredContent)),isError:result.isError === true,details:details(tool.name)};
      } catch (error) {context.abortSignal?.throwIfAborted();throw new Error(mcpFailure(error));}
    },
  }));
  // Memento's compact surface publishes its less-common contracts as resources, not tools.
  const resources = [defineTool({name:name("resources_list"),description:`List ${config.name} resources and URI templates.`,parameters:Type.Object({}),structuredOutputSchema:Type.Object({resources:Type.Array(Type.Unknown()),templates:Type.Array(Type.Unknown())}),callers:["tools"],replay:"unsafe",async execute(_args,api,context) {
    const client = await clientFor(api.conversationId,context);
    try {const resources = client.serverCapabilities?.resources ? await client.listResources({signal:context.abortSignal}) : [],templates = client.serverCapabilities?.resources ? await client.listResourceTemplates({signal:context.abortSignal}) : [];
      return {structuredOutput:JSON.parse(JSON.stringify({resources,templates})),details:details("resources_list")};
    } catch (error) {context.abortSignal?.throwIfAborted();throw new Error(mcpFailure(error));}
  }}),defineTool({name:name("resource_read"),description:`Read a discovered ${config.name} resource URI, including memory://catalog and advertised workflow templates.`,parameters:Type.Object({uri:Type.String({minLength:1,maxLength:2048})}),structuredOutputSchema:Type.Object({contents:Type.Array(Type.Unknown())}),callers:["tools"],replay:"unsafe",async execute(args,api,context) {
    const client = await clientFor(api.conversationId,context);
    try {return {structuredOutput:JSON.parse(JSON.stringify(await client.readResource(args.uri,{signal:context.abortSignal}))),details:details("resource_read")};}
    catch (error) {context.abortSignal?.throwIfAborted();throw new Error(mcpFailure(error));}
  }})];
  return defineExtension({name:`kintsugi.mcp.${config.id}`,tools:[...registered,...resources]});
}
