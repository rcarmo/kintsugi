import { Type, type Static } from "typebox";

export const nativeWebviewContext = Type.Object({ publicOrigin: Type.String(), root: Type.String(), app: Type.String(), upstream: Type.String(), cookies: Type.Optional(Type.String()), source: Type.Optional(Type.String()) });
export const nativeWebviewContent = Type.Object({
  contents: Type.String(),
  options: Type.Object({ allowScripts: Type.Optional(Type.Boolean()), allowForms: Type.Optional(Type.Boolean()), allowMultipleAPIAcquire: Type.Optional(Type.Boolean()) }),
  state: Type.Optional(Type.String()),
});
export const nativeWebviewStyles = Type.Object({
  styles: Type.Record(Type.String(), Type.String()),
  activeTheme: Type.String(),
  themeLabel: Type.Optional(Type.String()),
  themeId: Type.Optional(Type.String()),
  reduceMotion: Type.Optional(Type.Boolean()),
  screenReader: Type.Optional(Type.Boolean()),
});
export const nativeWebviewEnvelope = Type.Object({ channel: Type.String(), args: Type.Optional(Type.Unknown()) });
export const nativeWebviewInnerConfiguration = Type.Object({
  nonce: Type.String(), context: nativeWebviewContext,
  allowScripts: Type.Boolean(), allowForms: Type.Boolean(), allowMultipleAPIAcquire: Type.Boolean(), state: Type.Optional(Type.String()),
});
export type NativeWebviewContent = Static<typeof nativeWebviewContent>;
export type NativeWebviewStyles = Static<typeof nativeWebviewStyles>;
