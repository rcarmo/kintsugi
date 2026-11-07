import { transformAsync, types, type PluginObject } from "@babel/core";

const globals = new Set(["window", "self", "globalThis", "location"]);
const namespace = () => types.identifier("__kintsugiPreviewGlobals");
const globalReferences: PluginObject = { visitor: {
  Identifier(path) {
    if (!globals.has(path.node.name) || path.scope.getBinding(path.node.name)) return;
    const reference = path.isReferencedIdentifier();
    const binding = path.isBindingIdentifier();
    if (!reference && !binding) return;
    path.replaceWith(types.memberExpression(namespace(), types.identifier(path.node.name)));
    path.skip();
  },
  MemberExpression(path) {
    const { object, property, computed } = path.node;
    if (!types.isIdentifier(object, { name: "document" }) || path.scope.getBinding("document")) return;
    if ((!computed && types.isIdentifier(property, { name: "location" })) || (computed && types.isStringLiteral(property, { value: "location" }))) {
      path.replaceWith(types.memberExpression(namespace(), types.identifier("location"))); path.skip();
    }
  },
} };

/** Parse only: never load project configuration, resolve imports, or execute macros. */
export async function rewritePreviewGlobals(text: string, handler = false): Promise<string> {
  const output = await transformAsync(text, { configFile: false, babelrc: false, sourceType: "unambiguous", parserOpts: { allowReturnOutsideFunction: handler }, plugins: [() => globalReferences], compact: false });
  if (!output?.code) return "";
  return output.code;
}
