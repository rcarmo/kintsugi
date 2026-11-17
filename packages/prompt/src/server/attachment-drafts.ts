import { extensionOf, imageMimeByExtension, mediaMimeByExtension } from "@kintsugi/shared/file-metadata";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getKintsugiRuntimeContext, isNotFoundError, shellQuote } from "@kintsugi/core";
import { execWorkspaceShell } from "@kintsugi/workspace";
import type { WorkspaceAgentInput } from "@kintsugi/shared";
type ImageRef = WorkspaceAgentInput["images"][number];

export interface StagedAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  isImage: boolean;
}

export interface DeliveredAttachments {
  images: ImageRef[];
  attachmentNotes: string[];
  files?: WorkspaceAgentInput["files"];
}

export function attachmentDraftsDir(): string {
  return join(getKintsugiRuntimeContext().kintsugiDataDir, "agent-attachment-drafts");
}

export function attachmentDraftDir(draftId: string): string {
  return join(attachmentDraftsDir(), draftId);
}

export function validDraftId(draftId: string): boolean {
  return /^[a-zA-Z0-9_-]{8,80}$/.test(draftId);
}

/** Stable composer draft identity for one immutable Workspace/Agent pair. */
export function agentAttachmentDraftId(workspaceId: string, agentId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([workspaceId, agentId])).digest("hex");
  return `agent-${digest}`;
}

export function validAttachmentId(attachmentId: string): boolean {
  return /^[a-f0-9-]{8,40}$/.test(attachmentId);
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^a-zA-Z0-9._ ()-]/g, "_").slice(0, 120) || "file";
}

export async function stageAttachment(draftId: string, file: File): Promise<StagedAttachment> {
  if (!validDraftId(draftId)) throw new Error(`invalid attachment draft id: ${draftId}`);
  const attachmentId = crypto.randomUUID();
  const name = sanitizeFilename(file.name || "file");
  const dir = join(attachmentDraftDir(draftId), attachmentId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()));
  return { id: attachmentId, name, path: join(dir, name), size: file.size, isImage: Boolean(imageMimeByExtension[extensionOf(name)]) };
}

export async function findStagedAttachment(draftId: string, attachmentId: string): Promise<StagedAttachment | undefined> {
  if (!validDraftId(draftId) || !validAttachmentId(attachmentId)) return undefined;
  const dir = join(attachmentDraftDir(draftId), attachmentId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
  const [name] = names;
  if (!name) return undefined;
  const path = join(dir, name);
  const file = Bun.file(path);
  return { id: attachmentId, name, path, size: file.size, isImage: Boolean(imageMimeByExtension[extensionOf(name)]) };
}

export async function listStagedAttachments(draftId: string): Promise<StagedAttachment[]> {
  if (!validDraftId(draftId)) return [];
  let entries: string[];
  try {
    entries = await readdir(attachmentDraftDir(draftId));
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const attachments: StagedAttachment[] = [];
  for (const attachmentId of entries) {
    const staged = await findStagedAttachment(draftId, attachmentId);
    if (staged) attachments.push(staged);
  }
  return attachments;
}

export async function removeStagedAttachment(draftId: string, attachmentId: string): Promise<void> {
  if (!validDraftId(draftId) || !validAttachmentId(attachmentId)) throw new Error("invalid staged attachment id");
  await rm(join(attachmentDraftDir(draftId), attachmentId), { recursive: true, force: true });
}

export async function removeStagedAttachments(draftId: string, attachmentIds: readonly string[]): Promise<void> {
  await Promise.all(attachmentIds.map(async (attachmentId) => await removeStagedAttachment(draftId, attachmentId)));
}

export async function removeAttachmentDraft(draftId: string): Promise<void> {
  if (!validDraftId(draftId)) throw new Error(`invalid attachment draft id: ${draftId}`);
  await rm(attachmentDraftDir(draftId), { recursive: true, force: true });
}

export async function moveAttachmentDraft(sourceDraftId: string, targetDraftId: string): Promise<void> {
  if (!validDraftId(sourceDraftId) || !validDraftId(targetDraftId)) throw new Error("invalid attachment draft id");
  if ((await listStagedAttachments(sourceDraftId)).length === 0) return;
  await rename(attachmentDraftDir(sourceDraftId), attachmentDraftDir(targetDraftId));
}

export async function deliverAttachmentDraft(workspaceId: string, draftId: string, attachmentIds?: string[], options: {retainFiles?:boolean} = {}): Promise<DeliveredAttachments> {
  const staged = attachmentIds
    ? await Promise.all(attachmentIds.map(async (attachmentId) => {
      const attachment = await findStagedAttachment(draftId, attachmentId);
      if (!attachment) throw new Error(`attachment not found: ${attachmentId}`);
      return attachment;
    }))
    : await listStagedAttachments(draftId);

  const images: ImageRef[] = [];
  const attachmentNotes: string[] = [];
  const files: NonNullable<WorkspaceAgentInput["files"]> = [];
  for (const attachment of staged) {
    if (attachment.isImage) {
      const data = await readFile(attachment.path);
      const mimeType = imageMimeByExtension[extensionOf(attachment.name)]!,base64 = data.toString("base64");
      images.push({ mimeType, data: base64 });
      if (options.retainFiles) files.push({type:"attachment",filename:attachment.name,mimeType,data:base64});
    } else {
      attachmentNotes.push(await deliverFileAttachment(workspaceId, attachment));
      if (options.retainFiles) files.push({type:"attachment",filename:attachment.name,mimeType:mediaMimeByExtension[extensionOf(attachment.name)] ?? "application/octet-stream",data:(await readFile(attachment.path)).toString("base64")});
    }
  }
  const delivered: DeliveredAttachments = { images, attachmentNotes };
  if (options.retainFiles) delivered.files = files;
  return delivered;
}

async function deliverFileAttachment(workspaceId: string, staged: StagedAttachment): Promise<string> {
  const target = `/tmp/kintsugi-attachments/${staged.name}`;
  await copyAttachmentIntoWorkspace(workspaceId, staged, target);
  return `[Attached file copied into the workspace at ${target}]`;
}

/** Copy a staged attachment to a caller-owned path in its workspace. */
export async function copyAttachmentIntoWorkspace(workspaceId: string, staged: StagedAttachment, target: string): Promise<void> {
  const content = await readFile(staged.path);
  const result = await execWorkspaceShell(
    workspaceId,
    `mkdir -p ${shellQuote(target.slice(0, target.lastIndexOf("/")))} && base64 -d > ${shellQuote(target)}`,
    { stdin: content.toString("base64") },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `could not copy attachment ${staged.name} into workspace`);
}
