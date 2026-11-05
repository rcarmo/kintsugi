import type { WorkspaceServerSocketSession, WorkspaceSocketConnection } from "@kintsugi/shared";

/** A failed workspace connection ends its socket, not the management app. */
export async function openWorkspaceSocket(session: WorkspaceServerSocketSession, socket: WorkspaceSocketConnection): Promise<void> {
  try {
    await session.open?.(socket);
  } catch (error) {
    console.error("Workspace WebSocket initialization failed", error);
    socket.close(1011, "Workspace connection failed");
  }
}
