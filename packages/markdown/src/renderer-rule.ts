import type { Env, Renderer, RendererRule, Token } from "markdown-it";

type RenderOptions = Parameters<RendererRule>[2];

/**
 * Our renders always pass an environment, so a rule can take it as its own
 * type instead of markdown-it's optional, open-ended `env`.
 */
export function rendererRule<Environment extends Env>(
  rule: (tokens: Token[], index: number, options: RenderOptions, environment: Environment, renderer: Renderer) => string,
): RendererRule {
  return (tokens, index, options, environment, renderer) =>
    // SAFETY: every render and parse call in this package passes the environment its rules expect.
    rule(tokens, index, options, environment as Environment, renderer);
}
