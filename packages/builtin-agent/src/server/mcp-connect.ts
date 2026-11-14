import {connectMcpHttp} from "./mcp-client.ts";
import {mcpConnectionConfig,type McpConnection} from "./mcp-connections.ts";
import {mcpOAuthVault} from "./mcp-oauth.ts";
import {connectMcpStdio} from "./mcp-stdio.ts";
export async function connectMcp(config:McpConnection,signal?:AbortSignal){
  const auth=config.transport!=="stdio"&&config.auth==="oauth"?mcpOAuthVault(config).authProvider():undefined;
  const connection=config.transport==="stdio"?await connectMcpStdio(config,undefined,signal):await connectMcpHttp(mcpConnectionConfig(config),fetch,auth,signal);
  return {...connection,async close(){await connection.client.close();await auth?.settled();}};
}
