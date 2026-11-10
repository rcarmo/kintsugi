import { createHash } from "node:crypto";
import { defineDoc, defineEntry, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { ScriptFileView } from "@kintsugi/agent/server/transcript";
import { execWorkspaceCommand } from "@kintsugi/workspace";

/** A call's script file, pinned before it first runs, so a rerun after a restart runs the same code. */
const ScriptFileDoc = defineDoc<{ file?: ScriptFileView }>({
  kind: "kintsugi.codemode-script-file",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => false,
});

/** The script file a code mode call ran, by the call's ID, for the transcript; the task's document is gone once it ends. */
export const codemodeScriptFileEntry = defineEntry<{ callId: string } & ScriptFileView>("kintsugi.codemode-script-file");

export const scriptFileDescription = "To run a script file instead, make the code a line `// @path: <file>`, optionally after an `// @options:` line. To give the script input, follow the path line with a JSON value; the script gets it as `input`. The file holds a script like any other; edit it and call again to iterate. Each call runs the file as it was when the call started.";

const optionsLine = /^[ \t]*\/\/ @options:[^\r\n]*\r?\n/;
const pathLine = /^[ \t]*\/\/ @path:[ \t]*([^\r\n]*?)[ \t]*(?:\r?\n|$)/;

/**
 * A script that names a file instead, as `// @path: <file>`, optionally after an options line and followed by the
 * script's input as JSON: the options line, the file's path and the input, or why the script can't name a file that
 * way. Anything after a `// @path:` line that is not JSON is a mistake, as the path line would otherwise run as a
 * comment.
 */
function scriptFileReference(code: string): { options: string; path: string; input: string | undefined } | { error: string } | undefined {
  const options = code.match(optionsLine)?.[0] ?? "";
  const reference = code.slice(options.length).match(pathLine);
  if (!reference) return /^[ \t]*\/\/ @path:/m.test(code) ? { error: "A `// @path:` line must start the script, after at most an `// @options:` line." } : undefined;
  if (!reference[1]) return { error: "`// @path:` needs the path of a script file." };
  const rest = code.slice(options.length + reference[0].length).trim();
  if (!rest) return { options, path: reference[1], input: undefined };
  try {
    return { options, path: reference[1], input: JSON.stringify(JSON.parse(rest)) };
  } catch (error) {
    return { error: `After the \`// @path:\` line, the script can only have its input, as JSON: ${String(error)}` };
  }
}

/** Reads a script file: its text, or why it can't. */
export type ReadScriptFile = (path: string) => Promise<{ text: string } | { error: string }>;

/** Reads script files in a workspace; relative paths start at its root. */
export function workspaceScriptFiles(workspaceId: string): ReadScriptFile {
  return async path => {
    const result = await execWorkspaceCommand(workspaceId, ["cat", "--", path]);
    return result.exitCode === 0 ? { text: result.stdout } : { error: result.stderr.trim() };
  };
}

function errorResult(message: string): ToolExecutionResult {
  return { output: [{ type: "text", text: message }], isError: true };
}

/**
 * The script a code mode call runs: its code, or the file it names, read once and pinned for the call. Its result
 * is an error result when the file can't be the script.
 */
export async function resolveScript(readFile: ReadScriptFile, code: string, api: ToolExecutionApi, context: Context): Promise<{ code: string } | { error: ToolExecutionResult }> {
  const reference = scriptFileReference(code);
  if (!reference) return { code };
  if ("error" in reference) return { error: errorResult(reference.error) };
  // The document is a draft of its transaction: copy the file out of it.
  let file = await api.commit(async tx => {
    const pinned = (await tx.doc(ScriptFileDoc, api.taskId)).file;
    return pinned && { ...pinned };
  }, context);
  if (!file) {
    const contents = await readFile(reference.path);
    if ("error" in contents) return { error: errorResult(`Can't read script file ${reference.path}: ${contents.error}`) };
    const read = { path: reference.path, sha256: createHash("sha256").update(contents.text).digest("hex"), code: contents.text };
    await api.commit(async tx => {
      (await tx.doc(ScriptFileDoc, api.taskId)).file = read;
      await tx.appendEntry(codemodeScriptFileEntry, api.conversationId, { data: { callId: api.callId, ...read } });
    }, context);
    file = read;
  }
  const fileOptions = file.code.match(optionsLine)?.[0] ?? "";
  if (reference.options && fileOptions) {
    return { error: errorResult(`${file.path} has its own \`// @options:\` line. Put options in the file or in the call, not both.`) };
  }
  const input = reference.input === undefined ? "" : `const input = ${reference.input};\n`;
  return { code: `${reference.options || fileOptions}${input}${file.code.slice(fileOptions.length)}` };
}
