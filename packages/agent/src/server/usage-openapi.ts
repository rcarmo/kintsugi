import type { JsonObject } from "@kintsugi/core";
import { supportedUsageProviders } from "@kintsugi/llm/server";

const errorResponse = { description: "Request failed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
const htmlSurfaceResponses = (description: string) => ({ "200": { description, content: { "text/html": { schema: { type: "string" } } } }, "400": errorResponse, "404": errorResponse });
const jsonResponse = (description: string, schema: JsonObject) => ({ "200": { description, content: { "application/json": { schema } } }, "400": errorResponse, "404": errorResponse });

const reportedUsageWindowSchema = {
  type: "object",
  properties: {
    periodBasis: { enum: ["calendar-month-estimate"], description: "Monthly pacing for Copilot allowances and Codex workspace credits is inferred, not a provider-reported period length." },
    limitName: { type: "string" }, meteredFeature: { type: ["string", "null"] }, kind: { enum: ["primary", "secondary"] },
    usedPercent: { type: "number" }, durationSeconds: { type: ["integer", "null"], description: "Null when a window duration cannot be established; pacing is unavailable." }, resetsAt: { type: ["string", "null"], format: "date-time", description: "Null when the provider has not reported reset timing; usage is still reported." },
    limitReached: { type: "boolean", description: "Present when the provider says this window ran out, such as one model's weekly cap while others still work." },
  },
};
const providerUsageSchema = {
  type: "object",
  properties: {
    provider: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } }, connected: { type: "boolean" }, error: { type: ["string", "null"] }, timingAt: { type: "string", format: "date-time", description: "When pacing was calculated. Consumption can be an older observed snapshot." },
    reported: { type: ["object", "null"], properties: {
      plan: { type: ["string", "null"], description: "Null when the provider does not report the subscription plan." }, checkedAt: { type: "string", format: "date-time" }, allowed: { type: ["boolean", "null"] }, limitReached: { type: ["boolean", "null"] },
      credits: { type: "object", properties: { unlimited: { type: "boolean" }, balance: { type: ["string", "null"], description: "Provider-reported units, not dollars." } } },
      balance: { type: "object", properties: { currency: { type: "string" }, available: { type: "number", description: "Prepaid balance in currency units, not cents or provider credits." }, monthSpend: { type: ["number", "null"], description: "Null when the provider does not report this month's spend." } } },
      resets: { type: "object", properties: { available: { type: "integer", minimum: 0 } } },
      allowances: { type: "array", description: "Reported Copilot account categories, including unlimited and unknown amounts. Only the selected category drives pacing; these are not session charges.", items: { type: "object", properties: {
        quotaId: { type: "string" }, sourceQuotaId: { type: ["string", "null"] }, label: { type: "string" }, unit: { enum: ["requests", "credits", "completions", "unknown"] }, selected: { type: "boolean" },
        entitlement: { type: ["number", "null"], description: "Minus one denotes unlimited. Null means not reported." }, remaining: { type: ["number", "null"], description: "Reported quantity, not reconstructed from rounded percentages." },
        remainingPercent: { type: ["number", "null"], minimum: 0, maximum: 100 }, remainingPercentSource: { enum: ["reported", "quantity-estimate", "unknown"] }, unlimited: { type: "boolean" },
        overageCount: { type: ["number", "null"], description: "Reported separately, never added to allowance usage." }, overagePermitted: { type: ["boolean", "null"], description: "Permission for additional usage; does not guarantee that requests are allowed." }, creditsUsed: { type: ["number", "null"], description: "AI credits consumed this period, as GitHub reports for token-billed seats. Not a percentage of any allowance." }, resetsAt: { type: ["string", "null"], format: "date-time" },
      } } },
      windows: { type: "array", items: reportedUsageWindowSchema },
    } },
    windows: { type: "array", items: { type: "object", properties: {
      reported: reportedUsageWindowSchema,
      timing: { type: "object", description: "Linear pacing reference at timingAt. Start is inferred from reset minus duration, not explicitly reported by the provider. When reset timing or window duration is unknown, state is unknown and all timing values are null.", properties: {
        startsAt: { type: ["string", "null"], format: "date-time" }, elapsedPercent: { type: ["number", "null"], minimum: 0, maximum: 100 },
        paceDifferenceSeconds: { type: ["number", "null"], description: "Signed distance along the linear allowance schedule: paceDifferencePoints / 100 × durationSeconds. Positive means usage is ahead of pace; negative means behind. Not a forecast. Null outside an active window." },
        state: { enum: ["unknown", "not-started", "active", "reset-due"] }, paceDifferencePoints: { type: ["number", "null"], description: "Usage minus elapsed-time percentage, in percentage points. Positive is above linear pace. Null outside an active window." },
      } },
    } } },
  },
};

const refreshParameter = { name: "refresh", in: "query", required: false, schema: { type: "string" }, description: "When present, ask providers now instead of reusing what Kintsugi already knows." } satisfies JsonObject;

export const usageOpenApiPaths = {
  "/usage": { get: {
    summary: "Inspect all connected, supported providers",
    parameters: [refreshParameter],
    description: "JSON only; in the app, usage shows on each provider in the Models dialog (`GET /models`). Includes provider-reported subscription windows and pacing. Supports OpenAI Codex, Anthropic, xAI, Radius, GitHub Copilot and OpenCode Go subscriptions. OpenCode Go uses an API key and shows five-hour and weekly windows; its monthly limit affects availability but is not assigned an invented pacing period. Copilot uses the stored GitHub OAuth token and its issuer (github.com or the configured GitHub Enterprise host) to read account allowance categories and overage. Free accounts select chat; paid accounts prefer premium_models over premium_interactions. Pacing is explicitly estimated using the month ending at the reported reset; without a reset there is no pacing estimate. Token-billed seats that report only placeholder snapshots fall back to monthly_quotas/limited_user_quotas, and their AI credits used are reported per allowance. Allowance exhaustion is separate from permission to continue. Anthropic requires OAuth sign-in, not an API key; its main limits come from Claude Code responses through the workspace proxy. AgentsInTheCloud asks Anthropic with a one-token message to its cheapest model only on the first read after start or a credential change, after a window resets, and on refresh. Provider failures are explicit per-provider errors.",
    responses: jsonResponse("Usage overview", { type: "object", properties: { providers: { type: "array", items: providerUsageSchema } } }),
  } },
  "/usage/button": { get: { summary: "Usage button perimeter for the most urgent recently used subscription", responses: htmlSurfaceResponses("Server-rendered button frame; it opens the Models dialog with that provider expanded. Among subscriptions used in the 30 minutes ending at the last recorded inference, shows the active allowance projected to reach 100% soonest before its next reset, at its average consumption rate since the window began. Projections stop at the next reset; limits that will not fill before then have no projected hit before reset. Ties prefer higher usage. Green is Time beyond Usage; red is Usage beyond Time. No ring without recorded activity or an active reported limit.") } },
  "/usage/providers/{provider}": { get: {
    summary: "Refresh subscription limits for a provider",
    parameters: [{ name: "provider", in: "path", required: true, schema: { type: "string", enum: supportedUsageProviders.map((provider) => provider.id) } }, refreshParameter],
    responses: jsonResponse("Provider usage, including any provider error", providerUsageSchema),
  } },
} satisfies Record<string, JsonObject>;
