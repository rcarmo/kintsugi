import { instanceCredentialInputSchema } from "@kintsugi/workspace-templates";
import { workspaceResourceChangeSchema } from "@kintsugi/shared/workspace-resources";
import { workspaceTemplateSecretPathPermissionSchema } from "@kintsugi/workspace-templates";
import { emptyWorkspaceCommandInputSchema, type WorkspaceModuleCommandHandler } from "@kintsugi/shared";
import type { TSchema } from "typebox";
import { closeWorkViewRequestSchema, reorderWorkViewRequestSchema, workViewReferenceSchema } from "./work-view-api.ts";

const errorResponse = {
  description: "Request failed",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};
const jsonResponse = (description: string, schema: TSchema, status = "200") => ({
  [status]: { description, content: { "application/json": { schema } } },
  "400": errorResponse,
  "404": errorResponse,
});
const jsonAndHtmlResponse = (description: string, schema: TSchema) => ({
  ...jsonResponse(description, schema),
  "200": { description, content: { "application/json": { schema }, "text/html": { schema: { type: "string" } } } },
});
const workspaceId = { name: "id", in: "path", required: true, schema: { type: "string" } };
const agent = { name: "agent", in: "query", required: false, description: "Agent to select in the browser surface.", schema: { type: "string" } };
const selectedWorkView = { name: "workView", in: "query", required: false, description: "Work-view key to select and reveal in the browser surface.", schema: { type: "string" } };
const workspaceTemplateId = { name: "workspaceTemplateId", in: "path", required: true, schema: { type: "string" } };
const variableId = { name: "variableId", in: "path", required: true, schema: { type: "string" } };
const secretId = { name: "secretId", in: "path", required: true, schema: { type: "string" } };
const workspaceTemplateSettingsSection = { name: "section", in: "query", required: false, schema: { type: "string", enum: ["index", "general", "global-secrets", "global-ssh", "global-environment", "global-network", "global-buckets", "secrets", "ssh", "environment", "network", "buckets", "container", "developer", "repository", "ssh-keys", "dockerfile", "preload-images", "privileged", "danger"] } };
const globalViewTemplate = { name: "workspaceTemplate", in: "query", required: false, description: "Browser forms only: re-render this template's settings after the change instead of Settings.", schema: { type: "string" } };
const settingsSection = { name: "section", in: "query", required: false, schema: { type: "string" } };
const htmlSurfaceResponses = (description: string) => ({ "200": { description, content: { "text/html": { schema: { type: "string" } } } }, "400": errorResponse, "404": errorResponse });
const agentId = { name: "agentId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const jsonBody = (schema: TSchema) => ({ required: true, content: { "application/json": { schema } } });
const emptyObjectSchema = { type: "object", additionalProperties: false };
const workspaceWarningsSchema = { type: "array", description: "Current Workspace warnings. Running Workspace details add each warning's title, dismissal state, and action.", items: { type: "object", required: ["kind", "message"], properties: { kind: { type: "string", description: "preparation, image, naming, or project-settings-changed" }, title: { type: "string" }, message: { type: "string" }, state: { type: "string" }, action: { type: "object", properties: { href: { type: "string" }, caption: { type: "string" } } } } } };
const workspaceTemplateSecretInputSchema = { type: "object", required: ["envName", "hostPattern"], properties: { envName: { type: "string" }, hostPattern: { type: "string" }, allowInPath: workspaceTemplateSecretPathPermissionSchema, placeholder: { type: "string" }, annotation: { type: "string", description: "What this secret is needed for" }, secretValue: { type: "string", writeOnly: true } }, additionalProperties: false };
const sshKnownHostsSchema = { type: "object", required: ["knownHosts"], properties: { knownHosts: { type: "string", description: "Operator-verified known_hosts entries; empty clears additional trust. GitHub, GitLab and Bitbucket are trusted by default." } } };
const changeBucketsSchema = { type: "object", required: ["changeBuckets"], properties: { changeBuckets: { type: "string", examples: ["Tests: *Test.* *.test.* tests/\nEvals: evals/"], description: "One bucket per line: a name, a colon, then space-separated patterns. Patterns without a slash match file names anywhere, a trailing slash matches a folder anywhere, other slashes match from the repository root, and ! excludes. Files go in the first matching bucket; the rest are the main work. A template's bucket replaces the global bucket with the same name; a template bucket without patterns turns the global one off. Global settings use built-in Tests and Evals buckets until saved." } } };
const workspaceTemplateSummaryProperties = { swatchColor: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", description: "Custom swatch color; absent when using the automatic template color" }, seedConfigEnabled: { type: "boolean", description: "Host-authorized Kintsugi-in-Kintsugi seeding; defaults to false" }, createdAt: { type: "number", description: "Unix timestamp in milliseconds when the template was added; absent for templates added before this was recorded" }, lastUsedAt: { type: "number", description: "Unix timestamp in milliseconds of the most recent use: adding the template or creating a workspace from it" }, lastWorkspaceCreatedAt: { type: "number", description: "Unix timestamp in milliseconds of the most recent workspace creation from this template; absent if none has been recorded" }, configurationFingerprint: { type: "string", description: "Opaque fingerprint of workspace setup settings" }, id: { type: "string" }, name: { type: "string" }, gitUrl: { type: "string" }, branch: { type: ["string", "null"] }, sessionShareKey: { type: "string" }, privileged: { type: "boolean", default: false, description: "Host-authorized privileged mode for future workspaces; enables Docker at the cost of host isolation" }, dockerfile: { type: "string" }, preloadImages: { type: "array", items: { type: "string" }, description: "Images prepared before newly created workspaces become ready. Does not change existing workspaces." } };
const agentSummarySchema = {
  type: "object",
  required: ["id", "title"],
  properties: { id: { type: "string", format: "uuid" }, title: { type: "string" }, agentTypeId: { type: "string" }, busy: { type: "boolean" }, requestingAttention: { type: "boolean" } },
  additionalProperties: false,
};

export function kintsugiOpenApi(commands: WorkspaceModuleCommandHandler[], contributedPaths: Record<string, import("@kintsugi/core").JsonObject> = {}) {
  const commandSchemas = Object.fromEntries(commands.map((command) => [command.id, command.inputSchema ?? emptyWorkspaceCommandInputSchema]));
  const closeAgentPath = { post: {
    summary: "Close an Agent using its Agent type lifecycle",
    description: "Closing retains the Agent transcript, but the closed Agent cannot be reopened or resumed.",
    parameters: [workspaceId, agentId],
    responses: {
      ...jsonResponse("Agent closed", { $ref: "#/components/schemas/AgentCloseResult" }),
    },
  } };
  const agentMessageResponses = {
    ...jsonResponse("Message accepted", { $ref: "#/components/schemas/AgentStateEnvelope" }, "202"),
    "200": { description: "Agent command completed", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentStateEnvelope" } } } },
    "307": { description: "/park redirects to the workspace park operation, preserving the POST method and Accept header", headers: { Location: { schema: { type: "string" } } } },
    "422": { description: "The submission has no prompt or completed attachment", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Kintsugi automation interface",
      version: "1.0.0",
      description: "JSON representations of Kintsugi's content-negotiated UI operations. Send Accept: application/json. Mutations and WebSocket upgrades require Origin to match the public destination origin (scheme, hostname, and port). Missing, null, or foreign origins receive a plain-text 403. No origin allowlist or management authentication is required.",
    },
    paths: {
      "/settings/credentials": {
        get: { summary: "List instance credential metadata and recent management events; never values", responses: jsonResponse("Credential metadata", { type: "object" }) },
        post: { summary: "Create an encrypted instance credential with explicit template grants", requestBody: jsonBody(instanceCredentialInputSchema), responses: jsonResponse("Credential metadata", { type: "object" }) },
      },
      "/settings/credentials/{credentialId}": { post: { summary: "Update grants, disable or rotate an instance credential; values are write-only", parameters: [{ name: "credentialId", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody(instanceCredentialInputSchema), responses: jsonResponse("Credential metadata", { type: "object" }) } },
      "/settings/credentials/{credentialId}/delete": { post: { summary: "Delete a credential and revoke its template grants", parameters: [{ name: "credentialId", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Deleted credential metadata", { type: "object" }) } },
      "/agent-types": { get: { summary: "List available agent types, default first", responses: jsonResponse("Agent types and installation-wide default", { type: "object", properties: { defaultAgentTypeId: { type: "string" }, agentTypes: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } } } } }) } },
      "/design-system-catalogue.html": { get: { summary: "Browse design-system components, usage and edge-case playgrounds", responses: { "200": { description: "Server-rendered package catalogue", content: { "text/html": { schema: { type: "string" } } } } } } },
      ...contributedPaths,
      "/up": { get: { summary: "Health check", responses: { "200": { description: "Kintsugi is healthy", content: { "text/plain": { schema: { type: "string" } } } } } } },
      "/workspaces": {
        get: { summary: "List workspaces", responses: jsonResponse("Workspace summaries", { type: "object", required: ["workspaces"], properties: { workspaces: { type: "array", items: { $ref: "#/components/schemas/WorkspaceSummary" } } } }) },
        post: { summary: "Create a workspace asynchronously", requestBody: jsonBody({ $ref: "#/components/schemas/CreateWorkspace" }), responses: { ...jsonResponse("Workspace creation accepted", { $ref: "#/components/schemas/WorkspaceEnvelope" }, "202"), "409": { ...errorResponse, description: "Agent setup required; error.setupUrl identifies its connection flow" } } },
      },
      "/workspace-templates": {
        get: { summary: "List workspace templates", responses: jsonResponse("Workspace template summaries", { type: "object", required: ["workspaceTemplates"], properties: { workspaceTemplates: { type: "array", items: { $ref: "#/components/schemas/WorkspaceTemplateSummary" } } } }) },
        post: { summary: "Create or resolve a workspace template", description: "Creates a workspace template, or resolves and returns the existing one when the same repository specification was previously added.", requestBody: jsonBody({ type: "object", required: ["gitUrl"], properties: { gitUrl: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Workspace template created or resolved", { $ref: "#/components/schemas/WorkspaceTemplateEnvelope" }) },
      },
      "/workspace-templates/new": { get: { summary: "Present the add-template screen", responses: htmlSurfaceResponses("Kintsugi with the add-template screen open") } },
      "/workspaces/new": { get: { summary: "Present the launch composer for an empty workspace", responses: htmlSurfaceResponses("Kintsugi with the workspace composer open") } },
      "/settings": { get: { summary: "Present Settings", description: "App-level preferences and shared configuration, separate from Workspace template configuration and per-Agent choices.", parameters: [settingsSection], responses: htmlSurfaceResponses("Kintsugi with Settings open") } },
      "/workspace-templates/{workspaceTemplateId}": {
        get: { summary: "Inspect workspace template configuration", parameters: [workspaceTemplateId], responses: jsonResponse("Workspace template configuration", { $ref: "#/components/schemas/WorkspaceTemplateConfigurationEnvelope" }) },
        post: { summary: "Update a workspace template", parameters: [workspaceTemplateId], requestBody: jsonBody({ type: "object", required: ["name", "gitUrl"], properties: { name: { type: "string" }, gitUrl: { type: "string" }, swatchColor: { type: "string", pattern: "^(#[0-9a-fA-F]{6})?$", description: "Omit to keep the color; empty string restores the automatic color" } }, additionalProperties: false }), responses: jsonResponse("Workspace template updated", { $ref: "#/components/schemas/WorkspaceTemplateEnvelope" }) },
      },
      "/workspace-templates/{workspaceTemplateId}/ssh-keys/{keyId}/public-key": {
        get: {
          summary: "Derive the public key from a stored template private key",
          parameters: [workspaceTemplateId, { name: "keyId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OpenSSH public key", content: { "text/plain": { schema: { type: "string" } } } } },
        },
      },
      "/workspace-templates/{workspaceTemplateId}/ssh-known-hosts": {
        get: { summary: "Read explicitly trusted SSH server keys", parameters: [workspaceTemplateId], responses: jsonResponse("Trusted host keys", sshKnownHostsSchema) },
        post: { summary: "Save operator-verified known_hosts entries for future workspace preparation", parameters: [workspaceTemplateId], requestBody: jsonBody(sshKnownHostsSchema), responses: jsonResponse("Trusted host keys saved", sshKnownHostsSchema) },
      },
      "/workspace-templates/{workspaceTemplateId}/change-buckets": {
        get: { summary: "Read this template's Changes buckets", parameters: [workspaceTemplateId], responses: jsonResponse("Change buckets", changeBucketsSchema) },
        post: { summary: "Replace this template's Changes buckets", parameters: [workspaceTemplateId], requestBody: jsonBody(changeBucketsSchema), responses: jsonResponse("Change buckets saved", changeBucketsSchema) },
      },
      "/workspace-templates/{workspaceTemplateId}/settings": {
        get: {
          summary: "Present workspace template settings",
          description: "A non-modal settings index with focused section and record editors. Use section=index for the overview; without a section, the overview opens. Use its URL with the presentation tool.",
          parameters: [workspaceTemplateId, workspaceTemplateSettingsSection, { name: "editor", in: "query", required: false, description: "Record ID or new for Secrets, SSH access and Environment; docker, images or dockerfile for Container.", schema: { type: "string" } }],
          responses: htmlSurfaceResponses("Kintsugi with workspace template settings open"),
        },
      },
      "/workspace-templates/{workspaceTemplateId}/workspaces/new": { get: { summary: "Present the launch composer for a workspace from this template", parameters: [workspaceTemplateId], responses: htmlSurfaceResponses("Kintsugi with the launch composer open") } },
      "/workspace-templates/{workspaceTemplateId}/preload-images": { post: { summary: "Set images to preload in future workspaces from this template", description: "Replaces the image list. An empty array disables preloading. Existing workspaces are unchanged.", parameters: [workspaceTemplateId], requestBody: jsonBody({ type: "object", required: ["preloadImages"], properties: { preloadImages: { type: "array", items: { type: "string" } } }, additionalProperties: false }), responses: jsonResponse("Preload images saved", { $ref: "#/components/schemas/WorkspaceTemplateEnvelope" }) } },
      "/workspace-templates/{workspaceTemplateId}/seed-config": { post: { summary: "Authorize Kintsugi-in-Kintsugi configuration seeding for new workspaces", description: "Defaults to false. Allows repository manifests to copy host model credentials and template configuration. Existing workspaces are unchanged.", parameters: [workspaceTemplateId], requestBody: jsonBody({ type: "object", required: ["seedConfigEnabled"], properties: { seedConfigEnabled: { type: "boolean" } }, additionalProperties: false }), responses: jsonResponse("Seeding permission saved", { $ref: "#/components/schemas/WorkspaceTemplateEnvelope" }) } },
      "/workspace-templates/{workspaceTemplateId}/privileged": { post: { summary: "Set privileged mode for future workspaces from this template", description: "Defaults to false. Enables Docker inside workspaces at the cost of host isolation: agents can access host devices and may read or modify host data. Existing workspaces are unchanged.", parameters: [workspaceTemplateId], requestBody: jsonBody({ type: "object", required: ["privileged"], properties: { privileged: { type: "boolean" } }, additionalProperties: false }), responses: jsonResponse("Privileged mode saved", { $ref: "#/components/schemas/WorkspaceTemplateEnvelope" }) } },
      "/workspace-templates/{workspaceTemplateId}/dockerfile": { post: { summary: "Set the workspace template Dockerfile override", description: "Must start with FROM kintsugi-workspace. An empty string clears the override. Takes priority over .kintsugi/Dockerfile for new workspaces.", parameters: [workspaceTemplateId], requestBody: jsonBody({ type: "object", required: ["dockerfile"], properties: { dockerfile: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Dockerfile saved", { $ref: "#/components/schemas/WorkspaceTemplateEnvelope" }) } },
      "/workspace-templates/{workspaceTemplateId}/environment": { post: { summary: "Create a workspace template environment variable", parameters: [workspaceTemplateId], requestBody: jsonBody({ $ref: "#/components/schemas/EnvironmentVariableInput" }), responses: jsonResponse("Environment variable created", { $ref: "#/components/schemas/EnvironmentVariableEnvelope" }) } },
      "/workspace-templates/{workspaceTemplateId}/environment/{variableId}": { post: { summary: "Update a workspace template environment variable", parameters: [workspaceTemplateId, variableId], requestBody: jsonBody({ $ref: "#/components/schemas/EnvironmentVariableInput" }), responses: jsonResponse("Environment variable updated", { $ref: "#/components/schemas/EnvironmentVariableEnvelope" }) } },
      "/workspace-templates/{workspaceTemplateId}/environment/{variableId}/delete": { post: { summary: "Delete a workspace template environment variable", parameters: [workspaceTemplateId, variableId], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Environment variable deleted", { type: "object", required: ["deleted", "environmentVariable"], properties: { deleted: { const: true }, environmentVariable: { $ref: "#/components/schemas/EnvironmentVariable" } } }) } },
      "/workspace-templates/{workspaceTemplateId}/secrets": { post: { summary: "Create a workspace template secret", description: "Omit secretValue to declare a secret without a value. Values are encrypted and never returned.", parameters: [workspaceTemplateId], requestBody: jsonBody({ $ref: "#/components/schemas/CreateSecret" }), responses: jsonResponse("Secret metadata created", { $ref: "#/components/schemas/SecretEnvelope" }) } },
      "/workspace-templates/{workspaceTemplateId}/secrets/{secretId}": { post: { summary: "Update a workspace template secret", description: "Omit secretValue to preserve the stored secret. The value is never returned.", parameters: [workspaceTemplateId, secretId], requestBody: jsonBody({ $ref: "#/components/schemas/UpdateSecret" }), responses: jsonResponse("Secret metadata updated", { $ref: "#/components/schemas/SecretEnvelope" }) } },
      "/workspace-templates/{workspaceTemplateId}/secrets/{secretId}/delete": { post: { summary: "Delete a workspace template secret", parameters: [workspaceTemplateId, secretId], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Secret deleted", { type: "object", required: ["deleted", "secret"], properties: { deleted: { const: true }, secret: { $ref: "#/components/schemas/SecretSummary" } } }) } },
      "/global-workspace-settings": { get: { summary: "Inspect global workspace settings", description: "Secrets, SSH keys, trusted SSH servers and Environment variables for every new workspace, including empty workspaces. A template's own entry with the same name wins.", responses: jsonResponse("Global workspace settings", { type: "object", required: ["globalWorkspaceSettings"], properties: { globalWorkspaceSettings: { type: "object", required: ["environment", "secrets", "sshKeys", "sshKnownHosts"], properties: { environment: { type: "array", items: { $ref: "#/components/schemas/EnvironmentVariable" } }, secrets: { type: "array", items: { $ref: "#/components/schemas/SecretSummary" } }, sshKeys: { type: "array", items: { type: "object", required: ["id", "keyType", "createdAt"], properties: { id: { type: "string" }, name: { type: "string" }, keyType: { type: "string" }, createdAt: { type: "string", format: "date-time" } } } }, sshKnownHosts: { type: "string" } } } } }) } },
      "/global-workspace-settings/environment": { post: { summary: "Create a global environment variable", parameters: [globalViewTemplate], requestBody: jsonBody({ $ref: "#/components/schemas/EnvironmentVariableInput" }), responses: jsonResponse("Environment variable created", { $ref: "#/components/schemas/EnvironmentVariableEnvelope" }) } },
      "/global-workspace-settings/environment/{variableId}": { post: { summary: "Update a global environment variable", parameters: [variableId, globalViewTemplate], requestBody: jsonBody({ $ref: "#/components/schemas/EnvironmentVariableInput" }), responses: jsonResponse("Environment variable updated", { $ref: "#/components/schemas/EnvironmentVariableEnvelope" }) } },
      "/global-workspace-settings/environment/{variableId}/delete": { post: { summary: "Delete a global environment variable", parameters: [variableId, globalViewTemplate], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Environment variable deleted", { type: "object", required: ["deleted", "environmentVariable"], properties: { deleted: { const: true }, environmentVariable: { $ref: "#/components/schemas/EnvironmentVariable" } } }) } },
      "/global-workspace-settings/secrets": { post: { summary: "Create a global secret", description: "Omit secretValue to declare a secret without a value. Values are encrypted and never returned.", parameters: [globalViewTemplate], requestBody: jsonBody({ $ref: "#/components/schemas/CreateSecret" }), responses: jsonResponse("Secret metadata created", { $ref: "#/components/schemas/SecretEnvelope" }) } },
      "/global-workspace-settings/secrets/{secretId}": { post: { summary: "Update a global secret", description: "Omit secretValue to preserve the stored secret. The value is never returned.", parameters: [secretId, globalViewTemplate], requestBody: jsonBody({ $ref: "#/components/schemas/UpdateSecret" }), responses: jsonResponse("Secret metadata updated", { $ref: "#/components/schemas/SecretEnvelope" }) } },
      "/global-workspace-settings/secrets/{secretId}/delete": { post: { summary: "Delete a global secret", parameters: [secretId, globalViewTemplate], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Secret deleted", { type: "object", required: ["deleted", "secret"], properties: { deleted: { const: true }, secret: { $ref: "#/components/schemas/SecretSummary" } } }) } },
      "/global-workspace-settings/ssh-keys/{keyId}/public-key": { get: { summary: "Derive the public key from a stored global private key", parameters: [{ name: "keyId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OpenSSH public key", content: { "text/plain": { schema: { type: "string" } } } } } } },
      "/global-workspace-settings/ssh-known-hosts": {
        get: { summary: "Read SSH server keys trusted by every workspace", responses: jsonResponse("Trusted host keys", sshKnownHostsSchema) },
        post: { summary: "Save operator-verified known_hosts entries for every future workspace", parameters: [globalViewTemplate], requestBody: jsonBody(sshKnownHostsSchema), responses: jsonResponse("Trusted host keys saved", sshKnownHostsSchema) },
      },
      "/global-workspace-settings/change-buckets": {
        get: { summary: "Read Changes buckets for every workspace", responses: jsonResponse("Change buckets", changeBucketsSchema) },
        post: { summary: "Replace Changes buckets for every workspace", parameters: [globalViewTemplate], requestBody: jsonBody(changeBucketsSchema), responses: jsonResponse("Change buckets saved", changeBucketsSchema) },
      },
      "/workspace-templates/{workspaceTemplateId}/delete": { post: { summary: "Delete a workspace template", parameters: [workspaceTemplateId], requestBody: jsonBody(emptyObjectSchema), responses: jsonResponse("Workspace template deleted or blocked by workspace references", { $ref: "#/components/schemas/DeleteWorkspaceTemplateResult" }) } },
      "/workspaces/{id}": { get: { summary: "Inspect or present a workspace", description: "JSON requests inspect workspace state. Browser navigation presents the workspace and can select an Agent or Work view.", parameters: [workspaceId, agent, selectedWorkView], responses: jsonAndHtmlResponse("Workspace state or browser surface", { $ref: "#/components/schemas/WorkspaceEnvelope" }) } },
      "/global-workspace-settings/private-network-access": { get: { summary: "Read global exact private TCP destinations", responses: jsonResponse("Configured destinations", { type: "object", properties: { privateNetworkAccess: { type: "array", items: { type: "string" } } } }) }, post: { summary: "Store global exact private TCP destinations; this does not enable access", requestBody: jsonBody({ type: "object", required: ["privateNetworkAccess"], properties: { privateNetworkAccess: { type: "array", maxItems: 128, items: { type: "string", maxLength: 300 } } }, additionalProperties: false }), responses: jsonResponse("Configured destinations", { type: "object" }) } },
      "/workspace-templates/{workspaceTemplateId}/private-network-access": { get: { summary: "Read template exact private TCP destinations", parameters: [workspaceTemplateId], responses: jsonResponse("Configured destinations", { type: "object" }) }, post: { summary: "Store template exact private TCP destinations; this does not enable access", parameters: [workspaceTemplateId], requestBody: jsonBody({ type: "object", required: ["privateNetworkAccess"], properties: { privateNetworkAccess: { type: "array", maxItems: 128, items: { type: "string", maxLength: 300 } } }, additionalProperties: false }), responses: jsonResponse("Configured destinations", { type: "object" }) } },
      "/settings/workspace-resources": { get: { summary: "Read the installation-wide maximum RAM per workspace", responses: jsonResponse("Workspace RAM policy", { type: "object", properties: { workspaceMemoryPolicy: { type: "object", required: ["maximumMemory", "capacity", "defaultMemory"], properties: { maximumMemory: { type: "integer", description: "Effective hard cap in bytes" }, configuredMaximumMemory: { type: "integer" }, capacity: { type: "integer", description: "Installation-derived ceiling in bytes" }, defaultMemory: { type: "integer" } } } } }) }, post: { summary: "Set the hard RAM cap for every workspace", description: "Requires System compatibility version 4. Conflicting saved or running workspace limits must be lowered first; no workspaces are restarted or silently resized.", requestBody: jsonBody({ type: "object", additionalProperties: false, required: ["maximumMemory"], properties: { maximumMemory: { type: "integer", minimum: 6291456, maximum: 1099511627776, description: "RAM bytes; swap is separate" } } }), responses: { "200": { description: "Policy saved" }, "400": { description: "Invalid policy" }, "409": { description: "Conflicting allocation or installation capacity" } } } },
      "/settings/network": { get: { summary: "Read installation LAN CIDRs and DNS forwarders", responses: { "200": { description: "Network configuration" } } }, post: { summary: "Save installation network settings; workspace restart required", requestBody: jsonBody({ type: "object", required: ["cidrs", "dns", "search"], properties: { cidrs: { type: "array", maxItems: 64, items: { type: "string" } }, dns: { type: "array", maxItems: 3, items: { type: "string" } }, search: { type: "array", maxItems: 6, items: { type: "string" } } }, additionalProperties: false }), responses: { "200": { description: "Network configuration saved" } } } },
      "/workspaces/{id}/resources": { get: { summary: "Inspect desired, Docker and cgroup resource limits without starting the workspace", parameters: [workspaceId], responses: jsonResponse("Resource snapshot", {type: "object", properties: {resources: {type: "object"}}}) }, post: {summary: "Persist and apply finite RAM, additional swap and CPU limits", parameters: [workspaceId], requestBody: jsonBody(workspaceResourceChangeSchema), responses: {...jsonResponse("Applied resource snapshot", {type: "object", properties: {resources: {type: "object"}}}), "409": errorResponse, "503": errorResponse}} },
      "/workspaces/{id}/properties": {get: {summary: "Open workspace properties", parameters: [workspaceId], responses: htmlSurfaceResponses("Workspace properties dialog")}},
      "/workspaces/{id}/network": { get: { summary: "Read desired and applied workspace network permissions", parameters: [workspaceId], responses: { "200": { description: "Network permissions and restart status" } } }, post: { summary: "Set persistent workspace LAN permissions; restart required", parameters: [workspaceId], requestBody: jsonBody({ type: "object", required: ["mode"], properties: { mode: { type: "string", enum: ["off", "lan", "private", "hosts"] } }, additionalProperties: false }), responses: { "200": { description: "Network permissions saved" } } } },
      "/workspaces/{id}/sidebar-title": { post: { summary: "Rename a workspace", parameters: [workspaceId], requestBody: jsonBody({ type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Workspace renamed", { $ref: "#/components/schemas/WorkspaceEnvelope" }) } },
      "/workspaces/{id}/warnings/{kind}/dismiss": { post: { summary: "Dismiss the current workspace warning state", parameters: [workspaceId, { name: "kind", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", required: ["state"], properties: { state: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Warning dismissed", { type: "object", required: ["dismissed"], properties: { dismissed: { const: true } } }) } },
      "/workspaces/{id}/provisioning/continue": { post: { summary: "Retry preparation or explicitly continue after a failed step", parameters: [workspaceId, { name: "action", in: "query", schema: { type: "string", enum: ["retry"] }, description: "Retry failed workspace runtime preparation instead of bypassing it." }], responses: { ...jsonResponse("Workspace provisioning resumed", { type: "object", required: ["continued", "stepId"], properties: { continued: { const: true }, stepId: { type: "string" } }, additionalProperties: false }), "409": errorResponse } } },
      "/workspaces/{id}/commands/{commandId}": { post: { summary: "Execute a workspace command", parameters: [workspaceId, { name: "commandId", in: "path", required: true, schema: { type: "string", enum: Object.keys(commandSchemas) } }], requestBody: jsonBody({ anyOf: Object.values(commandSchemas) }), responses: { ...jsonResponse("Command executed", { $ref: "#/components/schemas/CommandResult" }), "409": { ...errorResponse, description: "Agent setup required; error.setupUrl identifies its connection flow" } }, "x-kintsugi-command-schemas": commandSchemas } },
      "/workspaces/{id}/browser/{browserId}/navigate": { post: { summary: "Navigate a Browser view", parameters: [workspaceId, { name: "browserId", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ type: "object", required: ["url"], properties: { url: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Browser navigated", { type: "object" }) } },
      "/workspaces/{id}/work-views/reorder": { post: { summary: "Reorder a typed Work view", parameters: [workspaceId], requestBody: jsonBody(reorderWorkViewRequestSchema), responses: jsonResponse("Work views reordered", { $ref: "#/components/schemas/WorkViewsEnvelope" }) } },
      "/workspaces/{id}/work-views/{key}/attention/request": { post: { summary: "Request attention for a Work view without changing the visible destination", parameters: [workspaceId, { name: "key", in: "path", required: true, schema: { type: "string" } }], responses: jsonResponse("Attention requested", { type: "object" }) } },
      "/workspaces/{id}/work-views/close": { post: { summary: "Close a typed Work view", parameters: [workspaceId], requestBody: jsonBody(closeWorkViewRequestSchema), responses: jsonResponse("Work view closed", { $ref: "#/components/schemas/WorkViewsEnvelope" }) } },
      "/workspaces/{id}/agents/{agentId}/close": closeAgentPath,
      "/workspaces/{id}/park": { post: { summary: "Park a workspace", parameters: [workspaceId, { name: "force", in: "query", schema: { type: "string", enum: ["1"] }, description: "Close terminal and VS Code views before parking. Without confirmation, returns 409 if these views are open." }], responses: { ...jsonResponse("Workspace parked", { type: "object" }), "409": errorResponse } } },
      "/workspaces/{id}/unpark": { post: { summary: "Unpark a workspace", parameters: [workspaceId], responses: jsonResponse("Workspace unparked", { type: "object" }) } },
      "/workspaces/{id}/delete": { post: { summary: "Delete a workspace", parameters: [workspaceId], requestBody: jsonBody({ type: "object", properties: { force: { type: "boolean" } }, additionalProperties: false }), responses: jsonResponse("Workspace deletion scheduled or blocked", { type: "object" }) } },
      "/workspaces/{id}/agents/{agentId}/messages": { post: { summary: "Submit or steer an agent message", parameters: [workspaceId, agentId], requestBody: jsonBody({ type: "object", required: ["text"], properties: { text: { type: "string" }, requestId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$", description: "Caller-generated message identity. Reuse on retries to return the original admission without submitting another message." }, mode: { type: "string", enum: ["send", "steer", "followUp"], description: "Builtin only. While the agent is working, steer (the default) joins the running turn; send and followUp wait until it finishes." } }, additionalProperties: false }), responses: agentMessageResponses } },
      "/workspaces/{id}/agents/{agentId}/model": { post: { summary: "Select an agent model", parameters: [workspaceId, agentId], requestBody: jsonBody({ type: "object", required: ["model"], properties: { model: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Model selected", { $ref: "#/components/schemas/AgentModelEnvelope" }) } },
      "/workspaces/{id}/agents/{agentId}/thinking-level": { post: { summary: "Select an agent thinking level", parameters: [workspaceId, agentId], requestBody: jsonBody({ type: "object", required: ["thinkingLevel"], properties: { thinkingLevel: { type: "string" } }, additionalProperties: false }), responses: jsonResponse("Thinking level selected", { $ref: "#/components/schemas/AgentThinkingLevelEnvelope" }) } },
      "/workspaces/{id}/agents/{agentId}/abort": { post: { summary: "Abort the active agent turn", parameters: [workspaceId, agentId], responses: jsonResponse("Agent aborted", { $ref: "#/components/schemas/AgentStateEnvelope" }) } },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, availableCommands: { type: "array", items: { type: "string" } } } } },
        },
        CreateWorkspace: {
          type: "object",
          properties: {
            source: { oneOf: [
              { type: "object", properties: { type: { const: "empty" } }, additionalProperties: false },
              { type: "object", required: ["type", "workspaceTemplate"], properties: { type: { const: "workspace-template" }, workspaceTemplate: { type: "string" } }, additionalProperties: false },
            ] },
            title: { type: "string" },
            agent: { type: "object", properties: { agentTypeId: { type: "string", description: "Agent type ID; defaults to the most recently created Agent type" }, initialPrompt: { type: "string" }, model: { type: "string" }, thinkingLevel: { type: "string" }, attachmentDraft: { type: "string" } }, additionalProperties: false },
          },
          additionalProperties: false,
        },
        WorkspaceTemplateSummary: {
          type: "object",
          required: ["id", "name", "gitUrl", "branch", "sessionShareKey"],
          properties: workspaceTemplateSummaryProperties,
          additionalProperties: false,
        },
        WorkspaceTemplateEnvelope: { type: "object", required: ["workspaceTemplate"], properties: { workspaceTemplate: { $ref: "#/components/schemas/WorkspaceTemplateSummary" } } },
        EnvironmentVariable: {
          type: "object",
          required: ["id", "name", "value", "createdAt", "updatedAt"],
          properties: { id: { type: "string" }, workspaceTemplateId: { type: "string", description: "Absent for global workspace settings" }, name: { type: "string" }, value: { type: "string" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } },
          additionalProperties: false,
        },
        EnvironmentVariableInput: { type: "object", required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } }, additionalProperties: false },
        EnvironmentVariableEnvelope: { type: "object", required: ["environmentVariable"], properties: { environmentVariable: { $ref: "#/components/schemas/EnvironmentVariable" } } },
        SecretSummary: {
          type: "object",
          required: ["id", "envName", "hostPattern", "createdAt", "updatedAt", "annotation", "configured"],
          properties: { id: { type: "string" }, workspaceTemplateId: { type: "string", description: "Absent for global workspace settings" }, envName: { type: "string" }, hostPattern: { type: "string" }, allowInPath: workspaceTemplateSecretPathPermissionSchema, placeholder: { type: "string" }, annotation: { type: "string" }, configured: { type: "boolean" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } },
          additionalProperties: false,
        },
        CreateSecret: workspaceTemplateSecretInputSchema,
        UpdateSecret: workspaceTemplateSecretInputSchema,
        SecretEnvelope: { type: "object", required: ["secret"], properties: { secret: { $ref: "#/components/schemas/SecretSummary" } } },
        WorkspaceTemplateConfigurationEnvelope: { type: "object", required: ["workspaceTemplate"], properties: { workspaceTemplate: {
          type: "object",
          required: ["id", "name", "gitUrl", "branch", "sessionShareKey", "environment", "secrets"],
          properties: { ...workspaceTemplateSummaryProperties, environment: { type: "array", items: { $ref: "#/components/schemas/EnvironmentVariable" } }, secrets: { type: "array", items: { $ref: "#/components/schemas/SecretSummary" } } },
          additionalProperties: false,
        } } },
        DeleteWorkspaceTemplateResult: { oneOf: [
          { type: "object", required: ["deleted", "blocked", "workspaceTemplate"], properties: { deleted: { const: true }, blocked: { const: false }, workspaceTemplate: { $ref: "#/components/schemas/WorkspaceTemplateSummary" } } },
          { type: "object", required: ["deleted", "blocked", "references"], properties: { deleted: { const: false }, blocked: { const: true }, references: { type: "array", items: { type: "object", required: ["workspaceId", "title"], properties: { workspaceId: { type: "string" }, title: { type: "string" } }, additionalProperties: false } } } },
        ] },
        WorkspacePhase: { oneOf: [
          { type: "object", required: ["kind", "status", "busy"], properties: { kind: { const: "provisioningPhase" }, status: { enum: ["working", "waiting", "failed"] }, busy: { type: "boolean" }, error: { type: "string" } }, additionalProperties: false },
          { type: "object", required: ["kind", "busy"], properties: { kind: { const: "runningPhase" }, busy: { type: "boolean" } }, additionalProperties: false },
          { type: "object", required: ["kind", "busy", "deletion"], properties: { kind: { const: "deletingPhase" }, busy: { type: "boolean" }, deletion: { type: "object", required: ["status"], properties: { status: { enum: ["checking", "blocked", "deleting", "failed"] }, provisioningError: { type: "string" }, fingerprint: { type: "string" }, forced: { type: "boolean" }, operation: { enum: ["checking", "deleting"] }, error: { type: "string" } } } }, additionalProperties: false },
        ] },
        WorkspaceSummary: { type: "object", required: ["id", "title", "phase", "parked", "requestingAttention"], properties: { id: { type: "string" }, title: { type: "string" }, phase: { $ref: "#/components/schemas/WorkspacePhase" }, requestingAttention: { type: "boolean" }, parked: { type: "boolean" }, workspaceTemplateId: { type: "string" }, warnings: workspaceWarningsSchema }, additionalProperties: false },
        WorkspaceEnvelope: {
          type: "object",
          required: ["workspace"],
          properties: { workspace: { type: "object", required: ["id", "phase", "url"], properties: {
            warnings: workspaceWarningsSchema,
            dismissedWarnings: { type: "object", additionalProperties: { type: "string" } },
            id: { type: "string" }, title: { type: "string" }, phase: { $ref: "#/components/schemas/WorkspacePhase" }, requestingAttention: { type: "boolean" }, url: { type: "string" },
            agents: { type: "array", items: { $ref: "#/components/schemas/AgentSummary" } },
            workViews: { type: "array", items: { $ref: "#/components/schemas/PresentedWorkView" } },
            commands: { type: "array", items: { type: "object" } },
          } } },
        },
        AgentSummary: agentSummarySchema,
        AgentCloseResult: {
          type: "object",
          required: ["closedAgentId", "agents"],
          properties: {
            closedAgentId: { type: "string", format: "uuid" },
            agents: { type: "array", items: { $ref: "#/components/schemas/AgentSummary" } },
          },
          additionalProperties: false,
        },
        AgentStateEnvelope: {
          type: "object",
          required: ["agent"],
          properties: { agent: {
            type: "object",
            required: ["agentId", "state"],
            properties: {
              agentId: { type: "string", format: "uuid" },
              state: { type: "string", enum: ["idle", "running"] },
              aborted: { type: "boolean" },
              compacted: { type: "boolean" },
            },
            additionalProperties: false,
          } },
          additionalProperties: false,
        },
        AgentModelEnvelope: {
          type: "object",
          required: ["agent"],
          properties: { agent: { type: "object", required: ["agentId", "model"], properties: { agentId: { type: "string", format: "uuid" }, model: { type: "string" } }, additionalProperties: false } },
          additionalProperties: false,
        },
        AgentThinkingLevelEnvelope: {
          type: "object",
          required: ["agent"],
          properties: { agent: { type: "object", required: ["agentId", "thinkingLevel"], properties: { agentId: { type: "string", format: "uuid" }, thinkingLevel: { type: "string" } }, additionalProperties: false } },
          additionalProperties: false,
        },
        WorkViewReference: workViewReferenceSchema,
        PresentedWorkView: { type: "object", required: ["key", "reference", "requestingAttention"], properties: { key: { type: "string" }, reference: { $ref: "#/components/schemas/WorkViewReference" }, requestingAttention: { type: "boolean" }, attentionSequence: { type: "integer" } }, additionalProperties: false },
        WorkViewsEnvelope: { type: "object", required: ["workViews"], properties: { workViews: { type: "array", items: { $ref: "#/components/schemas/PresentedWorkView" } } } },
        CommandResult: { type: "object", required: ["command", "workViews"], properties: {
          command: { type: "object", required: ["id"], properties: { id: { type: "string" }, workView: { $ref: "#/components/schemas/WorkViewReference" }, agentId: { type: "string", format: "uuid" } }, additionalProperties: false },
          workViews: { type: "array", items: { $ref: "#/components/schemas/PresentedWorkView" } },
        }, additionalProperties: false },
      },
    },
  };
}
