import { Type } from "typebox";
import { Value } from "typebox/value";
import { agentComposerSendPromptEvent, CableTopics, type AgentComposerSendPromptDetail, type CableSubscription, type WorkspaceClientControllerConstructor } from "@kintsugi/shared";
import { agentPlanSubmission } from "../plan-submission.ts";
import { highlightCodeHtml } from "@kintsugi/syntax";
const draftSchema = Type.Object({ markdown: Type.String({ maxLength: 65536 }), revision: Type.Integer({ minimum: 0 }) });
type Draft = { markdown: string; revision: number };

export function createAgentPlanController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static targets = ["form", "editor", "highlight", "revision", "status", "version", "confirmation", "confirmationMessage"];
    static values = { workspaceId: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly formTarget: HTMLFormElement;
    declare readonly editorTarget: HTMLTextAreaElement;
    declare readonly highlightTarget: HTMLPreElement;
    declare readonly revisionTarget: HTMLInputElement;
    declare readonly statusTarget: HTMLElement;
    declare readonly confirmationTarget: HTMLDialogElement;
    declare readonly confirmationMessageTarget: HTMLElement;
    declare readonly hasFormTarget: boolean;
    private agentId = "";
    private selection = 0;
    private edits = 0;
    private dirty = false;
    private loading?: AbortController;
    private subscription?: CableSubscription;
    private subscribedAgent = "";
    private saving = false;
    private submissionStatus?: string;
    private replacement?: "refresh" | "reset";
    private drafts = new Map<string, Draft>();

    connect(): void { this.sync(); }
    disconnect(): void { this.remember(); this.loading?.abort(); this.subscription?.unsubscribe(); }
    private key(agent = this.agentId) { return `kintsugi-agent-plan:${this.workspaceIdValue}:${agent}`; }
    private status(text: string): void { this.statusTarget.textContent = text; }
    private remember(): void {
      if (!this.agentId || !this.dirty || !this.hasFormTarget || this.formTarget.dataset.agentId !== this.agentId) return;
      const draft = { markdown: this.editorTarget.value, revision: Number(this.revisionTarget.value) };
      this.drafts.set(this.agentId, draft);
      try { sessionStorage.setItem(this.key(), JSON.stringify(draft)); }
      catch { this.status("Draft is kept in this pane, but browser storage is full. Save or copy it before leaving."); }
    }
    private clearDraft(agent: string): void { this.drafts.delete(agent); sessionStorage.removeItem(this.key(agent)); }
    sync(): void {
      const selected = this.element.closest<HTMLElement>("[data-workspace-selected-agent]")?.dataset.workspaceSelectedAgent ?? "";
      if (selected !== this.agentId) {
        this.remember(); this.loading?.abort(); this.subscription?.unsubscribe(); this.subscription = undefined; this.subscribedAgent = "";
        this.submissionStatus = undefined;
        this.agentId = selected; this.selection++; this.edits = 0; this.dirty = false;
        if (this.hasFormTarget) this.formTarget.hidden = true;
        if (this.confirmationTarget.open) this.cancelConfirmation();
        this.status(selected ? "Loading Agent plan…" : "Select an Agent to view its plan.");
        if (selected) void this.load();
      }
      if (document.hidden || !this.element.checkVisibility()) { this.subscription?.unsubscribe(); this.subscription = undefined; this.subscribedAgent = ""; return; }
      this.subscribe();
    }
    private subscribe(): void {
      if (document.hidden || !this.element.checkVisibility() || !this.agentId || this.subscribedAgent === this.agentId || !this.hasFormTarget || this.formTarget.dataset.agentId !== this.agentId) return;
      this.subscribedAgent = this.agentId;
      this.subscription = window.KintsugiCable!.subscribe(CableTopics.module("agent-plan", this.workspaceIdValue, { agentId: this.agentId }), { onRejected: reason => this.status(`Plan updates unavailable: ${reason}`) });
    }
    formTargetConnected(form: HTMLFormElement): void {
      if (form.dataset.agentId !== this.agentId) return;
      let draft = this.drafts.get(this.agentId);
      const saved = sessionStorage.getItem(this.key());
      if (!draft && saved !== null) {
        try { draft = Value.Parse(draftSchema, JSON.parse(saved)); this.drafts.set(this.agentId, draft); }
        catch { this.status("Could not restore this browser's plan draft. Refresh to discard it."); return; }
      }
      if (draft) {
        const changed = Number(this.revisionTarget.value) !== draft.revision;
        this.editorTarget.value = draft.markdown; this.revisionTarget.value = String(draft.revision); this.dirty = true;
        this.status(changed ? "The saved plan changed. Your draft is kept; copy it or refresh before replacing the plan." : "Unsaved draft restored.");
      } else this.status("Saved plan. Changes here are sent to the agent only when you choose Submit to model.");
      if (this.submissionStatus) this.status(this.submissionStatus);
      this.highlight();
      this.subscribe();
    }
    versionTargetConnected(version: HTMLElement): void {
      if (version.dataset.agentId !== this.agentId || !this.hasFormTarget || this.formTarget.dataset.agentId !== this.agentId) return;
      if (Number(version.dataset.revision) === Number(this.revisionTarget.value)) return;
      if (this.dirty || this.saving) this.status("Plan changed elsewhere. Your draft is kept; refresh to load the saved plan.");
      else void this.load();
    }
    private highlight(): void {
      this.highlightTarget.innerHTML = highlightCodeHtml({ code: this.editorTarget.value + "\n", language: "markdown" }).html;
      this.editorTarget.parentElement!.classList.add("syntax-ready");
      this.scrollHighlight();
    }
    scrollHighlight(): void { this.highlightTarget.scrollTop = this.editorTarget.scrollTop; this.highlightTarget.scrollLeft = this.editorTarget.scrollLeft; }
    edited(): void { this.highlight(); this.submissionStatus = undefined; this.edits++; this.dirty = true; this.status("Unsaved changes"); this.remember(); }
    private async load(): Promise<void> {
      if (!this.agentId) return;
      this.loading?.abort(); const controller = this.loading = new AbortController();
      const selection = this.selection, edits = this.edits;
      try {
        const response = await fetch(this.url(), { headers: { Accept: "text/vnd.turbo-stream.html" }, signal: controller.signal });
        const html = await response.text();
        if (controller.signal.aborted || selection !== this.selection || edits !== this.edits || this.dirty) return;
        window.Turbo!.renderStreamMessage(html);
      } catch (error) { if (!controller.signal.aborted) this.status(`Could not load the plan: ${error instanceof Error ? error.message : String(error)}`); }
      finally { if (this.loading === controller) this.loading = undefined; }
    }
    private url(agent = this.agentId): string { return `/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agent-plans/${encodeURIComponent(agent)}`; }
    async save(event?: Event): Promise<void> { event?.preventDefault(); await this.write("write"); }
    private async write(action: "write" | "reset"): Promise<{ agentId: string; markdown: string } | undefined> {
      if (this.saving || !this.hasFormTarget || this.formTarget.dataset.agentId !== this.agentId) return;
      const agentId = this.agentId, selection = this.selection, edits = this.edits, markdown = this.editorTarget.value;
      const expectedRevision = Number(this.revisionTarget.value);
      this.remember(); this.submissionStatus = undefined; this.saving = true;
      try {
        const response = await fetch(this.url(agentId), { method: "POST", headers: { Accept: "text/vnd.turbo-stream.html", "Content-Type": "application/json" }, body: JSON.stringify(action === "write" ? { action, markdown, expectedRevision } : { action, expectedRevision }) });
        const html = await response.text();
        if (!response.ok) { if (selection === this.selection) window.Turbo!.renderStreamMessage(html); return; }
        const revision = Number(response.headers.get("x-kintsugi-plan-revision"));
        if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Missing saved plan revision");
        const draft = this.drafts.get(agentId);
        if (draft?.markdown === markdown) this.clearDraft(agentId);
        else if (draft) { draft.revision = revision; sessionStorage.setItem(this.key(agentId), JSON.stringify(draft)); }
        if (selection !== this.selection) return;
        if (edits !== this.edits) { this.revisionTarget.value = String(revision); this.remember(); this.status("Saved the earlier version; newer edits remain unsaved."); }
        else { this.dirty = false; this.clearDraft(agentId); window.Turbo!.renderStreamMessage(html); }
        return { agentId, markdown };
      } catch (error) { if (selection === this.selection) this.status(`Could not save the plan: ${error instanceof Error ? error.message : String(error)}. Your draft is kept.`); }
      finally { this.saving = false; }
    }
    refresh(): void { if (this.dirty) this.confirm("refresh"); else void this.load(); }
    reset(): void { this.confirm("reset"); }
    private confirm(action: "refresh" | "reset"): void {
      this.replacement = action;
      this.confirmationMessageTarget.textContent = action === "reset" ? "Restore this Agent's default checklist? This replaces its saved plan and discards your draft." : "Discard your draft and load this Agent's saved plan?";
      this.confirmationTarget.showModal();
    }
    cancelConfirmation(): void { this.replacement = undefined; this.confirmationTarget.close(); }
    confirmReplacement(): void {
      const action = this.replacement; this.cancelConfirmation();
      if (action === "reset") void this.write("reset");
      if (action === "refresh") { this.dirty = false; this.clearDraft(this.agentId); void this.load(); }
    }
    async submitToModel(): Promise<void> {
      if (!this.hasFormTarget || !this.editorTarget.value.trim()) { this.status("The plan is empty; nothing to submit."); return; }
      const saved = await this.write("write");
      if (!saved || saved.agentId !== this.agentId) return;
      const pane = this.element.closest("[data-workspace-selected-agent]")!.querySelector(`[data-workspace-pane-role="agent"][data-workspace-pane-id="${CSS.escape(saved.agentId)}"]`);
      const composer = pane?.querySelector(".composer");
      if (!composer) { this.status("Plan saved. Open this Agent's composer before submitting it."); return; }
      this.saving = true; this.status("Submitting the saved plan…");
      try {
        await new Promise<void>((resolve, reject) => composer.dispatchEvent(new CustomEvent<AgentComposerSendPromptDetail>(agentComposerSendPromptEvent, { bubbles: true, detail: { text: agentPlanSubmission(saved.markdown), requestId: crypto.randomUUID(), onComplete: error => error ? reject(error) : resolve() } })));
        if (saved.agentId === this.agentId) { this.submissionStatus = this.dirty ? "Submitted the saved plan. Newer edits remain unsaved." : "Submitted to model."; this.status(this.submissionStatus); }
      } catch (error) { if (saved.agentId === this.agentId) { this.submissionStatus = `Plan saved; submission failed or delivery is uncertain. Check the Agent before retrying: ${error instanceof Error ? error.message : String(error)}`; this.status(this.submissionStatus); } }
      finally { this.saving = false; }
    }
  };
}
