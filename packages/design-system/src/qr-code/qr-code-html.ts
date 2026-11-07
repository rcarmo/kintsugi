import qrcode from "qrcode-generator";
import { escapeHtml } from "@kintsugi/shared";
import { buttonHtml } from "../button/button-html.ts";
import { dialogHtml } from "../dialog/dialog-html.ts";
import { Icons } from "../icons/icons-html.ts";

/** Icon-only button that natively opens the dialog with id `dialogId`. */
export function qrCodeButtonHtml(dialogId: string, label: string, disabled = false): string {
  return buttonHtml({ type: "button", variant: "secondary", content: { kind: "icon-only", iconHtml: Icons.QrCode, label }, disabled, attributesHtml: `commandfor="${escapeHtml(dialogId)}" command="show-modal"` });
}

/** QR content for a fully resolved URL. */
export function qrCodeContentHtml(url: string): string {
  const code = qrcode(0, "M");
  code.addData(url);
  code.make();
  return `<div class="qr-code"><div class="qr-code__image" role="img" aria-label="QR code for ${escapeHtml(url)}">${code.createSvgTag({ cellSize: 4, margin: 16, scalable: true })}</div><a class="qr-code__url" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a></div>`;
}

/** Dialog with a QR code, or lazy content resolved on the browser's current hostname. */
export function qrCodeDialogHtml(id: string, url: string, contentUrl?: string): string {
  return dialogHtml({
    element: { id, attributesHtml: "data-qr-code-dialog" },
    iconHtml: Icons.QrCode,
    titleCaption: "QR code",
    bodyHtml: contentUrl ? `<turbo-frame id="${escapeHtml(id)}_body" src="${escapeHtml(contentUrl)}" loading="lazy">Loading QR code…</turbo-frame>` : qrCodeContentHtml(url),
  });
}
