import { parse } from "@babel/parser";
import traverse, { type Visitor } from "@babel/traverse";
import generate from "@babel/generator";
import * as types from "@babel/types";

const globals = new Set(["window", "self", "globalThis", "location"]);
const namespace = () => types.identifier("__kintsugiPreviewGlobals");
const globalReferences: Visitor = {
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
};

/** Parse only: no configuration loader, import resolver, plugins or macro execution. */
export function rewritePreviewGlobals(text: string, handler = false): string {
  const ast = parse(text, { sourceType: "unambiguous", allowReturnOutsideFunction: handler });
  traverse(ast, globalReferences);
  return generate(ast, {}, text).code;
}
