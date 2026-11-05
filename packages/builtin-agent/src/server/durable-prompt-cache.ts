import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";

/** Project every system delta consistently before any provider folds/serialises it.
 * Preserve section text, authority, tools and signed assistant content. Native
 * changes remain native; providers without that capability still get current state.
 */
export function sharedInstructionsFirst(messages: readonly Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== "system" || !message.sections || !Object.hasOwn(message.sections, "instructions")) return message;
    const { instructions, ...sections } = message.sections;
    return { ...message, sections: { instructions, ...sections } };
  });
}

export const durablePromptCache = defineExtension({ name: "kintsugi.prompt-cache", hooks: [hook(GenerationTask, {
  beforeRequest(request) { return { messages: sharedInstructionsFirst(request.messages) }; },
})] });
