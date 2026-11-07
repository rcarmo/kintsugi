import { posix } from "node:path";
import { Type, type Static } from "typebox";
import { createKeyedOperationQueue, withCommandSignal, invalidArguments, type JsonObject } from "@kintsugi/core";
import { defineWorkspaceTool } from "@kintsugi/agent/server/workspace-tool";
import { buttonHtml } from "@kintsugi/design-system/button";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { workspaceDownloadUrl } from "@kintsugi/shared/file-metadata";
import { domId, escapeHtml as h, type WorkspaceModuleRouteContext, type WorkspaceModuleCommandHandler, type WorkspaceCommandContribution } from "@kintsugi/shared";
import { stream, update, textResponse } from "@kintsugi/shared/http";
import { execWorkspaceCommandBuffer } from "@kintsugi/workspace";
import { maxOfficeFileBytes, officeFileKind } from "../office-format.ts";
import { createOfficeView, filesView, setFilesViewFile, type FilesView, type FilesWorkViewReference } from "./state.ts";
import { EditableFileError, requestedEditableFilePath } from "./editable-file.ts";
import { officeFrameResponse } from "./office-frame.ts";
const reads = createKeyedOperationQueue();
const officeOpenSchema = Type.Object({ path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false });
const officeOpenCommand: WorkspaceModuleCommandHandler<Static<typeof officeOpenSchema>> = { id: "files.office.open", inputSchema: officeOpenSchema, execute: ({ workspaceId, input }) => ({ createdWorkView: openOfficeView(workspaceId, input.path) }) };
export const officeCommands = [officeOpenCommand, { id: "files.office.create", execute: ({ workspaceId }: { workspaceId: string }) => ({ createdWorkView: { type: "files", id: createOfficeView(workspaceId).id } }) }];
export const officeCommandContributions: WorkspaceCommandContribution[] = [
  { id: "files.office.create", label: "New Office viewer", description: "Open a read-only Office document, spreadsheet or presentation.", scope: "workspace", surfaces: { ui: { placement: "work-launcher", label: "Office" } } },
  { id: "files.office.open", label: "Open Office file", scope: "workspace", inputSchema: officeOpenSchema },
];
const errorId = (workspaceId: string, id: string) => domId("office_error", workspaceId, id);

export function openOfficeView(workspaceId: string, input: string, existingId?: string): FilesWorkViewReference {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(workspaceId)) throw invalidArguments("Invalid workspace identifier");
  if (existingId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(existingId)) throw invalidArguments("Invalid Office view identifier");
  if (!input) throw new EditableFileError("Choose an Office file.", 422);
  const path = requestedEditableFilePath(input);
  if (!officeFileKind(path)) throw new EditableFileError("This format cannot be previewed. Use DOCX, PPTX, an Excel spreadsheet, ODS, CSV or TSV.", 415);
  if (existingId) {
    if (filesView(workspaceId, existingId).viewer !== "office") throw invalidArguments("Choose an Office view");
    setFilesViewFile(workspaceId, existingId, path);
    return { type: "files", id: existingId };
  }
  return { type: "files", id: createOfficeView(workspaceId, path).id };
}
export function renderOfficeWorkPane(workspaceId: string, view: FilesView): string {
  if (!view.path) return `<section class="work-view-pane office-empty"><form method="post" action="/workspaces/${encodeURIComponent(workspaceId)}/files-view/office/open" data-turbo-stream="true"><h2>Open an Office file</h2><p>Choose a file from Files, or enter its workspace path.</p><input type="hidden" name="officeView" value="${h(view.id)}"><label>File path <input class="text-field" name="path" required maxlength="4096" placeholder="/work/report.xlsx"></label>${buttonHtml({ type: "submit", variant: "primary", content: { kind: "caption", caption: "Open" } })}<p id="${errorId(workspaceId, view.id)}" role="alert"></p></form></section>`;
  const path = view.path, kind = officeFileKind(path)!;
  const download = actionLinkHtml({ href: workspaceDownloadUrl(workspaceId, path), variant: "secondary", content: { kind: "caption", caption: "Download" }, attributesHtml: `download="${h(posix.basename(path))}" data-turbo="false"` });
  const reload = buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption: "Reload" }, attributesHtml: 'data-action="office-pane#reload"' });
  return `<section class="work-view-pane office-pane" id="${domId("office_pane", workspaceId, view.id, Bun.hash(path).toString(16))}" data-turbo-permanent data-controller="office-pane" data-office-pane-kind-value="${kind}" data-office-pane-name-value="${h(posix.basename(path))}" data-office-pane-data-url-value="/workspaces/${encodeURIComponent(workspaceId)}/files-view/office/data?${h(new URLSearchParams({ path }).toString())}" data-office-pane-frame-url-value="/workspaces/${encodeURIComponent(workspaceId)}/files-view/office/frame" data-action="message@window->office-pane#message kintsugi:workspace-pane-visible@document->office-pane#sync visibilitychange@document->office-pane#sync"><header class="work-view-toolbar office-toolbar"><span class="file-editor-path" title="${h(path)}">${h(path)}</span><span>Read only</span>${reload}${download}<a href="/office-licenses.txt" target="_blank" rel="noopener" data-turbo="false">Licenses</a></header><p class="office-status" role="status" data-office-pane-target="status">Select this pane to load the preview.</p><iframe title="${h(posix.basename(path))} Office preview" src="about:blank" sandbox="allow-scripts" referrerpolicy="no-referrer" data-office-pane-target="frame"></iframe></section>`;
}
export async function readOfficeFile(workspaceId: string, input: string, signal: AbortSignal): Promise<Buffer> {
  const path = requestedEditableFilePath(input), kind = officeFileKind(path);
  if (!kind) throw new EditableFileError("Unsupported Office file format.", 415);
  return withCommandSignal(AbortSignal.any([signal, AbortSignal.timeout(15000)]), () => reads("office-read", async () => {
    const result = await execWorkspaceCommandBuffer(workspaceId, ["/usr/bin/prlimit", "--as=268435456", "--cpu=5", "--nofile=128", "--", "/usr/bin/python3", "/opt/kintsugi/bin/kintsugi-office-read", path, kind], { maxOutputBytes: maxOfficeFileBytes + 1 });
    if (result.exitCode !== 0) throw new EditableFileError(result.stderr.trim().slice(0, 1000) || "This file could not be previewed within the parser limits.", result.exitCode === 44 ? 404 : result.exitCode === 45 ? 403 : 415);
    if (result.stdout.byteLength > maxOfficeFileBytes) throw new EditableFileError("Office previews are limited to 16 MiB.", 413);
    return result.stdout;
  }));
}
export async function handleOfficeRequest(request: Request, url: URL, context: Pick<WorkspaceModuleRouteContext, "openWorkView">): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/workspaces\/([^/]+)\/files-view\/office\/(open|data|frame)$/);
  if (!match) return;
  const workspaceId = decodeURIComponent(match[1]!), operation = match[2]!;
  if (operation === "open") {
    if (request.method !== "POST") return textResponse("Method not allowed", { status: 405 });
    const data = await request.formData(), existing = data.get("officeView");
    try { return await context.openWorkView(workspaceId, openOfficeView(workspaceId, String(data.get("path") ?? ""), existing === null ? undefined : String(existing))); }
    catch (error) { if (!(error instanceof EditableFileError) || existing === null) throw error; return stream(update(errorId(workspaceId, String(existing)), h(error.message)), { status: error.status }); }
  }
  if (request.method !== "GET") return textResponse("Method not allowed", { status: 405 });
  if (operation === "frame") return officeFrameResponse();
  try {
    const bytes = await readOfficeFile(workspaceId, url.searchParams.get("path") ?? "", request.signal);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'" } });
  } catch (error) {
    if (!(error instanceof EditableFileError)) throw error;
    return textResponse(error.message, { status: error.status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
}
export function createOpenOfficeTool(workspaceId: string, present: (reference: FilesWorkViewReference) => Promise<void>) {
  return defineWorkspaceTool({ name: "open_office_viewer", label: "Office Viewer", description: "Open a read-only Office Work pane for a workspace file. Supports DOCX, PPTX, XLSX/XLSM/XLSB/XLS, ODS and CSV/TSV. Does not run macros, recalculate formulas or upload files. Legacy DOC/PPT, ODT and ODP are unsupported. Files are limited to 16 MiB, validated ZIP expansion to 64 MiB; CSV/TSV to 2 MB. Source stays unchanged.", parameters: Type.Object({ file_path: Type.String({ minLength: 1, maxLength: 4096, description: "Workspace file path, relative to /work or absolute inside the workspace." }) }, { additionalProperties: false }), async execute(_id, input) {
    const reference = openOfficeView(workspaceId, input.file_path); await present(reference);
    return { content: [{ type: "text" as const, text: `Opened ${posix.basename(input.file_path)} in a read-only Office Work pane.` }], details: { reference } };
  } });
}
export const officeOpenApiPaths = {
  "/workspaces/{id}/files-view/office/open": {
    "post": {
      "summary": "Open a read-only Office Files Work pane without modifying the document",
      "parameters": [
        {
          "name": "id",
          "in": "path",
          "required": true,
          "schema": {
            "type": "string"
          }
        }
      ],
      "requestBody": {
        "required": true,
        "content": {
          "application/x-www-form-urlencoded": {
            "schema": {
              "type": "object",
              "required": [
                "path"
              ],
              "properties": {
                "path": {
                  "type": "string"
                },
                "officeView": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Updated workspace view"
        }
      }
    }
  },
  "/workspaces/{id}/files-view/office/data": {
    "get": {
      "summary": "Read a bounded, ZIP-validated Office file without starting its workspace",
      "parameters": [
        {
          "name": "id",
          "in": "path",
          "required": true,
          "schema": {
            "type": "string"
          }
        },
        {
          "name": "path",
          "in": "query",
          "required": true,
          "schema": {
            "type": "string"
          }
        }
      ],
      "responses": {
        "200": {
          "description": "Validated source bytes, never cached",
          "content": {
            "application/octet-stream": {
              "schema": {
                "type": "string",
                "format": "binary"
              }
            }
          }
        },
        "415": {
          "description": "Unsupported, malformed or oversized document"
        }
      }
    }
  }
} satisfies Record<string, JsonObject>;
