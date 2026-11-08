import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const previewFlushRequestSchema = Type.Object({ type: Type.Literal("flush"), id: Type.String({ format: "uuid" }) }, { additionalProperties: false });
export const previewFlushReplySchema = Type.Object({ type: Type.Literal("flushed"), id: Type.String({ format: "uuid" }), saved: Type.Boolean() }, { additionalProperties: false });
export type PreviewFlushRequest = Static<typeof previewFlushRequestSchema>;
export const previewHostFlushSchema = Type.Object({ type: Type.Literal("kintsugi:preview-flush"), id: Type.String({ format: "uuid" }) }, { additionalProperties: false });
export const previewHostFlushedSchema = Type.Object({ type: Type.Literal("kintsugi:preview-flushed"), id: Type.String({ format: "uuid" }), saved: Type.Boolean() }, { additionalProperties: false });

/** Acknowledgements are accepted only on the document's private persistence port. */
export class PreviewFlushChannel {
  private readonly pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly send: (message: PreviewFlushRequest) => void) {}
  flush(): Promise<void> {
    if (this.pending.size >= 16) return Promise.reject(new Error("Too many pending preview flush requests"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Preview storage did not acknowledge its writes")); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ type: "flush", id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A structured-clone message is parsed at this protocol boundary.
  receive(input: unknown): boolean {
    if (!Value.Check(previewFlushReplySchema, input)) return false;
    const pending = this.pending.get(input.id);
    if (!pending) return false;
    this.pending.delete(input.id); clearTimeout(pending.timer);
    if (input.saved) pending.resolve(); else pending.reject(new Error("Preview storage could not commit its writes"));
    return true;
  }
  close(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Preview document changed before its writes were acknowledged")); }
    this.pending.clear();
  }
}
