function iconHtml(paths: string): string {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

/** Product mark for app branding. Accessible names belong on the containing UI. */
export const kintsugiBrandIconHtml = '<img class="kintsugi-brand-icon" src="/kintsugi-brand.png" width="24" height="24" alt="" aria-hidden="true">';

/** Canonical decorative icons. Accessible names belong on the control or content that contains them. */
export const Icons = {
  Agent: iconHtml('<path d="M9 4h6M12 4V2M6 8h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/>'),
  Subagents: iconHtml('<path d="M7 5V3M5 3h4M3 7h8a1 1 0 0 1 1 1v6H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM17 12v-2m-2 0h4M13 14h8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/><path d="M5 10h.01M9 10h.01M15 18h.01M19 18h.01" stroke-width="2.6"/>'),
  ArrowDown: iconHtml('<path d="M12 4v16M6 14l6 6 6-6"/>'),
  Back: iconHtml('<path d="m15 18-6-6 6-6"/>'),
  Bell: iconHtml('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>'),
  Browser: iconHtml('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>'),
  Check: iconHtml('<path d="m5 12 4 4L19 6"/>'),
  Cloud: iconHtml('<path d="M6 19a4 4 0 0 1-1-7.87A7 7 0 0 1 18.6 9.4 4.8 4.8 0 0 1 18 19Z"/>'),
  Comment: iconHtml('<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/><path d="M8 8h8M8 12h5"/>'),
  Copy: iconHtml('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>'),
  Close: iconHtml('<path d="M6 6l12 12M18 6L6 18"/>'),
  CollapseAll: iconHtml('<path d="M7 4l5 5 5-5M7 20l5-5 5 5"/>'),
  Code: iconHtml('<path d="m9 7-5 5 5 5m6-10 5 5-5 5"/>'),
  Server: iconHtml('<rect x="6" y="3" width="12" height="18" rx="1.5"/><path d="M9 7h6M9 11h6M9 15h6"/><path d="M9 18h.01"/>'),
  Desktop: iconHtml('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v4M8 21h8"/>'),
  Disclosure: '<svg class="disclosure-icon" aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  Exclamation: iconHtml('<path d="M12 4v10"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/>'),
  ExpandAll: iconHtml('<path d="M7 9l5-5 5 5M7 15l5 5 5-5"/>'),
  Forward: iconHtml('<path d="m9 18 6-6-6-6"/>'),
  Files: iconHtml('<path d="M4 5h6l2 2h8v12H4z"/>'),
  Keyboard: iconHtml('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>'),
  More: iconHtml('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  Next: iconHtml('<path d="M4 12h14M13 7l5 5-5 5"/><circle cx="5" cy="6" r="1.5" fill="currentColor" stroke="none"/>'),
  Panel: iconHtml('<path d="M4 4h16v16H4zM15 4v16"/>'),
  Park: iconHtml('<path d="M17.5 15.5A7 7 0 0 1 8.5 6.5a7 7 0 1 0 9 9z"/><path d="M16 5h4M18 3v4"/>'),
  Paperclip: iconHtml('<path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'),
  Plus: iconHtml('<path d="M12 5v14M5 12h14"/>'),
  WorkspaceTemplates: iconHtml('<path d="M5 18V5a2 2 0 0 1 2-2h12v18H7a2 2 0 0 1 0-4h12M9 3v14M12 7h4"/>'),
  QrCode: iconHtml('<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h3v3h-3zM18 18h3v3h-3zM12 3v9H3M21 12h-6v3M12 15v6M21 15v-3"/>'),
  Refresh: iconHtml('<path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7"/>'),
  Changes: iconHtml('<path d="M9 5h6M9 3h6v4H9zM7 5H5v16h14V5h-2M8 13l2 2 5-5"/>'),
  Star: iconHtml('<path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9z"/>'),
  StarFilled: iconHtml('<path fill="currentColor" d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9z"/>'),
  Search: iconHtml('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'),
  Settings: iconHtml('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>'),
  Stop: iconHtml('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>'),
  Terminal: iconHtml('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>'),
  TranscriptPending: iconHtml('<rect x="5" y="2" width="14" height="12" rx="2"/><path d="M8 5h8M8 8.5h8M8 12h5M6 20h12m-3-3 3 3-3 3"/>'),
  Transcript: iconHtml('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  Trash: iconHtml('<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>'),
  Usage: iconHtml('<path d="M4 20h16M7 16v-5M12 16V4M17 16V8"/>'),
  Workspace: iconHtml('<path d="M4 5h16v14H4zM8 9h8M8 13h5"/>'),
} as const;

/** Builtin agents use the same monochrome robot as the canonical Agent icon. */
export const builtinAgentIconHtml = Icons.Agent;
