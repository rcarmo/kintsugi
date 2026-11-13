import { designSystemStaticFiles } from "@kintsugi/design-system/assets";
import type { StaticFileContribution } from "@kintsugi/shared";
import { workspaceProvisioningStaticFiles } from "@kintsugi/workspace/server/provisioning";
import { workspaceModules } from "./workspace-modules.generated.ts";

export type StaticFileEntry = StaticFileContribution;
interface StaticFileRegistry {
  [path: string]: StaticFileEntry;
}

function workspaceModuleStaticFiles(): Record<string, StaticFileEntry> {
  return Object.fromEntries(workspaceModules.flatMap((module) => Object.entries(module.staticFiles ?? {})));
}

const moduleFiles = workspaceModuleStaticFiles();

export const clientEntrypoints: StaticFileRegistry = {
  "/layout.js": { url: new URL("../client/layout-startup.ts", import.meta.url), contentType: "text/javascript; charset=utf-8", bundle: "iife" },
  "/workspace.js": { url: new URL("../client/workspace.ts", import.meta.url), contentType: "text/javascript; charset=utf-8" },
  "/design-system.js": { url: new URL("../../../../packages/design-system/catalogue/client.ts", import.meta.url), contentType: "text/javascript; charset=utf-8" },
  ...Object.fromEntries(Object.entries(moduleFiles).filter(([, entry]) => entry.bundle)),
};

export const fingerprintedStaticFiles: StaticFileRegistry = {
  "/brand/artwork.png": { url: new URL("../../public/brand/artwork.png", import.meta.url), contentType: "image/png" },
  "/icon-192.png": { url: new URL("../../public/icon-192.png", import.meta.url), contentType: "image/png" },
  "/icon-512.png": { url: new URL("../../public/icon-512.png", import.meta.url), contentType: "image/png" },
  "/icon-maskable-512.png": { url: new URL("../../public/icon-maskable-512.png", import.meta.url), contentType: "image/png" },
  "/favicon-32.png": { url: new URL("../../public/favicon-32.png", import.meta.url), contentType: "image/png" },
  "/apple-touch-icon.png": { url: new URL("../../public/apple-touch-icon.png", import.meta.url), contentType: "image/png" },
  "/manifest.webmanifest": { url: new URL("../../public/manifest.webmanifest", import.meta.url), contentType: "application/manifest+json; charset=utf-8" },
  "/service-worker.js": { url: new URL("../client/service-worker.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
  "/style.css": { url: new URL("../../public/style.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  ...designSystemStaticFiles,
  ...workspaceProvisioningStaticFiles,
  ...Object.fromEntries(Object.entries(moduleFiles).filter(([, entry]) => !entry.bundle)),
};

export const legacyStaticFiles: StaticFileRegistry = {
  "/workspace.js": { url: new URL("../../public/workspace.js", import.meta.url), contentType: "text/javascript; charset=utf-8" },
  ...fingerprintedStaticFiles,
};
