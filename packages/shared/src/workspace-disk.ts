import { Type } from "typebox";

export const workspaceDiskRoot = "/data/workspace-disks";
export const workspaceDiskImageDirectory = "workspace-disks";
export const workspaceDiskImageSuffix = ".ext4";
export const defaultWorkspaceDiskGiB = 8;
export const workspaceDiskIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const workspaceDiskSizeSchema = Type.Integer({ minimum: 1, maximum: 1024 });
export const GiB = 1024 ** 3;

export interface WorkspaceDiskSnapshot {
  limitGiB: number;
  requestedLimitGiB?: number;
  usedBytes: number;
  availableBytes: number;
}
