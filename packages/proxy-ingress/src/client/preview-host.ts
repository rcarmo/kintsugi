import { Application, Controller } from "@hotwired/stimulus";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { PreviewStateStore } from "./preview-state-store.ts";
import { parsePreviewState } from "../preview-state.ts";

const readySchema = Type.Object({ type: Type.Literal("kintsugi:preview-ready"), nonce: Type.String({ minLength: 36, maxLength: 36 }) });
const saveSchema = Type.Object({ type: Type.Literal("save"), id: Type.Integer({ minimum: 1 }), state: Type.Unknown() });

class PreviewHostController extends Controller {
  static targets = ["frame", "status"];
  static values = { scope: String };
  declare readonly frameTarget: HTMLIFrameElement;
  declare readonly statusTarget: HTMLElement;
  declare readonly scopeValue: string;
  private port?: MessagePort;
  private writes = Promise.resolve();
  private generation = 0;
  private documentNonce?: string;
  private readonly store = new PreviewStateStore(indexedDB);

  connect(): void { this.announce(); }
  disconnect(): void { this.generation++; this.port?.close(); }
  loaded(): void { this.announce(); }
  private announce(): void { this.frameTarget.contentWindow?.postMessage({ type: "kintsugi:preview-host-ready" }, "*"); }

  async receive(event: MessageEvent): Promise<void> {
    if (event.source !== this.frameTarget.contentWindow || event.origin !== "null" || !Value.Check(readySchema, event.data)) return;
    if (this.documentNonce === event.data.nonce) return;
    this.documentNonce = event.data.nonce;
    const generation = ++this.generation;
    this.port?.close();
    try {
      await this.writes;
      const state = await this.store.load(this.scopeValue);
      if (generation !== this.generation) return;
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = event => {
        const data: unknown = event.data;
        if (!Value.Check(saveSchema, data)) { this.fail(new Error("Invalid preview persistence message")); return; }
        this.writes = this.writes.then(async () => {
          const state = parsePreviewState(data.state);
          await this.store.save(this.scopeValue, state);
          channel.port1.postMessage({ type: "saved", id: data.id });
          this.statusTarget.textContent = "Preview state saved";
        }).catch(error => { channel.port1.postMessage({ type: "save-error", id: data.id }); this.fail(error); });
      };
      this.frameTarget.contentWindow!.postMessage({ type: "kintsugi:preview-connect", nonce: this.documentNonce, state }, "*", [channel.port2]);
      this.statusTarget.textContent = "Preview state restored";
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    this.statusTarget.textContent = "Preview settings could not be saved. Reloading may lose recent changes.";
    this.statusTarget.setAttribute("role", "alert");
    console.error("Preview persistence failed", error);
  }
}

Application.start().register("preview-host", PreviewHostController);
