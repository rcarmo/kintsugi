import { Type } from "typebox";

const coordinate = Type.Number({ minimum: -1000000, maximum: 1000000 });

export const inlineContentFrameMessage = Type.Union([
  Type.Object({ type: Type.Literal("ready") }),
  Type.Object({ type: Type.Literal("size"), height: Type.Number({ minimum: 0, maximum: 1000000 }), overflow: Type.Boolean() }),
  Type.Object({ type: Type.Literal("error"), message: Type.String({ maxLength: 10000 }) }),
  Type.Object({ type: Type.Literal("scroll"), deltaY: Type.Number() }),
  Type.Object({ type: Type.Literal("link"), href: Type.String({ pattern: "^https?://", maxLength: 8192 }) }),
  Type.Object({ type: Type.Literal("selection"), text: Type.String({ minLength: 1, maxLength: 1048576 }), code: Type.Boolean(), rect: Type.Object({ left: coordinate, top: coordinate, right: coordinate, bottom: coordinate }) }),
  Type.Object({ type: Type.Literal("selection-cleared") }),
]);
export const inlineContentThemeMessage = Type.Object({ type: Type.Literal("theme"), theme: Type.String({ maxLength: 64 }), fontSize: Type.String({ pattern: "^\\d+(\\.\\d+)?px$" }) });
export const inlineContentConnectMessage = Type.Object({ type: Type.Literal("inline-content-connect") });
