import { createNativeTerminalTextInputController, createTerminalKeyBarController, kintsugiObservableTerminalTheme, createObservableTerminalViewer, observableWebSocketUrl, TerminalFrame, type ObservableTerminalViewer } from "@kintsugi/observable-terminal/client";
import { latestExchangeTop } from "@kintsugi/agent/client/transcript-navigation";
import { anchorScrollBottom, CableTopics, changeLayout, type CableSubscription, composerSubmitKey, errorMessage, type AgentComposerSendPromptDetail, isWorkspacePaneVisible, setTextInputValue, workspaceFileOpenUrl, type WorkspaceClientModule } from "@kintsugi/shared";

export const kintsugiClientModule: WorkspaceClientModule = {
  id: "cli-agent",
  install({ application, Controller, hooks }) {
    const terminals = new Set<{ element: HTMLElement; canToggleMode: boolean; toggleMode(): void; becomeVisible(): void }>();
    hooks.onBecomeVisible(({ pane }) => { for (const terminal of terminals) if (pane.contains(terminal.element)) terminal.becomeVisible(); });
    hooks.registerCommandProvider(() => {
      const terminal = [...terminals].find((controller) => controller.canToggleMode && isWorkspacePaneVisible(controller.element));
      return terminal ? [{
        id: "cli-agent.toggle-mode",
        label: "Switch terminal / transcript",
        scope: "agent",
        binding: "Meta+Alt+KeyP",
        run: () => terminal.toggleMode(),
      }] : [];
    });
    application.register("native-terminal-text-input", createNativeTerminalTextInputController(Controller));
    application.register("cli-terminal", class extends createTerminalKeyBarController(Controller) {
      static values = { url: String, socket: String, workspaceId: String, agentId: String, transcriptChannel: String };
      static targets = ["terminal", "connectionStatus", "form", "input", "transcript", "transcriptContent", "transcriptEnd"];
      declare readonly element: HTMLElement;
      declare readonly urlValue: string;
      declare readonly socketValue: string;
      declare readonly workspaceIdValue: string;
      declare readonly agentIdValue: string;
      declare readonly transcriptChannelValue: string;
      declare readonly formTarget: HTMLFormElement;
      declare readonly inputTarget: HTMLTextAreaElement;
      declare readonly hasFormTarget: boolean;
      declare readonly terminalTarget: HTMLElement;
      declare readonly connectionStatusTarget: HTMLElement;
      declare readonly transcriptTarget: HTMLElement;
      declare readonly transcriptContentTarget: HTMLElement;
      declare readonly transcriptEndTarget: HTMLButtonElement;
      declare readonly hasTranscriptTarget: boolean;
      declare readonly hasTerminalTarget: boolean;
      private viewer?: ObservableTerminalViewer;
      protected get accessoryViewer(): ObservableTerminalViewer | undefined { return this.viewer; }
      private connected = false;
      private sending = false;
      private get draftKey(): string { return `kintsugi.cliComposerText:${JSON.stringify([this.workspaceIdValue, this.urlValue])}`; }
      private readonly inputChanged = (): void => { localStorage.setItem(this.draftKey, this.inputTarget.value); };
      private touch?: { id: number; startX: number; startY: number; x: number; y: number; time: number; velocity: number; scrolling: boolean };
      private momentum = 0;
      private frame?: TerminalFrame;
      private releaseTranscriptAnchor?: () => void;
      private transcriptSubscription?: CableSubscription;
      // Transcript mode shows the transcript only while the agent waits between turns.
      private transcriptMode = false;
      private transcriptAvailable = false;
      private resize = new ResizeObserver(() => this.frame?.update());

      connect(): void {
        terminals.add(this);
        window.addEventListener("kintsugi:workspace-pane-visible", this.activate);
        if (this.hasFormTarget) {
          setTextInputValue(this.inputTarget, localStorage.getItem(this.draftKey) ?? "");
          this.inputTarget.addEventListener("input", this.inputChanged);
        }
        if (this.hasTranscriptTarget) {
          this.subscribeTranscript();
          this.releaseTranscriptAnchor = anchorScrollBottom(this.transcriptTarget, {
            active: () => this.element.classList.contains("cli-transcript-mode") && this.transcriptTarget.checkVisibility(),
            restored: () => this.transcriptScrolled(),
          });
        }
        this.activate();
      }
      becomeVisible(): void {
        requestAnimationFrame(() => this.scrollToLatestExchange());
      }
      private readonly activate = (): void => {
        if (isWorkspacePaneVisible(this.element)) this.start();
      };
      private start(): void {
        if (!this.hasTerminalTarget || this.viewer) return;
        const stage = this.terminalTarget.parentElement!;
        this.frame = new TerminalFrame({
          stage, host: this.terminalTarget,
          // The whole pane below the status line: composer and key row only clip it.
          measure: () => ({ width: stage.clientWidth, height: this.element.clientHeight - stage.offsetTop }),
          resized: () => this.viewer?.refresh(),
        });
        this.resize.observe(this.element);
        this.resize.observe(stage);
        this.frame.update();
        this.viewer = createObservableTerminalViewer({
          host: this.terminalTarget, mode: "interactive", websocketUrl: observableWebSocketUrl(this.socketValue), hideUnfocusedCursor: true,
          theme: kintsugiObservableTerminalTheme(),
          connectionStatus: this.connectionStatusTarget,
          transformInput: (data) => this.transformAccessoryInput(data),
          nativeTextInput: true,
          onConnectionStateChange: (state) => {
            this.connected = state === "connected";
            // The server shows why the CLI ended, and stops offering the composer.
            if (state === "ended") this.visitStream(`${this.urlValue}/tab`);
          },
          onLink: (link) => {
            if ("url" in link) {
              window.open(link.url, "_blank", "noopener,noreferrer");
              return;
            }
            this.visitStream(`${workspaceFileOpenUrl(this.workspaceIdValue, link.path, link)}&existing=1`);
          },
        });
      }
      /** Follows a link whose response is a Turbo Stream. */
      private visitStream(href: string): void {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.dataset.turboStream = "true";
        anchor.hidden = true;
        this.element.append(anchor);
        anchor.click();
        anchor.remove();
      }
      disconnect(): void {
        terminals.delete(this);
        window.removeEventListener("kintsugi:workspace-pane-visible", this.activate);
        this.resize.disconnect();
        this.frame?.dispose();
        this.frame = undefined;
        this.releaseTranscriptAnchor?.();
        this.transcriptSubscription?.unsubscribe();
        this.transcriptSubscription = undefined;
        if (this.hasFormTarget) {
          this.inputTarget.removeEventListener("input", this.inputChanged);
        }
        this.cancelTerminalTouch();
        if (this.hasTerminalTarget) this.resetAccessoryKeys();
        this.viewer?.dispose();
        this.viewer = undefined;
      }
      // Gespenst captures touch pointers as terminal mouse drags. Defer mouse input
      // until a completed tap so a swipe cannot click or select in the TUI.
      terminalPointer(event: PointerEvent): void {
        if (event.pointerType === "touch") event.stopPropagation();
      }
      startTerminalTouch(event: TouchEvent): void {
        this.stopMomentum();
        const point = event.touches[0];
        this.touch = event.touches.length === 1 && point
          ? { id: point.identifier, startX: point.screenX, startY: point.screenY, x: point.clientX, y: point.clientY, time: event.timeStamp, velocity: 0, scrolling: false }
          : undefined;
      }
      moveTerminalTouch(event: TouchEvent): void {
        const touch = this.touch;
        const point = event.touches[0];
        if (!touch || event.touches.length !== 1 || !point || point.identifier !== touch.id) { this.touch = undefined; return; }
        const dx = point.screenX - touch.startX;
        const dy = point.screenY - touch.startY;
        if (!touch.scrolling && Math.abs(dy) > 6 && Math.abs(dy) > Math.abs(dx)) touch.scrolling = true;
        if (touch.scrolling) {
          event.preventDefault();
          const delta = touch.y - point.clientY;
          if (delta < 0) this.viewer?.setHistoryCursorHidden(true);
          this.viewer?.scrollTouch(delta, point.clientX, point.clientY);
          touch.velocity = delta / Math.max(1, event.timeStamp - touch.time);
        }
        touch.x = point.clientX;
        touch.y = point.clientY;
        touch.time = event.timeStamp;
      }
      cancelTerminalTouch(): void { this.touch = undefined; this.stopMomentum(); }
      finishTerminalTouch(event: TouchEvent): void {
        const touch = this.touch;
        this.touch = undefined;
        if (touch?.scrolling) {
          event.preventDefault();
          if (event.timeStamp - touch.time < 80 && Math.abs(touch.velocity) > 0.05) this.glide(touch.velocity, touch.x, touch.y);
          return;
        }
        const point = event.changedTouches[0];
        if (!touch || event.changedTouches.length !== 1 || !point || point.identifier !== touch.id
          || Math.hypot(point.screenX - touch.startX, point.screenY - touch.startY) > 10) return;
        event.preventDefault();
        const viewer = this.viewer;
        if (!viewer) return;
        const { clientX, clientY } = point;
        // Mobile browsers may cancel or retarget pointerup after a touch. Resolve
        // the completed tap directly against the painted cells instead. Start the
        // link lookup at the original location, before the terminal shifts.
        const bounds = this.terminalTarget.getBoundingClientRect();
        const link = viewer.activateLinkAt(clientX, clientY);
        // Focusing after the asynchronous lookup loses the touch gesture on
        // mobile Safari, so it cannot open the software keyboard.
        viewer.focus();
        void link.then((opened) => {
          if (opened || this.viewer !== viewer) return;
          viewer.setHistoryCursorHidden(false);
          const shifted = this.terminalTarget.getBoundingClientRect();
          const pointer = new PointerEvent("pointerup", {
            clientX: shifted.left + clientX - bounds.left,
            clientY: shifted.top + clientY - bounds.top,
          });
          viewer.dragPointer(pointer, "press", false);
          viewer.dragPointer(pointer, "release", false);
        });
      }
      private stopMomentum(): void { cancelAnimationFrame(this.momentum); this.momentum = 0; }
      private glide(velocity: number, x: number, y: number): void {
        let last = performance.now();
        const frame = (now: number): void => {
          const elapsed = Math.min(now - last, 40);
          last = now;
          velocity *= Math.exp(-elapsed / 180);
          if (Math.abs(velocity) < 0.02) { this.momentum = 0; return; }
          this.viewer?.scrollTouch(velocity * elapsed, x, y);
          this.momentum = requestAnimationFrame(frame);
        };
        this.momentum = requestAnimationFrame(frame);
      }
      sendNativeInput(event: CustomEvent<{ data: string }>): void {
        const data = this.transformAccessoryInput(event.detail.data);
        this.viewer?.sendInput(data);
        if (data !== event.detail.data) event.target!.dispatchEvent(new Event("terminal-text-input:reset"));
      }
      resumeInput(): void { this.viewer?.setHistoryCursorHidden(false); }
      get canToggleMode(): boolean { return this.hasTranscriptTarget; }
      toggleMode(): void {
        if (this.transcriptMode) {
          this.showTerminal();
          this.focus();
        } else {
          this.showTranscript();
        }
      }
      showTranscript(): void { this.setTranscriptMode(true); }
      showTerminal(): void { this.setTranscriptMode(false); }
      private setTranscriptMode(transcriptMode: boolean): void {
        if (transcriptMode !== this.transcriptMode) {
          this.transcriptMode = transcriptMode;
          this.subscribeTranscript();
        }
        this.syncTranscript();
      }
      /** Only a pane in transcript mode receives the transcript itself. */
      private subscribeTranscript(): void {
        this.transcriptSubscription?.unsubscribe();
        const agentId = this.agentIdValue;
        this.transcriptSubscription = window.KintsugiCable!.subscribe(CableTopics.module(this.transcriptChannelValue, this.workspaceIdValue, this.transcriptMode ? { agentId, transcript: "shown" } : { agentId }));
      }
      private syncTranscript(): void {
        this.element.classList.toggle("cli-transcript-pending", this.transcriptMode && !this.transcriptAvailable);
        const showing = this.transcriptMode && this.transcriptAvailable;
        if (showing === this.element.classList.contains("cli-transcript-mode")) return;
        this.element.classList.toggle("cli-transcript-mode", showing);
        if (showing) this.transcriptEndTarget.hidden = true;
        // A full redraw is slow; the terminal only needs one after being hidden.
        else this.viewer?.refresh();
      }
      private transcriptEndTop(): number {
        const transcript = this.transcriptTarget;
        return Math.max(0, transcript.scrollTop + this.transcriptContentTarget.getBoundingClientRect().bottom - transcript.getBoundingClientRect().top - transcript.clientHeight + 24);
      }
      transcriptContentTargetConnected(content: HTMLElement): void {
        this.transcriptAvailable = content.dataset.available === "true";
        this.syncTranscript();
        requestAnimationFrame(() => this.scrollToLatestExchange());
      }
      /** Show the end of the answer unless that would hide its prompt. */
      private scrollToLatestExchange(): void {
        this.transcriptTarget.scrollTop = latestExchangeTop(this.transcriptTarget, this.transcriptContentTarget, this.transcriptEndTop());
        this.transcriptScrolled();
      }
      transcriptScrolled(): void {
        this.transcriptEndTarget.hidden = this.transcriptEndTop() - this.transcriptTarget.scrollTop <= 32;
      }
      scrollToTranscriptEnd(): void {
        this.transcriptTarget.scrollTo({ top: this.transcriptEndTop(), behavior: "smooth" });
      }
      inputKeydown(event: KeyboardEvent): void {
        if (this.element.querySelector<HTMLElement>(".agent-completion-menu-host:not([hidden])")?.checkVisibility()) return;
        // Enter inserts a newline on every keyboard; only ⌘/Ctrl+Enter sends.
        if (!composerSubmitKey(event)) return;
        event.preventDefault();
        this.formTarget.requestSubmit();
      }
      async submit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (this.sending) return;
        const status = this.element.querySelector<HTMLElement>('[data-agent-attachments-target="status"]')!;
        const showError = (message: string): void => { status.textContent = message; status.hidden = false; };
        if (!this.connected || !this.viewer) { showError("Terminal disconnected. Reconnect and try again."); return; }
        const form = this.formTarget;
        const data = new FormData(form);
        const draftText = this.inputTarget.value;
        this.startSending(true);
        if (!String(data.get("text") ?? "").trim() && !data.has("attachment")) {
          status.hidden = true;
          this.viewer.pressEnter();
          this.sent();
          return;
        }
        this.sending = true;
        status.hidden = true;
        try {
          const delivered = await this.deliver(data);
          const sentIds = data.getAll("attachment").map(String);
          if (delivered && sentIds.length) {
            const consumed = await fetch(`${form.action}/consumed`, { method: "POST", body: data });
            if (!consumed.ok) throw new Error("Prompt sent, but attachments could not be cleared.");
            for (const chip of form.querySelectorAll(".agent-chip:not(.uploading)")) {
              if (sentIds.includes(chip.querySelector<HTMLInputElement>('input[name="attachment"]')!.value)) chip.remove();
            }
          }
          this.sent();
        } catch (error) {
          // Sending never discards the draft.
          if (!this.inputTarget.value) setTextInputValue(this.inputTarget, draftText);
          this.failed();
          showError(errorMessage(error));
        }
        finally { this.sending = false; }
      }
      async sendPrompt(event: CustomEvent<AgentComposerSendPromptDetail>): Promise<void> {
        if (this.sending) { event.detail.onComplete?.(new Error("The composer is already sending a prompt")); return; }
        const status = this.element.querySelector<HTMLElement>('[data-agent-attachments-target="status"]')!;
        const data = new FormData();
        data.set("text", event.detail.text);
        data.set("attachmentDraft", String(new FormData(this.formTarget).get("attachmentDraft")));
        this.sending = true;
        status.hidden = true;
        this.startSending(false);
        try {
          await this.deliver(data);
          this.sent();
          event.detail.onComplete?.();
        }
        catch (error) { this.failed(); status.textContent = errorMessage(error); status.hidden = false; event.detail.onComplete?.(error instanceof Error ? error : new Error(String(error))); }
        finally { this.sending = false; }
      }
      /** The terminal replaces the transcript before anything else moves; the composer empties at once. */
      private startSending(fromComposer: boolean): void {
        changeLayout(() => {
          // Don't wait for the agent to report its turn; the channel confirms it.
          this.transcriptAvailable = false;
          this.syncTranscript();
          if (fromComposer) setTextInputValue(this.inputTarget, "");
          this.element.dispatchEvent(new Event("agent-composer:sending"));
        });
      }
      private sent(): void {
        this.element.dispatchEvent(new Event("agent-composer:sent"));
      }
      private failed(): void {
        this.element.dispatchEvent(new Event("agent-composer:failed"));
      }
      // Returns false when the server handled the prompt itself without terminal input.
      private async deliver(data: FormData): Promise<boolean> {
        if (!this.connected || !this.viewer) throw new Error("Terminal disconnected. Reconnect and try again.");
        const response = await fetch(this.formTarget.action, { method: "POST", body: data });
        if (!response.ok) throw new Error(await response.text());
        if (response.status === 204) return false;
        const text = await response.text();
        if (!this.connected) throw new Error("Terminal disconnected. Prompt retained; check the terminal before retrying.");
        this.viewer.paste(text);
        // The TUI handles bracketed paste asynchronously; let it finish before
        // submitting a real Enter key, rather than merging Enter into the paste.
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!this.connected) throw new Error("Terminal disconnected after paste. Check the terminal before retrying.");
        this.viewer.pressEnter();
        return true;
      }
      retry(): void {
        this.viewer!.reconnect();
      }
      focus(): void {
        this.start();
        if (!this.element.classList.contains("cli-transcript-mode")) this.viewer?.focus();
      }
      refresh(): void {
        if (!this.hasTerminalTarget || !isWorkspacePaneVisible(this.element)) return;
        this.frame?.update();
        this.viewer?.refresh();
      }
      theme(): void { this.viewer?.setTheme(kintsugiObservableTerminalTheme()); }
    });
  },
};
