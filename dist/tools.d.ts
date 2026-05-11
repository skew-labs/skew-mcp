import type { Tool } from "@modelcontextprotocol/sdk/types.js";
export type SkewMcpProfile = "core" | "trading" | "rfq" | "advanced" | "governance" | "all";
export declare function getSkewDisabledToolReason(name: string): string | null;
export declare function isSkewReadOnlyTool(name: string): boolean;
/**
 * MCP tool catalog for @skew-labs/mcp.
 *
 * Each tool wraps either an on-chain instruction (via @skew-labs/sdk) or a
 * `skew-pricing` HTTP endpoint. Tool descriptions are user-facing and have
 * to be intelligible to the language model that will pick which tool to
 * call. They intentionally avoid naming the off-chain pricing engine's
 * internal estimator framework — the framework is implementation detail and
 * is not part of this package's public surface.
 */
export declare const SKEW_TOOLS: Tool[];
export declare function getSkewMcpProfile(raw: string | undefined): SkewMcpProfile;
export declare function getSkewTools(profile: SkewMcpProfile): Tool[];
//# sourceMappingURL=tools.d.ts.map