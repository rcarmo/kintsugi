import { createHash } from "node:crypto";
import type { Repository, WorkingFileRevision } from "@kintsugi/workspace/git";
import { canEditFile, diskContents, editLineEnding, maxChangesTextBytes, maxChangesTextLines, type EditModel, type EditedCommentRange } from "../editing.ts";
import { refreshChanges } from "./refresh.ts";
import { workingTree, type ChangesSnapshot } from "./snapshot.ts";

export class EditError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}
const fingerprint = (contents: Uint8Array) => createHash("sha256").update(contents).digest("hex");
interface EditSession { model: EditModel; snapshot: ChangesSnapshot; expected: WorkingFileRevision; saving: boolean }

/** A lease pins the reviewed input, independent of subsequent live snapshot refreshes. */
export function createChangesEditStore() {
  const sessions = new Map<string, Map<string, EditSession>>();
  async function begin(workspaceId: string, root: Repository, snapshot: ChangesSnapshot, path: string, file = snapshot.files.get(path)): Promise<EditModel> {
    if (snapshot.endpoints.target !== workingTree || !file || !canEditFile(file)) throw new EditError("This file is read-only in this comparison.");
    const working = await root.workingFile(path, true, maxChangesTextBytes);
    if (!working || working.oversized || working.mode !== file.newMode) throw new EditError("This file is no longer editable. Refresh Changes.", 409);
    if (!working.contents.equals(Buffer.from(file.newContents!))) throw new EditError("This file changed. Refresh Changes before editing.", 409);
    const model: EditModel = { token: crypto.randomUUID(), path, contents: file.newContents!, ending: editLineEnding(file.newContents!)! };
    let workspace = sessions.get(workspaceId);
    if (!workspace) sessions.set(workspaceId, workspace = new Map());
    // Bound abandoned browser leases; active drafts remain in the browser if an old lease expires.
    if (workspace.size >= 32) workspace.delete(workspace.keys().next().value!);
    workspace.set(model.token, { model, snapshot, expected: { hash: fingerprint(working.contents), mode: working.mode }, saving: false });
    return model;
  }
  function session(workspaceId: string, token: string): EditSession {
    const value = sessions.get(workspaceId)?.get(token);
    if (!value) throw new EditError("This edit session ended. Copy your edits before reloading Changes.", 409);
    return value;
  }
  async function save(workspaceId: string, root: Repository, token: string, text: string, ranges: readonly EditedCommentRange[], relocate: (snapshot: ChangesSnapshot, path: string, contents: string, ranges: readonly EditedCommentRange[]) => void): Promise<ChangesSnapshot> {
    const edit = session(workspaceId, token);
    if (edit.saving) throw new EditError("This file is already saving.", 409);
    const contents = diskContents(text, edit.model.ending);
    if (contents.includes("\0") || editLineEnding(contents) === undefined || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(contents)) throw new EditError("Only UTF-8 text with consistent line endings can be saved.");
    if (Buffer.byteLength(contents) > maxChangesTextBytes || contents.split("\n").length > maxChangesTextLines) throw new EditError("This file is too large to edit in Changes.", 413);
    edit.saving = true;
    try {
      const result = await root.writeWorkingFile(edit.model.path, edit.expected, contents);
      if (result === "changed") throw new EditError("This file changed while you were editing. Your edits haven’t been saved.", 409);
      if (result === "unsupported") throw new EditError("This file is no longer a regular file inside the repository. Your edits haven’t been saved.", 409);
      // Update the lease before recapturing: a transport/capture failure can retry without overwriting a later change.
      edit.expected.hash = fingerprint(Buffer.from(contents));
      relocate(edit.snapshot, edit.model.path, contents, ranges);
      // A fresh history: the saved file changes the Working tree's counts, and commits may have changed meanwhile.
      const next = await refreshChanges(root, edit.snapshot);
      sessions.get(workspaceId)!.delete(token);
      return next;
    } finally { edit.saving = false; }
  }
  function cancel(workspaceId: string, token: string): void {
    const edit = sessions.get(workspaceId)?.get(token);
    if (edit?.saving) throw new EditError("Wait for this file to finish saving.", 409);
    sessions.get(workspaceId)?.delete(token);
  }
  return { begin, save, cancel, delete: (workspaceId: string) => sessions.delete(workspaceId) };
}
export const changesEdits = createChangesEditStore();
