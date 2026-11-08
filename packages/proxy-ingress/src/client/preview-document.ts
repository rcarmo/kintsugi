import type {} from "trusted-types";

/** Explicit handoff for platform documents which supply their own scoped runtime. */
export const preparedPreviewDocument = Symbol.for("kintsugi.preview.prepared-document");
declare global {
  interface HTMLIFrameElement {
    [preparedPreviewDocument](source: string | TrustedHTML): void;
  }
}

export function setPreparedPreviewDocument(frame: HTMLIFrameElement, source: string | TrustedHTML): void {
  // The captured native sink still enforces TrustedHTML/default-policy checks.
  frame[preparedPreviewDocument](source);
}
