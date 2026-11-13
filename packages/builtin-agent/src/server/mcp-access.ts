import type {Agent,ConversationId,DocumentReader} from "@earendil-works/pi-durable";
import type {Context} from "@earendil-works/chord/context";
import {mcpNamespace} from "@earendil-works/pi-mcp";
import {mcpConnections} from "./mcp-connections.ts";
import {WorkspaceAgents} from "./durable-workspace.ts";
/** Hide ungranted schemas from code-mode prompt, search and declarations as well as rejecting their calls. */
export async function visibleMcpAgent(workspaceId:string,conversationId:ConversationId,agent:Agent,read:DocumentReader,context:Context):Promise<Agent>{
  if(!agent.callable.some(tool=>tool.name.startsWith("mcp__")))return agent;
  const servers=(await mcpConnections()).list().filter(server=>server.enabled&&server.workspaceId===workspaceId);
  const identity=(await read.snapshot(WorkspaceAgents,context))?.agents.find(record=>record.durableId===conversationId||record.branches?.includes(conversationId));
  const prefixes=identity&&!identity.readOnly?servers.filter(server=>!server.agentIds.length||server.agentIds.includes(identity.agentId)).map(server=>mcpNamespace(server.name)):[];
  return {...agent,callable:agent.callable.filter(tool=>!tool.name.startsWith("mcp__")||prefixes.some(prefix=>tool.name.startsWith(prefix)))};
}
