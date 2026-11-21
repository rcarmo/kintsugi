import type { KintsugiEventBus } from "@kintsugi/core";
import type { WorkspaceWorkViewReference } from "@kintsugi/shared";
import { Type, type TSchema } from "typebox";
import { defineWorkspaceTool, type WorkspaceTool } from "./workspace-tool.ts";

export interface WorkspaceAgentToolOptions {
  agentId?: string;
  events?: KintsugiEventBus;
  /** Only Kintsugi's own transcript renders artifact-preview: URLs. */
  embeds?: boolean;
}

export interface WorkspacePresenterDeps {
  events?: KintsugiEventBus;
  presentWorkView(reference: WorkspaceWorkViewReference): Promise<void>;
}

type WorkspaceAgentToolFactory = (workspaceId: string, options: WorkspaceAgentToolOptions) => WorkspaceTool<any, any> | undefined;

export interface WorkspacePresenterDefinition<Params extends { kind: string } = { kind: string }> {
  kind: Params["kind"];
  description: string;
  parameters: Record<string, TSchema>;
  execute(toolCallId: string, params: Params): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

type WorkspacePresenterFactory = (workspaceId: string, options: WorkspaceAgentToolOptions) => WorkspacePresenterDefinition<any>;

const registeredWorkspaceAgentTools = new Map<string, WorkspaceAgentToolFactory>();
const registeredWorkspacePresenters = new Map<string, WorkspacePresenterFactory>();

export function registerWorkspaceAgentTool(name: string, factory: WorkspaceAgentToolFactory): () => void {
  registeredWorkspaceAgentTools.set(name, factory);
  return () => {
    if (registeredWorkspaceAgentTools.get(name) === factory) registeredWorkspaceAgentTools.delete(name);
  };
}

export function registerWorkspacePresenter(kind: string, factory: WorkspacePresenterFactory): () => void {
  registeredWorkspacePresenters.set(kind, factory);
  return () => {
    if (registeredWorkspacePresenters.get(kind) === factory) registeredWorkspacePresenters.delete(kind);
  };
}

const presentEmbedHint = " Images, videos, SVGs, and HTML files are already automatically visible to the user when you reference them with an Kintsugi embed URL in Markdown image syntax, for example: ![](artifact-preview:/work/app/screenshot.png) or ![](artifact-preview:/work/app/demo.html).";

function createPresentTool(workspaceId: string, options: WorkspaceAgentToolOptions): WorkspaceTool<any, any> | undefined {
  const presenters = [...registeredWorkspacePresenters.values()].map((factory) => factory(workspaceId, options));
  if (!presenters.length) return undefined;
  const kinds = presenters.map((presenter) => presenter.kind);
  const presenterParameters = Object.fromEntries(presenters.flatMap((presenter) =>
    Object.entries(presenter.parameters).map(([name, schema]) => [name, Type.Optional(schema)]),
  ));
  return defineWorkspaceTool({
    name: "present",
    label: "Present",
    description: "Present one primary interactive surface to the user in Kintsugi. Use this when the user should look at or interact with while evaluating your work. Kintsugi will place the chosen surface in the preview area. Calling this again should update or replace the primary presentation rather than adding multiple competing presentations. Do not use this tool for static or inline artifacts." + (options.embeds ? presentEmbedHint : "") + presenters.map((presenter) => `${presenter.kind}: ${presenter.description}`).join(" "),
    // Moonshot requires function parameters to be one top-level object, not a union.
    parameters: Type.Object({
      kind: Type.String({ enum: kinds, description: `Surface to present. One of: ${kinds.join(", ")}.` }),
      ...presenterParameters,
    }),
    execute: async (toolCallId: string, params: { kind: string }) => {
      const presenter = presenters.find((candidate) => candidate.kind === params.kind);
      if (!presenter) throw new Error(`unknown presentation kind: ${params.kind}`);
      return await presenter.execute(toolCallId, params);
    },
  });
}

export function createKintsugiControlTools(workspaceId: string, options: WorkspaceAgentToolOptions = {}): WorkspaceTool<any, any>[] {
  const present = createPresentTool(workspaceId, options);
  const external = [...registeredWorkspaceAgentTools.values()].flatMap((factory) => { const tool = factory(workspaceId, options); return tool ? [tool] : []; });
  return [...(present ? [present] : []), ...external];
}
