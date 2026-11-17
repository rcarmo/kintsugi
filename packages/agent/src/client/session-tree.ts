/// <reference lib="dom" />

import { setTextInputValue } from "@kintsugi/shared";

type TextInput = HTMLInputElement | HTMLTextAreaElement;

type TreeAutocompleteActions = {
  readonly open: boolean;
  activeOption(): HTMLElement | undefined;
  close(): void;
};

interface SessionTreeElements {
  menu: HTMLElement;
  url: string;
}

function elements(input: TextInput): SessionTreeElements {
  const host = input.closest<HTMLElement>("[data-agent-completions-url-value]")!;
  return {
    menu: host.querySelector<HTMLElement>("[data-agent-completions-target='menu']")!,
    url: `${host.dataset.agentCompletionsUrlValue!.replace(/\/completions$/, "")}/tree`,
  };
}

const mutatingMenus = new WeakSet<HTMLElement>();
const requests = new WeakMap<HTMLElement, number>();
export const agentTreeMenuIsUpdating = (menu: HTMLElement) => mutatingMenus.has(menu);
function mutateMenu(menu: HTMLElement, change: () => void) {
  mutatingMenus.add(menu);
  try {change();} finally {mutatingMenus.delete(menu);}
}
export function clearAgentTreeMenu(menu: HTMLElement) {
  requests.set(menu,(requests.get(menu) ?? 0)+1);
  mutateMenu(menu,()=>menu.replaceChildren());
}
function showMessage(menu: HTMLElement, message: string, loading = false): void {
  const content = document.createElement("div");
  content.className = "agent-completion-menu empty";
  if (loading) {
    const spinner = document.createElement("span");
    spinner.className = "agent-completion-spinner";
    spinner.setAttribute("aria-hidden", "true");
    content.append(spinner);
  }
  content.append(message);
  mutateMenu(menu,()=>{menu.replaceChildren(content);menu.hidden = false;});
}

/** Fit above the composer without slipping behind the Agent header on short/touch layouts. */
export function fitAgentTreeMenu(menu: HTMLElement) {
  if (menu.hidden) return;
  const popup = menu.querySelector<HTMLElement>(".agent-tree-menu, .agent-tree-summary-menu");
  const pane = menu.closest<HTMLElement>(".agent-pane");
  if (!popup || !pane) return;
  const available = menu.getBoundingClientRect().bottom - pane.getBoundingClientRect().top - 8;
  popup.style.maxHeight = `${Math.max(80,Math.min(popup.classList.contains("agent-tree-summary-menu") ? 470 : 500,available))}px`;
}
async function showResponse(menu: HTMLElement, response: Response, request?: number): Promise<boolean> {
  const content = await response.text();
  if (request !== undefined && requests.get(menu) !== request) return false;
  if (response.ok) {
    const active = document.activeElement;
    const focusSearch = active instanceof HTMLInputElement && active.classList.contains("agent-tree-search") && menu.contains(active);
    const focusFilter = active instanceof HTMLSelectElement && active.classList.contains("agent-tree-filter") && menu.contains(active);
    mutateMenu(menu,()=>{
      menu.innerHTML = content;menu.hidden = false;fitAgentTreeMenu(menu);
      if (focusSearch) menu.querySelector<HTMLInputElement>(".agent-tree-search")?.focus();
      else if (focusFilter) menu.querySelector<HTMLSelectElement>(".agent-tree-filter")?.focus();
    });
  } else {
    showMessage(menu, content);
  }
  return response.ok;
}

async function refresh(input: TextInput, options: { query?: string; filter?: string; focusSearch?: boolean } = {}): Promise<void> {
  const { menu, url } = elements(input);
  const endpoint = new URL(url, window.location.href);
  if (options.query) endpoint.searchParams.set("q", options.query);
  if (options.filter) endpoint.searchParams.set("filter", options.filter);
  const request = (requests.get(menu) ?? 0)+1;requests.set(menu,request);
  const response = await fetch(endpoint,{headers:{Accept:"text/html"}});
  if (requests.get(menu) !== request) return;
  const shown = await showResponse(menu,response,request);
  if (shown && options.focusSearch) {
    const search = menu.querySelector<HTMLInputElement>(".agent-tree-search")!;
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  }
}

async function open(input: TextInput): Promise<void> {
  const { menu } = elements(input);
  setTextInputValue(input,"");
  showMessage(menu, "Loading session tree…", true);
  await refresh(input);
}

const searchTimers = new WeakMap<HTMLElement, number>();

function scheduleRefresh(target: HTMLElement, input: TextInput): void {
  const { menu } = elements(input);
  const query = target instanceof HTMLInputElement ? target.value : menu.querySelector<HTMLInputElement>(".agent-tree-search")!.value;
  const filter = target instanceof HTMLSelectElement ? target.value : menu.querySelector<HTMLSelectElement>(".agent-tree-filter")!.value;
  window.clearTimeout(searchTimers.get(menu));
  searchTimers.set(menu, window.setTimeout(() => void refresh(input, { query, filter, focusSearch: target instanceof HTMLInputElement }), target instanceof HTMLInputElement ? 100 : 0));
}

function editLabel(action: HTMLElement): void {
  const row = action.closest<HTMLElement>(".agent-tree-row")!;
  row.querySelector<HTMLElement>(".agent-tree-label-editor")!.hidden = false;
  row.querySelector<HTMLInputElement>(".agent-tree-label-editor input")!.focus();
}

async function updateLabel(action: HTMLElement, input: TextInput, operation: "add" | "remove"): Promise<void> {
  const { menu, url } = elements(input);
  const row = action.closest<HTMLElement>(".agent-tree-row")!;
  const query = menu.querySelector<HTMLInputElement>(".agent-tree-search")!.value;
  const filter = menu.querySelector<HTMLSelectElement>(".agent-tree-filter")!.value;
  const body = new FormData();
  body.set("entry", row.dataset.treeEntry!);
  body.set("operation", operation);
  body.set("label", operation === "remove" ? action.dataset.treeLabel! : row.querySelector<HTMLInputElement>(".agent-tree-label-editor input")!.value);
  const response = await fetch(`${url}/label`, { method: "POST", body });
  if (!response.ok) {
    showMessage(menu, await response.text());
    return;
  }
  await refresh(input, { query, filter });
  input.focus();
}

function nodeAction(action: HTMLElement, input: TextInput): void {
  const kind = action.dataset.treeAction;
  if (kind === "label-edit") editLabel(action);
  else if (kind === "label-cancel") action.closest<HTMLElement>(".agent-tree-label-editor")!.hidden = true;
  else if (kind === "label-save") void updateLabel(action, input, "add");
  else if (kind === "label-remove") void updateLabel(action, input, "remove");
}

async function openContinuation(option: HTMLElement, input: TextInput): Promise<void> {
  const { menu, url } = elements(input);
  const endpoint = new URL(`${url}/summary`, window.location.href);
  endpoint.searchParams.set("entry", option.dataset.treeEntry!);
  showMessage(menu, "Loading options…", true);
  const request = (requests.get(menu) ?? 0)+1;requests.set(menu,request);
  const response = await fetch(endpoint,{headers:{Accept:"text/html"}});
  if (requests.get(menu) === request) await showResponse(menu,response,request);
}

async function navigate(option: HTMLElement, input: TextInput): Promise<void> {
  const { menu, url } = elements(input);
  const summaryMenu = option.closest<HTMLElement>(".agent-tree-summary-menu")!;
  showMessage(menu, "Navigating…", true);
  const body = new FormData();
  body.set("entry", summaryMenu.dataset.treeEntry!);
  const response = await fetch(url, { method: "POST", body });
  if (!response.ok) {
    showMessage(menu, await response.text());
    return;
  }
  menu.hidden = true;
  clearAgentTreeMenu(menu);
  setTextInputValue(input, await response.text());
  input.focus();
}

export function agentTreeOwnsMenu(menu: HTMLElement): boolean {
  return Boolean(menu.querySelector(".agent-tree-menu, .agent-tree-summary-menu"));
}

export function handleAgentTreeMenuEvent(event: Event, input: TextInput): boolean | void {
  if (!(event.target instanceof HTMLElement)) return;
  const action = event.target.closest<HTMLElement>("[data-tree-action]");
  if (action && (event.type === "click" || (event instanceof PointerEvent && event.type === "pointerdown" && event.pointerType === "touch"))) nodeAction(action, input);
  if (action && (event.type === "click" || event.type === "pointerdown")) return true;
  if (event.type === "input" && event.target.classList.contains("agent-tree-search")) scheduleRefresh(event.target, input);
  if (event.type === "change" && event.target.classList.contains("agent-tree-filter")) scheduleRefresh(event.target, input);
  if (!(event instanceof KeyboardEvent) || event.type !== "keydown" || !event.target.matches(".agent-tree-label-editor input")) return;
  if (event.isComposing) return;
  const key = event.key;
  if (key === "Enter" || key === "Escape") {event.preventDefault();event.stopPropagation();}
  if (key === "Enter") event.target.closest<HTMLElement>(".agent-tree-label-editor")!.querySelector<HTMLButtonElement>("[data-tree-action='label-save']")!.click();
  else if (key === "Escape") event.target.closest<HTMLElement>(".agent-tree-label-editor")!.querySelector<HTMLButtonElement>("[data-tree-action='label-cancel']")!.click();
}

export function selectAgentTreeOption(option: HTMLElement, input: TextInput): boolean {
  if (option.dataset.commandAction === "tree") void open(input);
  else if (option.dataset.completionKind === "tree-entry") void openContinuation(option, input);
  else if (option.dataset.completionKind === "tree-continue") void navigate(option, input);
  else return false;
  return true;
}

export function handleAgentTreeKeydown(event: KeyboardEvent, input: TextInput, actions: TreeAutocompleteActions): boolean {
  if (event.isComposing) return false;
  const send = event.key === "Enter" && (event.metaKey || event.ctrlKey);
  const nativeTree = input.closest(".composer")?.querySelector('[data-agent-completions-target="catalog"] [data-command-action="tree"]');
  if ((send || event.key === "Enter") && input.value.trim() === "/tree" && nativeTree) {
    event.preventDefault();
    event.stopImmediatePropagation();
    actions.close();
    void open(input);
    return true;
  }
  if (event.key.toLowerCase() !== "l" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !actions.open) return false;
  const active = actions.activeOption();
  if (active?.dataset.completionKind !== "tree-entry") return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  editLabel(active);
  return true;
}
