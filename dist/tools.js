import { SKEW_PAYOFF_TYPES, SKEW_UNDERLYINGS } from "@skew-labs/sdk";
const UNDERLYING_ENUM = [...SKEW_UNDERLYINGS];
const PAYOFF_ENUM = [...SKEW_PAYOFF_TYPES];
const CORE_TOOL_ORDER = [
    "skew_get_capabilities",
    "skew_get_signer_info",
    "skew_get_spot",
    "skew_get_iv_smile",
    "skew_get_term_structure",
    "skew_get_volatility_summary",
    "skew_get_fair_value",
    "skew_get_margin_breakdown",
    "skew_estimate_fee",
    "skew_fetch_collateral_policy",
    "skew_fetch_pm_cache",
    "skew_preview_incremental_margin",
    "skew_list_rent_reclaimable",
    "skew_list_options",
    "skew_fetch_portfolio",
    "skew_list_rfq_auctions",
    "skew_list_secondary_listings",
    "skew_fetch_rfq_auction",
    "skew_list_rfq_quotes",
    "skew_fetch_clearing_member",
];
const TRADING_TOOL_ORDER = [
    ...CORE_TOOL_ORDER,
    "skew_get_margin",
    "skew_request_instant_rfq_quotes",
    "skew_request_instant_rfq_from_auction",
    "skew_hit_instant_rfq_quote",
    "skew_hit_instant_rfq_from_auction_quote",
    "skew_serve_instant_rfq_mm_once",
    "skew_create_option",
    "skew_buy_option",
    "skew_create_secondary_listing",
    "skew_buy_secondary_listing",
    "skew_transfer_option",
    "skew_track_held_position",
    "skew_untrack_held_position",
    "skew_rebalance_pm_lock",
    "skew_settle_option",
    "skew_liquidate_option",
    "skew_register_clearing_member",
    "skew_cm_add_collateral",
    "skew_init_volume_tracker",
    "skew_refresh_pm_cache_full",
    "skew_prepare_rent_reclaim_batch",
];
const RFQ_TOOL_ORDER = [
    ...CORE_TOOL_ORDER,
    "skew_request_instant_rfq_quotes",
    "skew_request_instant_rfq_from_auction",
    "skew_hit_instant_rfq_quote",
    "skew_hit_instant_rfq_from_auction_quote",
    "skew_serve_instant_rfq_mm_once",
    "skew_register_rfq_auction",
    "skew_register_rfq_maker",
    "skew_init_volume_tracker",
    "skew_create_secondary_listing",
    "skew_buy_secondary_listing",
    "skew_transfer_option",
    "skew_track_held_position",
    "skew_untrack_held_position",
    "skew_rebalance_pm_lock",
    "skew_liquidate_option",
    "skew_submit_rfq_quote_direct",
    "skew_submit_rfq_quote",
    "skew_refresh_quote",
    "skew_publish_axe",
    "skew_update_axe",
    "skew_revoke_axe",
    "skew_finalize_rfq_auction",
    "skew_cancel_rfq_auction",
];
const CORE_TOOL_NAMES = new Set(CORE_TOOL_ORDER);
const TRADING_TOOL_NAMES = new Set(TRADING_TOOL_ORDER);
const RFQ_TOOL_NAMES = new Set(RFQ_TOOL_ORDER);
const GOVERNANCE_TOOL_ORDER = [
    "skew_get_capabilities",
    "skew_list_series",
    "skew_fetch_series_listing",
    "skew_init_fee_config",
    "skew_init_collateral_policy",
    "skew_register_collateral_policy_entry",
    "skew_delist_series",
    "skew_governance_set_series_max_oi",
];
const GOVERNANCE_TOOL_NAMES = new Set(GOVERNANCE_TOOL_ORDER);
const GOVERNANCE_ONLY_TOOL_NAMES = new Set([
    "skew_init_fee_config",
    "skew_init_collateral_policy",
    "skew_register_collateral_policy_entry",
    "skew_delist_series",
    "skew_governance_set_series_max_oi",
]);
const DISABLED_TOOL_REASONS = {
    skew_apply_early_exercise_action: "On-chain early-exercise automation is disabled until the direct exercise CPI ships. This MCP tool is hidden and stale calls fail closed instead of emitting a state-only event.",
    skew_apply_sell_via_rfq_action: "On-chain sell-via-RFQ automation is disabled until the direct RFQ CPI ships. Use the normal Auction RFQ flow instead.",
    skew_apply_buyback_via_rfq_action: "On-chain buyback-via-RFQ automation is disabled until the direct RFQ CPI ships. Use the normal Auction RFQ flow instead.",
    skew_take_best_quote: "Auction RFQ take_best_quote is hidden at launch because it does not complete option mint/close semantics. Use finalize_rfq_auction for firm tape/refund and Instant RFQ atomic_fill_from_relay for cleared execution.",
};
const DISABLED_TOOL_NAMES = new Set(Object.keys(DISABLED_TOOL_REASONS));
const DEPRECATED_TOOL_NAMES = new Set([...DISABLED_TOOL_NAMES]);
const READ_PREFIX_WRITE_EXCEPTIONS = new Set([
    "skew_get_margin",
    "skew_list_series",
]);
export function getSkewDisabledToolReason(name) {
    return DISABLED_TOOL_REASONS[name] ?? null;
}
export function isSkewReadOnlyTool(name) {
    if (READ_PREFIX_WRITE_EXCEPTIONS.has(name))
        return false;
    return (name.startsWith("skew_get_") ||
        name.startsWith("skew_fetch_") ||
        name.startsWith("skew_list_") ||
        name.startsWith("skew_preview_") ||
        name.startsWith("skew_estimate_"));
}
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
export const SKEW_TOOLS = [
    // ──────────────────────────────────────────────────────────────────────
    // Lifecycle (write tools — require SKEW_PRIVATE_KEY)
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_create_option",
        description: `Create a pre-funded option listing on Skew (Solana devnet). Deposits settlement-mint collateral and mints an option SPL token. Returns the option PDA address. Supported assets: ${UNDERLYING_ENUM.join(", ")}. Payoffs: ${PAYOFF_ENUM.join(", ")}. Expiry must land in an on-chain tenor bucket (1d, 7d, 14d, 28d, 90d) with ±1h tolerance; sub-1d binaries are not enabled in the current deployment. For USDC settlement, notional is USD/USDC. For wSOL/jitoSOL settlement, notional is base-token units (e.g. 0.5 = 0.5 SOL-family token). Use dry_run first when routing a non-USDC mint.`,
        inputSchema: {
            type: "object",
            properties: {
                underlying: {
                    type: "string",
                    enum: UNDERLYING_ENUM,
                    description: "Underlying asset",
                },
                payoff: {
                    type: "string",
                    enum: PAYOFF_ENUM,
                    description: "Option payoff type",
                },
                strike: {
                    type: "number",
                    description: "Strike price in USD (e.g. 80000 for $80k BTC call)",
                },
                expiry: {
                    type: "string",
                    description: "Expiry in ISO 8601 UTC format. Must match a standard on-chain tenor bucket: 1d, 7d, 14d, 28d, or 90d from now, ±1h.",
                },
                notional: {
                    type: "number",
                    description: "Max payoff in settlement units. USDC: USD/USDC amount. wSOL/jitoSOL: base token amount.",
                },
                settlement_mint: {
                    type: "string",
                    description: "Optional: USDC, wSOL, jitoSOL, or a base58 mint registered in CollateralPolicyPda. Defaults to USDC.",
                },
                dry_run: {
                    type: "boolean",
                    description: "If true, simulate create+deposit and return logs/CU without sending.",
                },
                simulate_only: {
                    type: "boolean",
                    description: "Alias for dry_run.",
                },
                simulate: {
                    type: "boolean",
                    description: "Alias for dry_run.",
                },
                upperBound: {
                    type: "number",
                    description: "Required for range_accrual and capped_call/put: upper bound or cap strike in USD",
                },
            },
            required: ["underlying", "payoff", "strike", "expiry", "notional"],
        },
    },
    {
        name: "skew_buy_option",
        description: "Buy an existing option on Skew devnet. Pays premium from buyer's USDC ATA to the creator. For Auction RFQ execution, prefer skew_buy_option_from_rfq_quote so the buyer action is bound to the best firm quote.",
        inputSchema: {
            type: "object",
            properties: {
                option_address: {
                    type: "string",
                    description: "Option PDA address (base58), returned by skew_create_option",
                },
                premium_usd: {
                    type: "number",
                    description: "Premium to pay in USD (e.g. 25.0 for $25 USDC)",
                },
            },
            required: ["option_address", "premium_usd"],
        },
    },
    {
        name: "skew_create_option_from_rfq_quote",
        description: "LEGACY advanced-only pre-funded bridge for USDC Auction RFQs: read the current best firm quote, verify the configured wallet is that best-quote maker, then create and collateralize a full-collateral OptionAccount with the same auction terms. This is not the official Auction PM settlement path and is hidden from trading/rfq profiles. Official cleared issuance must use skew_request_instant_rfq_from_auction -> skew_hit_instant_rfq_from_auction_quote / atomic_fill_from_relay.",
        inputSchema: {
            type: "object",
            properties: {
                auction: {
                    type: "string",
                    description: "Auction RFQ PDA base58.",
                },
                allow_expired_quote: {
                    type: "boolean",
                    description: "Default false. If false, rejects when the best quote's valid_until_slot has passed.",
                },
                require_best_quote_for_maker: {
                    type: "boolean",
                    description: "Default true. If true, the configured MCP wallet must equal auction.best_quote_mm.",
                },
                dry_run: {
                    type: "boolean",
                    description: "If true, simulate create+deposit and return logs/CU without sending transactions.",
                },
            },
            required: ["auction"],
        },
    },
    {
        name: "skew_buy_option_from_rfq_quote",
        description: "LEGACY advanced-only buyer purchase for the quote-bound pre-funded Auction bridge. Refetches the RFQ auction, verifies the configured wallet is the auction buyer, verifies the funded option matches the current best firm quote maker and auction terms, then calls buy_option with the exact best-quote premium. This route is full-collateral/pre-funded and is not PM-guaranteed. Official Auction execution uses skew_request_instant_rfq_from_auction -> skew_hit_instant_rfq_from_auction_quote.",
        inputSchema: {
            type: "object",
            properties: {
                auction: {
                    type: "string",
                    description: "Auction RFQ PDA base58.",
                },
                option_address: {
                    type: "string",
                    description: "Funded OptionAccount PDA returned by skew_create_option_from_rfq_quote.",
                },
                allow_expired_quote: {
                    type: "boolean",
                    description: "Default false. If false, rejects when the best quote's valid_until_slot has passed.",
                },
            },
            required: ["auction", "option_address"],
        },
    },
    {
        name: "skew_request_instant_rfq_quotes",
        description: "Buyer-side Instant RFQ quote request. Broadcasts a relay-backed RFQ using the configured wallet as buyer and returns relay_nonce plus live CM/MM quote acknowledgements. This is the PM/CM atomic-fill lane; use skew_hit_instant_rfq_quote to execute one returned quote.",
        inputSchema: {
            type: "object",
            properties: {
                underlying: {
                    type: "string",
                    enum: UNDERLYING_ENUM,
                    description: "Underlying asset.",
                },
                payoff: {
                    type: "string",
                    enum: PAYOFF_ENUM,
                    description: "Payoff type. Linear USDC Instant RFQs use non-inverse payoffs; SOL-family physical rails use inverse payoffs.",
                },
                strike: {
                    type: "number",
                    description: "Strike price in USD.",
                },
                expiry: {
                    type: "string",
                    description: "Expiry in ISO 8601 UTC format. Must satisfy the deployed tenor bucket policy.",
                },
                notional: {
                    type: "number",
                    description: "USDC lane payoff/notional in USD. For physical inverse lanes this is settlement base-unit amount.",
                },
                max_premium_usd: {
                    type: "number",
                    description: "Optional buyer premium cap in USD for tape/readback display. The selected quote still passes as premium_usd or premium_micro to skew_hit_instant_rfq_quote.",
                },
                upper_bound_usd: {
                    type: "number",
                    description: "Required for range_accrual; cap strike for capped_* when applicable.",
                },
                settlement_mint: {
                    type: "string",
                    description: "USDC, wSOL, jitoSOL, or a mint pubkey. Defaults to USDC.",
                },
                timeout_ms: {
                    type: "integer",
                    minimum: 500,
                    maximum: 600000,
                    description: "How long to collect quote_ack messages before returning. Defaults to 60000; max 10 minutes for demo desks and human approval flows.",
                },
                max_quotes: {
                    type: "integer",
                    minimum: 1,
                    maximum: 25,
                    description: "Return early after this many quotes.",
                },
                required_cm_pubkey: {
                    type: "string",
                    description: "Optional maker/CM pubkey filter. When set, only quote_ack messages from this CM are returned and the hit template is pinned to that CM.",
                },
                relay_url: {
                    type: "string",
                    description: "Optional relay WebSocket URL. Defaults to the Skew devnet relay.",
                },
            },
            required: ["underlying", "payoff", "strike", "expiry", "notional"],
        },
    },
    {
        name: "skew_request_instant_rfq_from_auction",
        description: "Buyer-side PM-backed execution bridge for an Auction RFQ. Refetches the Auction RFQ PDA, derives the exact Instant RFQ terms, broadcasts them to the relay, and returns live quote_ack responses plus a hit template. This does not use the pre-funded 100% collateral bridge; final issuance happens only through skew_hit_instant_rfq_from_auction_quote / atomic_fill_from_relay.",
        inputSchema: {
            type: "object",
            properties: {
                auction: {
                    type: "string",
                    description: "Auction RFQ PDA base58. The configured MCP wallet must be this auction's buyer.",
                },
                max_premium_micro: {
                    type: "string",
                    description: "Optional override for Instant RFQ premium cap in USDC micro-units. Defaults to the auction best quote premium when present, otherwise auction max premium.",
                },
                settlement_mint: {
                    type: "string",
                    description: "Optional settlement mint override. Defaults to USDC for non-inverse Auction RFQs.",
                },
                timeout_ms: {
                    type: "integer",
                    minimum: 500,
                    maximum: 600000,
                    description: "How long to collect quote_ack messages before returning. Defaults to 60000; max 10 minutes for demo desks and human approval flows.",
                },
                max_quotes: {
                    type: "integer",
                    minimum: 1,
                    maximum: 25,
                    description: "Return early after this many quotes.",
                },
                required_cm_pubkey: {
                    type: "string",
                    description: "Optional maker/CM pubkey filter. When set, only quote_ack messages from this CM are returned and the hit template is pinned to that CM.",
                },
                relay_url: {
                    type: "string",
                    description: "Optional relay WebSocket URL. Defaults to the Skew devnet relay.",
                },
            },
            required: ["auction"],
        },
    },
    {
        name: "skew_hit_instant_rfq_quote",
        description: "Execute a selected Instant RFQ quote through atomic_fill_from_relay. The configured buyer wallet signs only the relay-prepared Solana transaction. Provide premium_micro or premium_usd; premium_micro is preferred when copied from quote_ack. Returns tx, option PDA, PM risk preflight, option readback, and buyer/maker portfolio counts.",
        inputSchema: {
            type: "object",
            properties: {
                relay_nonce: {
                    type: "string",
                    description: "relay_nonce returned by skew_request_instant_rfq_quotes.",
                },
                cm_pubkey: {
                    type: "string",
                    description: "CM/MM authority pubkey from a quote_ack.",
                },
                premium_micro: {
                    type: "string",
                    description: "Selected premium in USDC micro-units, usually copied from the quote_ack. Required unless premium_usd is supplied.",
                },
                premium_usd: {
                    type: "number",
                    description: "Alternative selected premium in USD. Required only when premium_micro is omitted.",
                },
                underlying: {
                    type: "string",
                    enum: UNDERLYING_ENUM,
                    description: "Underlying asset. Must match the quote request.",
                },
                payoff: {
                    type: "string",
                    enum: PAYOFF_ENUM,
                    description: "Payoff type. Must match the quote request.",
                },
                strike: {
                    type: "number",
                    description: "Strike price in USD. Must match the quote request.",
                },
                expiry: {
                    type: "string",
                    description: "Expiry ISO string. Must match the quote request.",
                },
                notional: {
                    type: "number",
                    description: "Payoff/notional amount. Must match the quote request.",
                },
                upper_bound_usd: {
                    type: "number",
                    description: "Range upper bound or capped strike when applicable. Must match the quote request.",
                },
                settlement_mint: {
                    type: "string",
                    description: "USDC, wSOL, jitoSOL, or a mint pubkey. Defaults to USDC.",
                },
                quote_expiry_seconds: {
                    type: "integer",
                    minimum: 10,
                    maximum: 600,
                    description: "Digest validity horizon from now. Defaults to 600 seconds for MCP-operated fills.",
                },
                timeout_ms: {
                    type: "integer",
                    minimum: 5000,
                    maximum: 600000,
                    description: "How long to wait for buyer_tx_request/fill_executed. Defaults to 120000; max 10 minutes.",
                },
                relay_url: {
                    type: "string",
                    description: "Optional relay WebSocket URL. Defaults to the Skew devnet relay.",
                },
            },
            required: ["relay_nonce", "cm_pubkey", "underlying", "payoff", "strike", "expiry", "notional"],
        },
    },
    {
        name: "skew_hit_instant_rfq_from_auction_quote",
        description: "Execute a selected quote from skew_request_instant_rfq_from_auction through atomic_fill_from_relay. Provide premium_micro or premium_usd; premium_micro is preferred when copied from quote_ack. Refetches the Auction RFQ PDA, derives the same Instant terms, then returns tx, option PDA, PM lock delta, buyer-long readback, maker-short readback, and CM registry/margin proof.",
        inputSchema: {
            type: "object",
            properties: {
                auction: {
                    type: "string",
                    description: "Auction RFQ PDA base58. The configured MCP wallet must be this auction's buyer.",
                },
                relay_nonce: {
                    type: "string",
                    description: "relay_nonce returned by skew_request_instant_rfq_from_auction.",
                },
                cm_pubkey: {
                    type: "string",
                    description: "CM/MM authority pubkey from a quote_ack.",
                },
                premium_micro: {
                    type: "string",
                    description: "Selected premium in USDC micro-units, usually copied from the quote_ack. Required unless premium_usd is supplied.",
                },
                premium_usd: {
                    type: "number",
                    description: "Alternative selected premium in USD. Required only when premium_micro is omitted.",
                },
                max_premium_micro: {
                    type: "string",
                    description: "Optional premium-cap override used only to rebuild/display the derived Instant RFQ request.",
                },
                settlement_mint: {
                    type: "string",
                    description: "Optional settlement mint override. Defaults to USDC for non-inverse Auction RFQs.",
                },
                quote_expiry_seconds: {
                    type: "integer",
                    minimum: 10,
                    maximum: 600,
                    description: "Digest validity horizon from now. Defaults to 600 seconds.",
                },
                timeout_ms: {
                    type: "integer",
                    minimum: 5000,
                    maximum: 600000,
                    description: "How long to wait for buyer_tx_request/fill_executed. Defaults to 120000; max 10 minutes.",
                },
                relay_url: {
                    type: "string",
                    description: "Optional relay WebSocket URL. Defaults to the Skew devnet relay.",
                },
            },
            required: ["auction", "relay_nonce", "cm_pubkey"],
        },
    },
    {
        name: "skew_serve_instant_rfq_mm_once",
        description: "Maker/MM one-shot Instant RFQ signer. Provide premium_micro or premium_usd; premium_micro is preferred for exact USDC micro-units. Prepares CM, volume tracker, and RFQ maker registry if requested, then listens on the relay, quotes the next matching request, signs fill_consent, and returns the final fill/margin receipt. Use in a separate terminal while a buyer requests and hits an Instant RFQ.",
        inputSchema: {
            type: "object",
            properties: {
                premium_micro: {
                    type: "string",
                    description: "Fixed quote premium in USDC micro-units. Required unless premium_usd is supplied. Use a small value for devnet demos.",
                },
                premium_usd: {
                    type: "number",
                    description: "Alternative fixed quote premium in USD. Required only when premium_micro is omitted.",
                },
                quote_ttl_seconds: {
                    type: "integer",
                    minimum: 5,
                    maximum: 600,
                    description: "TTL included in quote_ack. Defaults to 600 for demo-safe quote review.",
                },
                timeout_ms: {
                    type: "integer",
                    minimum: 5000,
                    maximum: 600000,
                    description: "How long to wait for quote request and fill completion. Defaults to 600000.",
                },
                auto_prepare: {
                    type: "boolean",
                    description: "Default true. Registers CM, volume tracker, and RFQ maker registry if missing/idempotent.",
                },
                initial_collateral_usdc: {
                    type: "number",
                    description: "If CM is missing and auto_prepare is true, register with this initial USDC collateral. Defaults to 1000.",
                },
                filter_underlying: {
                    type: "string",
                    enum: UNDERLYING_ENUM,
                    description: "Optional quote_request asset filter.",
                },
                filter_payoff: {
                    type: "string",
                    enum: PAYOFF_ENUM,
                    description: "Optional quote_request payoff filter.",
                },
                relay_url: {
                    type: "string",
                    description: "Optional relay WebSocket URL. Defaults to the Skew devnet relay.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_fetch_collateral_policy",
        description: "Read the live CollateralPolicyPda mint allowlist for this deployment. Capabilities show protocol support; this tool shows which USDC/wSOL/jitoSOL/custom mints are actually registered now, so agents can preflight before sending write transactions.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "skew_fetch_pm_cache",
        description: "Read a CM's on-chain PM cache sidecar and return whether cached margin / cached fill can be used. Reports dirty/stale/registry mismatch blockers explicitly. Read-only.",
        inputSchema: {
            type: "object",
            properties: {
                cm_authority: {
                    type: "string",
                    description: "CM authority wallet. Defaults to the configured MCP write wallet if omitted.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_preview_incremental_margin",
        description: "Preview the PM cache envelope for a candidate fill. This is read-only and not an execution guarantee; exact post-fill IM is still produced by relay/SDK transaction preflight.",
        inputSchema: {
            type: "object",
            properties: {
                cm_authority: {
                    type: "string",
                    description: "CM authority wallet. Defaults to the configured MCP write wallet if omitted.",
                },
                estimated_post_im_micro: {
                    type: "string",
                    description: "Optional post-fill IM estimate in USDC micro-units. If omitted, the tool returns cache status only.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_list_rent_reclaimable",
        description: "List owner-first rent reclaim candidates for a wallet. Returns close blockers instead of pretending unsafe accounts can be closed. Read-only.",
        inputSchema: {
            type: "object",
            properties: {
                authority: {
                    type: "string",
                    description: "Wallet whose reclaim queue should be scanned. Defaults to the configured MCP write wallet if omitted.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_settle_option",
        description: "Settle an expired option on Skew devnet. Reads the Pyth price, pays ITM payoff to holder, returns residual to creator. Permissionless — anyone can call.",
        inputSchema: {
            type: "object",
            properties: {
                option_address: {
                    type: "string",
                    description: "Option PDA address (base58) to settle",
                },
            },
            required: ["option_address"],
        },
    },
    {
        name: "skew_liquidate_option",
        description: "Attempt Dutch-auction liquidation against a PM-issued option for a defaulting Clearing Member. Permissionless, but guarded: the liquidator must differ from the defaulting CM and healthy CMs are rejected by the on-chain liquidation trigger.",
        inputSchema: {
            type: "object",
            properties: {
                option_address: {
                    type: "string",
                    description: "PM-issued option PDA address (base58) to liquidate.",
                },
                defaulting_cm_authority: {
                    type: "string",
                    description: "Authority pubkey of the writer/defaulting Clearing Member.",
                },
                close_factor_bps: {
                    type: "integer",
                    minimum: 1,
                    maximum: 5000,
                    description: "Liquidation close factor in bps. Defaults to 5000 (50%).",
                },
                min_expected_bonus_bps: {
                    type: "integer",
                    minimum: 0,
                    maximum: 10000,
                    description: "Optional Dutch bonus floor. Defaults to 0 for keeper smoke checks.",
                },
            },
            required: ["option_address", "defaulting_cm_authority"],
        },
    },
    {
        name: "skew_get_margin",
        description: "Recompute initial margin (IM) for the caller's Clearing Member account and return the breakdown. Reads on-chain volatility-state PDAs for the 5 launch assets so tail-risk add-on is included. Returns total collateral, locked IM, free collateral, and the on-chain tx signature. Requires SKEW_PRIVATE_KEY (caller must already be a registered CM). Use this before skew_create_option to check whether the wallet has free collateral, or after a price move to refresh the IM.",
        inputSchema: {
            type: "object",
            properties: {
                current_spot_usd: {
                    type: "number",
                    description: "Current spot USD used as the stress-sim anchor. Optional — defaults to live BTC spot from Pyth Hermes.",
                },
            },
        },
    },
    {
        name: "skew_refresh_pm_cache_full",
        description: "Run the full PM walk and refresh the CM risk-cache sidecar. Requires a configured write keypair and the CM's registry-tracked option accounts.",
        inputSchema: {
            type: "object",
            properties: {
                current_spot_usd: {
                    type: "number",
                    description: "Optional stress anchor. Defaults to 0; PM model uses account/oracle inputs.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_prepare_rent_reclaim_batch",
        description: "Prepare an unsigned owner-first rent reclaim batch for wallet signing. The MCP server does not close accounts server-side.",
        inputSchema: {
            type: "object",
            properties: {
                authority: {
                    type: "string",
                    description: "Wallet whose reclaimable accounts should be prepared. Defaults to the configured MCP write wallet if omitted.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_init_fee_accumulator",
        description: "Initialize the per-mint protocol fee accumulator PDA for USDC, wSOL, or jitoSOL. This is permissionless but requires the mint to be registered in CollateralPolicyPda. Use before physical Instant RFQ fills if the relay has not auto-prepared it.",
        inputSchema: {
            type: "object",
            properties: {
                settlement_mint: {
                    type: "string",
                    description: "Settlement/collateral mint base58. Defaults to SKEW_DEVNET_USDC_MINT when omitted.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_close_option_collateral_lock",
        description: "Close a released OptionCollateralLockPda sidecar after an option has settled/admin-settled. This reclaims rent to the writer and is safe to run as a permissionless cleanup crank.",
        inputSchema: {
            type: "object",
            properties: {
                option_address: {
                    type: "string",
                    description: "Option PDA address whose collateral-lock sidecar should be closed.",
                },
            },
            required: ["option_address"],
        },
    },
    // ──────────────────────────────────────────────────────────────────────
    // Read tools (no wallet required)
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_get_capabilities",
        description: "Return Skew's supported assets, 11 payoff names, collateral rails, trade lanes, profile counts, and MCP agentGuide. Call this immediately after skew_get_signer_info so the agent chooses Instant RFQ vs Auction RFQ vs secondary vs pre-funded issuance correctly.",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },
    },
    {
        name: "skew_get_signer_info",
        description: "First tool before any write workflow. Returns the active MCP signer posture: local keypair path/private-key mode, hosted unsigned mode, active profile, visible tool count, and the signer public key when a local write key is configured. Use it to prove which wallet will pay fees and sign transactions; if write_tools_enabled=false, do read-only analysis instead of pretending to trade.",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },
    },
    {
        name: "skew_get_fair_value",
        description: "Get a suggested fair-value premium for an option from the Skew pricing service. Returns price in USD plus delta, gamma, vega, theta, rho. Advisory only — the on-chain program does not read this number.",
        inputSchema: {
            type: "object",
            properties: {
                underlying: {
                    type: "string",
                    enum: UNDERLYING_ENUM,
                    description: "Underlying asset",
                },
                payoff: {
                    type: "string",
                    enum: PAYOFF_ENUM,
                },
                strike: {
                    type: "number",
                    description: "Strike price in USD",
                },
                expiry: {
                    type: "string",
                    description: "Expiry in ISO 8601 UTC format",
                },
                notional: {
                    type: "number",
                    description: "Notional in USD",
                },
                upperBound: {
                    type: "number",
                    description: "For range_accrual / capped: upper bound in USD",
                },
            },
            required: ["underlying", "payoff", "strike", "expiry", "notional"],
        },
    },
    {
        name: "skew_get_spot",
        description: "Get the current spot price for a supported asset from Pyth Network (Hermes REST). Returns USD price and confidence interval.",
        inputSchema: {
            type: "object",
            properties: {
                underlying: {
                    type: "string",
                    enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
                    description: "Asset to query",
                },
            },
            required: ["underlying"],
        },
    },
    {
        name: "skew_list_options",
        description: "List options on Skew devnet, decoded from on-chain `OptionAccount` PDAs. Returns each option's pda, creator, holder, type, state, underlying, direction, strike (USD), upper bound (USD), expiry (unix + ISO), payoff (USD), locked collateral (USD), V0 stamp (USD), σ at creation, and spot at creation. Filters and sort run client-side after the discriminator-filtered scan.",
        inputSchema: {
            type: "object",
            properties: {
                limit: {
                    type: "number",
                    description: "Max number of options to return (default 10, max 50).",
                },
                filter_option_pda: {
                    type: "string",
                    description: "Fetch a single option PDA directly. Use this for receipt/readback after a known tx instead of scanning the whole market.",
                },
                holder: {
                    type: "string",
                    description: "Filter by current option holder wallet pubkey.",
                },
                creator: {
                    type: "string",
                    description: "Filter by option creator / writer wallet pubkey.",
                },
                underlying: {
                    type: "string",
                    enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
                    description: "Filter by underlying asset (optional).",
                },
                option_type: {
                    type: "string",
                    enum: [
                        "Vanilla",
                        "Digital",
                        "CappedVanilla",
                        "RangeAccrual",
                        "VanillaInverse",
                        "DigitalInverse",
                    ],
                    description: "Filter by anchor `OptionType` storage variant (optional). User-facing payoff names such as `vanilla_call` and `digital_inverse_put` map onto these storage types plus direction.",
                },
                state: {
                    type: "string",
                    enum: [
                        "Created",
                        "Funded",
                        "Active",
                        "Expired",
                        "Settled",
                        "Disputed",
                        "ExpiredAbandoned",
                    ],
                    description: "Filter by lifecycle state (optional). `Active` = collateralised + bought. `Funded` = collateralised but no buyer yet. `Created` = just minted, no collateral locked.",
                },
                sort_by: {
                    type: "string",
                    enum: ["createdAt", "expiry"],
                    description: "Sort order. Default `createdAt` (newest first). `expiry` returns latest expiry first.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_fetch_portfolio",
        description: "Read a wallet's live Skew portfolio directly from on-chain OptionAccount PDAs. Long side = current holder; short side = creator/writer. Also includes Clearing Member state when registered. Use this after create/buy/transfer to prove the option is visible, not just minted.",
        inputSchema: {
            type: "object",
            properties: {
                owner: {
                    type: "string",
                    description: "Wallet pubkey base58. Defaults to configured MCP write wallet. Required when the MCP server is running read-only without a write keypair.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_list_rfq_auctions",
        description: "List live Auction RFQs from the same public RFQ tape used by the terminal. This discovers auction PDAs before you know their address by merging the indexer view with a bounded on-chain snapshot. Use this before `skew_fetch_rfq_auction`, quote submission, or finalize workflows.",
        inputSchema: {
            type: "object",
            properties: {
                limit: {
                    type: "number",
                    description: "Max number of RFQs to return (default 25, max 100).",
                },
                buyer: {
                    type: "string",
                    description: "Filter by buyer wallet pubkey (optional).",
                },
                underlying: {
                    type: "string",
                    enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
                    description: "Filter by underlying asset (optional).",
                },
                with_quote: {
                    type: "boolean",
                    description: "Only return RFQs with a currently live best quote.",
                },
                source: {
                    type: "string",
                    enum: ["indexer", "onchain"],
                    description: "Optional source override. Omit for terminal-equivalent indexer plus on-chain snapshot.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_list_secondary_listings",
        description: "List the public secondary tape from the same listing endpoint used by the terminal. This is discovery/readback only, not an escrowed orderbook. Payment uses skew_buy_secondary_listing and delivery is complete only after seller-side skew_transfer_option returns readback_ok=true.",
        inputSchema: {
            type: "object",
            properties: {
                limit: {
                    type: "number",
                    description: "Max number of listings to return (default 25, max 100).",
                },
                underlying: {
                    type: "string",
                    enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
                    description: "Filter by underlying asset (optional).",
                },
                active: {
                    type: "boolean",
                    description: "Return active listings only. Defaults to true.",
                },
                pending: {
                    type: "boolean",
                    description: "Return listings that are still pending off-chain settlement/indexer confirmation.",
                },
                seller: {
                    type: "string",
                    description: "Filter by listing seller wallet pubkey.",
                },
                option_pda: {
                    type: "string",
                    description: "Filter listings for one option PDA.",
                },
                min_qty: {
                    type: "number",
                    description: "Minimum token amount filter.",
                },
                max_ask_usdc: {
                    type: "number",
                    description: "Maximum ask price in USDC.",
                },
                exclude_me: {
                    type: "string",
                    description: "Exclude listings posted by this seller wallet pubkey.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_create_secondary_listing",
        description: "Post a seller-signed secondary-market discovery row for an option the configured MCP wallet currently holds. This does not escrow or lock the option. Actual delivery is explicit seller-side skew_transfer_option after a buyer pays or accepts terms.",
        inputSchema: {
            type: "object",
            properties: {
                option_address: {
                    type: "string",
                    description: "OptionAccount PDA to offer on the secondary tape.",
                },
                option_token_mint: {
                    type: "string",
                    description: "Option SPL mint. Optional; SDK derives it from option_address when omitted.",
                },
                ask_price_usdc: {
                    type: "number",
                    description: "Total ask in USDC for the offered token amount.",
                },
                token_amount: {
                    type: "number",
                    description: "Option token amount offered. Defaults to 1.",
                },
                duration_hours: {
                    type: "number",
                    description: "Listing time-to-live in hours. Defaults to 24, max 720.",
                },
                seller_handle: {
                    type: "string",
                    description: "Optional public label for the seller.",
                },
            },
            required: ["option_address", "ask_price_usdc"],
        },
    },
    {
        name: "skew_buy_secondary_listing",
        description: "Pay a secondary listing seller in devnet USDC and record a buyer-signed buy intent on the public tape. The SDK refetches the listing and option before payment, verifies the seller is still the current holder, and uses seller/option/ask args only as optional guards. This is not escrow/orderbook settlement: delivery is complete only after the seller calls skew_transfer_option and that tool returns readback_ok=true.",
        inputSchema: {
            type: "object",
            properties: {
                listing_id: {
                    type: "string",
                    description: "Secondary listing row id.",
                },
                option_address: {
                    type: "string",
                    description: "Optional OptionAccount PDA guard from the listing.",
                },
                seller: {
                    type: "string",
                    description: "Optional seller wallet pubkey guard from the listing.",
                },
                ask_price_usdc: {
                    type: "number",
                    description: "Optional total USDC ask guard from the listing.",
                },
            },
            required: ["listing_id"],
        },
    },
    // ──────────────────────────────────────────────────────────────────────
    // Volatility tools (v0.2.0 — read-only, advisory)
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_get_iv_smile",
        description: "Get the implied-volatility smile for one expiry — IV across a strike ladder, plus 25-delta risk reversal and butterfly. Useful for spotting skew (puts vs calls relative pricing) before you write or buy.",
        inputSchema: {
            type: "object",
            properties: {
                underlying: {
                    type: "string",
                    enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
                    description: "Asset to query",
                },
                expiry_days: {
                    type: "number",
                    description: "Days to expiry (e.g. 7, 14, 30)",
                },
            },
            required: ["underlying", "expiry_days"],
        },
    },
    {
        name: "skew_get_term_structure",
        description: "Get ATM implied volatility across a standard expiry ladder (7d, 14d, 30d, 60d, 90d, 180d). The shape tells you whether the market expects near-term or far-term volatility — flat = stable, downward-sloping = backwardation = market expects calmer future, upward-sloping = contango.",
        inputSchema: {
            type: "object",
            properties: {
                underlying: {
                    type: "string",
                    enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
                    description: "Asset to query",
                },
            },
            required: ["underlying"],
        },
    },
    {
        name: "skew_get_volatility_summary",
        description: "Get a one-shot volatility view for an asset — current spot, ATM 30-day IV, smile skew (put vs call), term-structure shape, and a generic vol-view label (stable / elevated / compressing). Designed to answer questions like 'how do you see BTC vol next week?' in a single call.",
        inputSchema: {
            type: "object",
            properties: {
                underlying: {
                    type: "string",
                    enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
                    description: "Asset to query",
                },
            },
            required: ["underlying"],
        },
    },
    {
        name: "skew_get_vol_short",
        description: "Compute short-term realized volatility (annualized) from a series of close prices. Use when you have recent bar data and want a fast vol point estimate. Pass-through to the pricing service; you supply the closes.",
        inputSchema: {
            type: "object",
            properties: {
                closes: {
                    type: "array",
                    items: { type: "number" },
                    description: "Series of close prices, oldest → newest. Daily bars typical; works with any uniform interval.",
                },
                lambda: {
                    type: "number",
                    description: "Decay parameter ∈ (0, 1). Optional, default 0.94 (industry-standard short-term decay).",
                },
                max_bars: {
                    type: "number",
                    description: "Cap on the number of trailing bars used. Optional, default 120.",
                },
            },
            required: ["closes"],
        },
    },
    {
        name: "skew_get_vol_long",
        description: "Compute long-run realized volatility with adaptive window selection (180 / 365 / 720 days) from daily OHLC bars. Use as the mean-reversion anchor for short-term vol forecasts.",
        inputSchema: {
            type: "object",
            properties: {
                bars: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            open: { type: "number" },
                            high: { type: "number" },
                            low: { type: "number" },
                            close: { type: "number" },
                        },
                        required: ["open", "high", "low", "close"],
                    },
                    description: "Daily OHLC bars, oldest → newest. Pipeline picks 180 / 365 / 720d window adaptively from the supplied history.",
                },
            },
            required: ["bars"],
        },
    },
    {
        name: "skew_get_vol_implied",
        description: "Compute model-implied integrated variance and IV for a tenor, given short-term and long-run vol estimates. Closed-form, mean-reverting (uses the pricing service's default mean-reversion rate, halflife ~9.6 days). Output IV is annualized.",
        inputSchema: {
            type: "object",
            properties: {
                sigma_short: {
                    type: "number",
                    description: "Short-term annualized vol (e.g. from skew_get_vol_short).",
                },
                sigma_long: {
                    type: "number",
                    description: "Long-run annualized vol (e.g. from skew_get_vol_long).",
                },
                t_days: {
                    type: "number",
                    description: "Tenor in days.",
                },
            },
            required: ["sigma_short", "sigma_long", "t_days"],
        },
    },
    {
        name: "skew_get_vol_premium",
        description: "1-step forecast of the relative IV-vs-realized vol premium from a history series. Output is clipped to a sensible band [-0.20, 0.30]. Returns cold-start prior if the history is too short to fit.",
        inputSchema: {
            type: "object",
            properties: {
                premium_history: {
                    type: "array",
                    items: { type: "number" },
                    description: "Series of past relative premia (theta_iv / theta_realized − 1), oldest → newest. Needs at least 30 entries for a real fit; below that returns the cold-start prior +0.05.",
                },
                fit_window: {
                    type: "number",
                    description: "Trailing window length. Optional, default 90.",
                },
            },
            required: ["premium_history"],
        },
    },
    {
        name: "skew_get_margin_breakdown",
        description: "Compute the off-chain clearing-class portfolio-margin breakdown for a candidate options portfolio via the skew-pricing /margin_breakdown endpoint. Launch PM policy (2026-05-08): conservative ConvexHullIM/floor stack, calendar credit disabled, non-vanilla Greek credit audit-gated, and ICC credit applied once under a capped policy. Pass `tier` as the compatibility value: standard=M0 Segregated, silver=M1 Portfolio, gold=M2 Cross-Asset, platinum=M3 Clearing Prime. The response returns a full class ladder for transparency. Advisory-only — the on-chain calculate_margin handler remains the final risk check.",
        inputSchema: {
            type: "object",
            properties: {
                legs: {
                    type: "array",
                    description: "Vanilla call/put legs. Each entry: { asset (BTC|ETH|SOL|XRP|HYPE), kind (VanillaCall|VanillaPut), strike, spot, t_years, iv, r (optional, default 0), side (Long|Short), qty }.",
                    items: {
                        type: "object",
                        properties: {
                            asset: {
                                type: "string",
                                enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
                            },
                            kind: {
                                type: "string",
                                enum: ["VanillaCall", "VanillaPut"],
                            },
                            strike: { type: "number" },
                            spot: { type: "number" },
                            t_years: { type: "number" },
                            iv: { type: "number" },
                            r: { type: "number" },
                            side: { type: "string", enum: ["Long", "Short"] },
                            qty: { type: "number" },
                        },
                        required: ["asset", "kind", "strike", "spot", "t_years", "iv", "side", "qty"],
                    },
                },
                regime: {
                    type: "string",
                    enum: ["Calm", "Stress"],
                    description: "Regime to drive the per-asset shock and ICC rho matrix. Default Calm. M3 returns both calm and stress IMs side-by-side; lower classes omit regime fields.",
                },
                tier: {
                    type: "string",
                    enum: ["standard", "silver", "gold", "platinum"],
                    description: "Clearing-class compatibility value. Default `platinum` maps to M3 Clearing Prime. Lockup schedule: M0 $0, M1 $500K, M2 $2M, M3 $10M (30-day lockup). The full ladder under all 4 classes is returned in `tier_ladder_im_usd` for backward-compatible clients.",
                },
            },
            required: ["legs"],
        },
    },
    // ──────────────────────────────────────────────────────────────────────
    // Phase 1639 — clearing-class ladder + RFQ auction + conditional orders +
    //              read snapshots. Closes the MCP coverage gap identified in
    //              CHANGE_PLAN.md §4. Lets LLM agents drive Iron Condor
    //              workflows, SL/TP/OCO, and read on-chain state directly.
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_upgrade_tier",
        description: "Step the Clearing Member up to a higher clearing class. Locks the class-specific USDC floor for 30 days (TIER_LOCKUP_MIN_SECONDS). Strict rank increase only. Compatibility ladder: 0=M0 Segregated ($0), 1=M1 Portfolio ($500K), 2=M2 Cross-Asset ($2M), 3=M3 Clearing Prime ($10M). Launch policy: conservative PM floors, calendar credit disabled, and unaudited non-vanilla Greek credit disabled.",
        inputSchema: {
            type: "object",
            properties: {
                target_rank: {
                    type: "integer",
                    enum: [0, 1, 2, 3],
                    description: "Target clearing-class compatibility rank.",
                },
            },
            required: ["target_rank"],
        },
    },
    {
        name: "skew_downgrade_tier",
        description: "Step the CM down to a lower clearing class. Releases class-specific USDC lockup back to free_collateral. Requires now >= tier_locked_until (30 days after most recent upgrade). Strict rank decrease only.",
        inputSchema: {
            type: "object",
            properties: {
                target_rank: {
                    type: "integer",
                    enum: [0, 1, 2, 3],
                    description: "Target clearing-class compatibility rank (must be strictly less than current).",
                },
            },
            required: ["target_rank"],
        },
    },
    {
        name: "skew_register_rfq_auction",
        description: "Open the Auction RFQ lane for an option spec. Current RFQ v1 escrow is USDC/stable-only; buyer commits max_premium_micro and sets a 30..1200 slot competition window. Multi-MM compete via submit_rfq_quote/direct; anyone can call finalize_rfq_auction after close_slot to publish the firm quote tape and refund escrow. Important: finalize_rfq_auction is not an option mint. PM/CM-backed minting routes through Instant RFQ atomic fill (buyer_accept + cm_sign + buyer_tx_signed over RelayPayload → atomic_fill_from_relay), or the guarded pre-funded bridge tools when intentionally using fully collateralized legacy issuance. Expiry must match the standard on-chain tenor ladder (1d, 7d, 14d, 28d, 90d) within ±1h. Phase 2 (2026-05-04) appends Inverse payoff types (asset_mask must be enabled per asset). Returns the auction PDA.",
        inputSchema: {
            type: "object",
            properties: {
                auction_id: {
                    type: "string",
                    description: "Globally-unique auction id (caller-supplied bigint as string).",
                },
                underlying: { type: "string", enum: UNDERLYING_ENUM },
                payoff: {
                    type: "string",
                    enum: PAYOFF_ENUM,
                },
                settlement_mint: {
                    type: "string",
                    enum: ["USDC"],
                    description: "RFQ v1 premium + payoff currency. Current on-chain register_rfq_auction requires the stable/USDC policy entry.",
                    default: "USDC",
                },
                strike: { type: "number", description: "Strike price USD." },
                expiry: {
                    type: "string",
                    description: "Expiry ISO 8601 UTC. Must match 1d, 7d, 14d, 28d, or 90d tenor from now, ±1h.",
                },
                notional: { type: "number", description: "Payoff cap (M) in settlement_mint units." },
                max_premium_usd: {
                    type: "number",
                    description: "Buyer's reserve — auction's hard ceiling, in settlement_mint units.",
                },
                upper_bound_usd: {
                    type: "number",
                    description: "Upper bound for RangeAccrual. 0 for other types.",
                    default: 0,
                },
                duration_slots: {
                    type: "integer",
                    minimum: 30,
                    maximum: 1200,
                    description: "Slot window. ~0.4s/slot. 30..1200 enforced on-chain.",
                },
            },
            required: [
                "auction_id",
                "underlying",
                "payoff",
                "strike",
                "expiry",
                "notional",
                "max_premium_usd",
                "duration_slots",
            ],
        },
    },
    {
        name: "skew_register_conditional_order",
        description: "Register an executable stop-loss / take-profit conditional order gated on Pyth EMA. MCP intentionally exposes only action=CloseIsolatedPosition because it is the only conditional action that performs a real on-chain CPI today. SellViaRfq, EarlyExercise, and BuybackViaRfq remain SDK-level fail-closed intent/state paths until direct CPI ships.",
        inputSchema: {
            type: "object",
            properties: {
                order_id: { type: "string", description: "Globally-unique order id (bigint as string)." },
                kind: {
                    type: "string",
                    enum: ["StopLoss", "TakeProfit", "Trailing"],
                    description: "Conditional order kind.",
                },
                trigger_mode: {
                    type: "string",
                    enum: ["LastTrade", "PythEmaSpot"],
                    description: "Default PythEmaSpot — most robust against MEV.",
                },
                trigger_direction: {
                    type: "string",
                    enum: ["Above", "Below"],
                    description: "Maps to on-chain direction code: Below=0, Above=1.",
                },
                action: {
                    type: "string",
                    enum: ["CloseIsolatedPosition"],
                    description: "Only executable MCP action. Other conditional action types are SDK-only fail-closed intents.",
                },
                underlying: {
                    type: "string",
                    enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
                    description: "Underlying asset for the conditional order.",
                },
                trigger_price_usd: { type: "number", description: "Pyth scale auto-converted to 1e8." },
                action_target: {
                    type: "string",
                    description: "Pubkey base58 — option PDA the action operates on.",
                },
                valid_until_ts: {
                    type: "string",
                    description: "Unix seconds (bigint as string) — anti-stale guard.",
                },
                grace_slots: {
                    type: "integer",
                    description: "Anti-flicker grace period. Default 30 slots ≈ 12s.",
                    default: 30,
                },
                max_slippage_bps: {
                    type: "integer",
                    description: "Action premium slippage cap.",
                    default: 200,
                },
            },
            required: [
                "order_id",
                "kind",
                "trigger_direction",
                "action",
                "underlying",
                "trigger_price_usd",
                "action_target",
                "valid_until_ts",
            ],
        },
    },
    {
        name: "skew_cancel_conditional_order",
        description: "Authority cancels an Active conditional order. Drains rent + keeper-reward lamports back to authority. If part of an OCO pair, the linked partner is NOT auto-cancelled here.",
        inputSchema: {
            type: "object",
            properties: { order_id: { type: "string", description: "Order id." } },
            required: ["order_id"],
        },
    },
    {
        name: "skew_fetch_povs",
        description: "Read the on-chain Path-of-Volatility-Surface state for an asset. Full state vector: σ_t (fast-window σ), σ_∞ (long-window σ), θ_d (28d integrated variance), vrp_rel (variance-risk-premium 1-step), iv_atm_28d, regime_r_t (0=calm, 1=stress), xi (tail index), beta (tail scale), var_99, es_999. Returns null when PDA cold-start.",
        inputSchema: {
            type: "object",
            properties: { underlying: { type: "string", enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"] } },
            required: ["underlying"],
        },
    },
    {
        name: "skew_fetch_hamilton",
        description: "Read on-chain Hamilton 2-state regime filter posterior for an asset. π_calm, π_stress, p01/p10 transition matrix, consecutive-day debounce. r_t > 0.50 triggers L_a 2× stress multiplier in pm_engine.",
        inputSchema: {
            type: "object",
            properties: { underlying: { type: "string", enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"] } },
            required: ["underlying"],
        },
    },
    {
        name: "skew_fetch_clearing_member",
        description: "Read a Clearing Member account snapshot — collateral, IF contribution, clearing-class lockup, total_pm_locked, free_collateral, net notional, last_im_micro, class rank, tier_locked_until, under_liquidation flag. Drives risk diagnostics: equity vs IM ratio (liquidation trigger if < 1.10), class upgrade headroom, free capital for new positions.",
        inputSchema: {
            type: "object",
            properties: {
                cm_authority: {
                    type: "string",
                    description: "CM authority pubkey base58. Default: caller's wallet.",
                },
            },
        },
    },
    {
        name: "skew_fetch_insurance_fund",
        description: "Read singleton Insurance Fund balances used inside the 6-tier default cascade: Protocol SITG, mutualized BTC/ETH/SOL pool, XRP/HYPE pool, cross spillover, total_drained, default_event_count.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "skew_fetch_skew_metrics",
        description: "Read on-chain SkewMetricsPda for an asset — RR25 / BF25 / RR10 / ATM slope / 8-tenor IV strip. Cranked hourly by SKEW_AUTHORITY via update_skew_metrics. Drives the calendar / smile-fit risk overlays.",
        inputSchema: {
            type: "object",
            properties: { underlying: { type: "string", enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"] } },
            required: ["underlying"],
        },
    },
    {
        name: "skew_fetch_dvol",
        description: "Read on-chain DvolPda for an asset — 28d / 90d DVOL variance index + realized variance. Accepts the same asset forms as other market-data tools: underlying/asset symbol (BTC, ETH, SOL, XRP, HYPE) or assetIdx/asset_idx 0..4.",
        inputSchema: {
            type: "object",
            properties: {
                underlying: {
                    type: "string",
                    enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
                    description: "Asset symbol. Required unless asset, assetIdx, or asset_idx is supplied.",
                },
                asset: {
                    type: "string",
                    enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
                    description: "Alias for underlying; case-insensitive. Required unless another asset selector is supplied.",
                },
                assetIdx: {
                    type: "integer",
                    minimum: 0,
                    maximum: 4,
                    description: "Numeric asset enum: BTC=0, ETH=1, SOL=2, XRP=3, HYPE=4. Required unless a symbol selector is supplied.",
                },
                asset_idx: {
                    type: "integer",
                    minimum: 0,
                    maximum: 4,
                    description: "Snake-case alias for assetIdx. Required unless a symbol selector is supplied.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_fetch_isolated_vault",
        description: "Read a per-(user, option) IsolatedVaultPda — collateral + liquidation flag. Each user-option pair may run isolated margin in addition to / in lieu of cross.",
        inputSchema: {
            type: "object",
            properties: {
                user: { type: "string", description: "User authority pubkey base58." },
                option: { type: "string", description: "Option PDA base58." },
            },
            required: ["user", "option"],
        },
    },
    {
        name: "skew_fetch_combo_intent",
        description: "Read a v1 ComboIntentPda — escrowed-premium ≤4-leg combo state (status, fill_count, residual_premium). For v2, see fetch_combo_intent_v2 (not yet exposed).",
        inputSchema: {
            type: "object",
            properties: {
                buyer: { type: "string", description: "Buyer pubkey base58." },
                combo_id: { type: "string", description: "u64 nonce as string." },
            },
            required: ["buyer", "combo_id"],
        },
    },
    {
        name: "skew_fetch_cross_asset",
        description: "Read singleton CrossAssetMatrix — 10 pairwise correlations + 10 stress-conditional correlations across BTC/ETH/SOL/XRP/HYPE. Drives ICC adjustment for M2/M3 clearing-class portfolio margin.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "skew_fetch_microstructure",
        description: "Read on-chain MicrostructurePDA — multi-venue spot / bid-ask spread aggregate per asset. Cranked by the microstructure keeper.",
        inputSchema: {
            type: "object",
            properties: { underlying: { type: "string", enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"] } },
            required: ["underlying"],
        },
    },
    {
        name: "skew_fetch_lst_vault",
        description: "Read a per-(user, lst_mint) LstVault PDA — total / pledged / tier-locked / free LST quantity in lamports. Drives the collateral free-balance display.",
        inputSchema: {
            type: "object",
            properties: {
                user: { type: "string", description: "User authority pubkey base58." },
                lst_mint: {
                    type: "string",
                    description: "LST mint pubkey base58. Defaults to JITOSOL_MINT.",
                },
            },
            required: ["user"],
        },
    },
    {
        name: "skew_fetch_series_listing",
        description: "Read a SeriesListingPda — σ·√T grid cell metadata (last fill, OI count, status). Caller must derive the PDA from (asset, strike, expiry, type, direction) and pass the resulting pubkey.",
        inputSchema: {
            type: "object",
            properties: { series: { type: "string", description: "SeriesListingPda base58." } },
            required: ["series"],
        },
    },
    {
        name: "skew_fetch_builder_code",
        description: "Read a BuilderCodePda — registration timestamp, $1K USDC deposit, decayed 30-day routed volume, accrued fee share, label.",
        inputSchema: {
            type: "object",
            properties: { builder: { type: "string", description: "Builder authority pubkey base58." } },
            required: ["builder"],
        },
    },
    {
        name: "skew_fetch_conditional_order",
        description: "Read a ConditionalOrderPda — full SL / TP / OCO order state (kind, trigger price/oracle/direction, action, current state, valid_until_ts, action target).",
        inputSchema: {
            type: "object",
            properties: {
                authority: { type: "string", description: "Order authority pubkey base58." },
                order_id: { type: "string", description: "u64 nonce as bigint string." },
            },
            required: ["authority", "order_id"],
        },
    },
    {
        name: "skew_fetch_rfq_auction",
        description: "Read an RfqAuctionPda — buyer, option_spec, max_premium, open/close slots, best_quote (mm + premium + valid_until_slot), state.",
        inputSchema: {
            type: "object",
            properties: { auction: { type: "string", description: "Auction PDA base58." } },
            required: ["auction"],
        },
    },
    {
        name: "skew_list_rfq_quotes",
        description: "Read the full quote-depth tape for one RFQ auction PDA from the public web/indexer API. This is read-only and complements skew_fetch_rfq_auction, which only exposes the on-chain best quote snapshot.",
        inputSchema: {
            type: "object",
            properties: {
                auction: { type: "string", description: "RFQ auction PDA base58." },
                limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: 100,
                    description: "Maximum quotes to return. Defaults to 50.",
                },
            },
            required: ["auction"],
        },
    },
    {
        name: "skew_fetch_combo_intent_v2",
        description: "Read a ComboIntentPdaV2 — header (status, leg_count, legs_filled, total_max_premium, expires_ts) + per-leg detail (option / side / filled / max_premium / fill_premium) for the first leg_count slots.",
        inputSchema: {
            type: "object",
            properties: {
                buyer: { type: "string", description: "Buyer authority pubkey base58." },
                combo_id: { type: "string", description: "u64 nonce as bigint string." },
            },
            required: ["buyer", "combo_id"],
        },
    },
    // ──────────────────────────────────────────────────────────────────────
    //  Lifecycle — option transfer / cancel / close-expired / variation margin
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_transfer_option",
        description: "Transfer an existing option SPL token to a new non-creator holder and update the OptionAccount holder field. Provide option or option_address. Returns tx plus holder/portfolio readback; treat delivery as complete only when readback_ok=true. This is the current verified secondary execution primitive; it is not an escrowed orderbook fill and it is not a PM buyback/close. The SDK rejects transfers back to the option creator because that would require a dedicated buyback close to keep the writer registry and PM lock consistent. Caller pays rent for the destination ATA if absent.",
        inputSchema: {
            type: "object",
            properties: {
                option: {
                    type: "string",
                    description: "Option PDA base58. Required unless option_address is supplied.",
                },
                option_address: {
                    type: "string",
                    description: "Alias for option. Required unless option is supplied; accepted for consistency with skew_buy_option output.",
                },
                new_holder: { type: "string", description: "Destination wallet pubkey base58." },
            },
            required: ["new_holder"],
        },
    },
    {
        name: "skew_track_held_position",
        description: "Register an Active option currently held by the configured wallet into that wallet's Clearing Member PositionRegistry as a PM long hedge. Use this after a CM buys or receives a long option so calculate_margin and future atomic_fill_from_relay checks can see the hedge. This mutates the CM registry; it is not needed for ordinary non-CM retail holds.",
        inputSchema: {
            type: "object",
            properties: {
                option: {
                    type: "string",
                    description: "Option PDA address (base58). Alias option_address is also accepted.",
                },
                option_address: {
                    type: "string",
                    description: "Alias for option.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_untrack_held_position",
        description: "Remove an option held by the configured wallet from that wallet's PM PositionRegistry before transfer/close workflows. The wallet must still be the current holder.",
        inputSchema: {
            type: "object",
            properties: {
                option: {
                    type: "string",
                    description: "Option PDA address (base58). Alias option_address is also accepted.",
                },
                option_address: {
                    type: "string",
                    description: "Alias for option.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_rebalance_pm_lock",
        description: "Recompute PM for the option writer and release excess marginal IM from the option escrow back into the writer CM escrow. Use after hedges are tracked or after calculate_margin shows the book needs less escrow. max_release_usdc=0 releases all eligible excess.",
        inputSchema: {
            type: "object",
            properties: {
                option: {
                    type: "string",
                    description: "Option PDA address (base58). Alias option_address is also accepted.",
                },
                option_address: {
                    type: "string",
                    description: "Alias for option.",
                },
                max_release_usdc: {
                    type: "number",
                    description: "Maximum USDC to release. Defaults to 0, meaning release all eligible excess.",
                },
            },
            required: [],
        },
    },
    {
        name: "skew_rollover_option",
        description: "Roll a still-Active option into a new (strike, expiry, notional) without unwinding the position. Closes the old option PDA + escrow; new escrow seeded from the same collateral.",
        inputSchema: {
            type: "object",
            properties: {
                old_option: { type: "string", description: "Existing option PDA base58." },
                new_expiry: { type: "string", description: "ISO-8601 UTC of the new expiry." },
                new_strike: { type: "number", description: "USD." },
                new_notional: { type: "number", description: "Max payoff USDC." },
            },
            required: ["old_option", "new_expiry", "new_strike", "new_notional"],
        },
    },
    {
        name: "skew_cancel_option",
        description: "Pre-buy cancel by the creator. Refunds escrowed collateral. Allowed only when state == Created (not yet bought).",
        inputSchema: {
            type: "object",
            properties: { option: { type: "string", description: "Option PDA base58." } },
            required: ["option"],
        },
    },
    {
        name: "skew_close_expired",
        description: "Permissionless close of an unsold expired option (state == Created past expiry). Returns escrow to creator; closes the PDA. Used by Settler keeper.",
        inputSchema: {
            type: "object",
            properties: { option: { type: "string", description: "Option PDA base58." } },
            required: ["option"],
        },
    },
    {
        name: "skew_expire_abandoned",
        description: "Permissionless cleanup of an Active option past expiry whose holder never invoked settle. Closes the option + drains escrow back to creator.",
        inputSchema: {
            type: "object",
            properties: { option: { type: "string", description: "Option PDA base58." } },
            required: ["option"],
        },
    },
    {
        name: "skew_call_variation_margin",
        description: "Permissionless variation-margin keeper call against a CM. Triggers MTM realisation; remaining_accounts may carry the CM's open option PDAs to update equity. Run by the variation-margin bot.",
        inputSchema: {
            type: "object",
            properties: {
                cm_authority: { type: "string", description: "CM authority pubkey base58." },
                remaining_accounts: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional option PDAs to include for MTM scan.",
                },
            },
            required: ["cm_authority"],
        },
    },
    {
        name: "skew_register_clearing_member",
        description: "One-time onboarding: enrolls the caller as a Clearing Member. Initialises the ClearingMemberPda + USDC escrow. Required before opening any cross-margined position. Starts in the M0 Segregated clearing class (no class floor, but a non-zero seed is recommended).",
        inputSchema: {
            type: "object",
            properties: {
                initial_collateral_usdc: {
                    type: "number",
                    description: "USDC to deposit at registration (e.g. 1000 for $1K).",
                },
            },
            required: ["initial_collateral_usdc"],
        },
    },
    {
        name: "skew_cm_add_collateral",
        description: "Top up the Clearing Member's USDC collateral pool. Increases free_collateral, raising the IM headroom for new positions.",
        inputSchema: {
            type: "object",
            properties: { amount_usdc: { type: "number", description: "USDC to add." } },
            required: ["amount_usdc"],
        },
    },
    {
        name: "skew_cm_withdraw_collateral",
        description: "Withdraw free USDC from the CM escrow back to the caller's USDC ATA. Capped at free_collateral = collateral − tier_lockup − total_pm_locked. IF contribution is separate IF-escrow custody.",
        inputSchema: {
            type: "object",
            properties: { amount_usdc: { type: "number", description: "USDC to withdraw." } },
            required: ["amount_usdc"],
        },
    },
    {
        name: "skew_init_volume_tracker",
        description: "One-shot init for the caller's VolumeTrackerPda. Required before first relay/CM atomic fill because the hot path no longer auto-inits volume trackers.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "skew_init_fee_config",
        description: "SKEW_AUTHORITY one-shot init for the singleton FeeConfigPda used by fee dispatch.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "skew_init_collateral_policy",
        description: "SKEW_AUTHORITY one-shot init for CollateralPolicyPda, the settlement/collateral mint allowlist required by live custody paths.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "skew_register_collateral_policy_entry",
        description: "SKEW_AUTHORITY registers an allowed settlement/collateral mint in CollateralPolicyPda. kind: 0=stable, 1=native, 2=LST.",
        inputSchema: {
            type: "object",
            properties: {
                mint: { type: "string", description: "SPL mint pubkey." },
                decimals: { type: "integer", minimum: 0, maximum: 12 },
                kind: { type: "integer", enum: [0, 1, 2] },
                oracle_feed: {
                    type: "string",
                    description: "Optional oracle feed pubkey; use default for stable USDC.",
                },
                max_depeg_bps: {
                    type: "integer",
                    minimum: 0,
                    maximum: 10000,
                    description: "Optional LST/native depeg fence.",
                },
            },
            required: ["mint", "decimals", "kind"],
        },
    },
    // ──────────────────────────────────────────────────────────────────────
    //  RFQ maker / quote / finalize
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_register_rfq_maker",
        description: "One-time enrollment: register the caller as an RFQ market maker. Locks the maker-deposit in SOL for quote slashing/rent. The wallet needs at least 1.02 SOL before this call.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "skew_submit_rfq_quote",
        description: "Submit an ed25519-signed price quote to an open RFQ auction. Quote must beat the current best to count. Slot-window enforcement — late submissions revert.",
        inputSchema: {
            type: "object",
            properties: {
                auction: { type: "string", description: "Auction PDA base58." },
                premium_micro: {
                    type: "string",
                    description: "Quoted premium (USDC micro) as bigint string.",
                },
                valid_until_slot: {
                    type: "string",
                    description: "Quote-validity expiry slot as bigint string.",
                },
                signature: {
                    type: "string",
                    description: "Ed25519 signature over the quote digest, base58.",
                },
            },
            required: ["auction", "premium_micro", "valid_until_slot", "signature"],
        },
    },
    {
        name: "skew_submit_rfq_quote_direct",
        description: "Browser/operator-wallet RFQ quote lane. The caller's wallet signs the transaction directly; no detached signMessage/Ed25519 signature is required. Use this for terminal MM quote submissions.",
        inputSchema: {
            type: "object",
            properties: {
                auction: { type: "string", description: "Auction PDA base58." },
                premium_micro: {
                    type: "string",
                    description: "Quoted premium (USDC micro) as bigint string.",
                },
                valid_until_slot: {
                    type: "string",
                    description: "Quote-validity expiry slot as bigint string.",
                },
            },
            required: ["auction", "premium_micro", "valid_until_slot"],
        },
    },
    {
        name: "skew_finalize_rfq_auction",
        description: "Permissionless finalize past close_slot. Selects the winning quote, refunds the RFQ escrow to the buyer, and emits the settlement signal; actual option mint + MM premium transfer is done by the follow-up atomic_fill_from_relay path.",
        inputSchema: {
            type: "object",
            properties: {
                auction: { type: "string", description: "Auction PDA base58." },
                buyer_usdc_ata: {
                    type: "string",
                    description: "Optional buyer USDC ATA pubkey base58. If omitted, SDK derives it from the auction buyer and configured USDC mint.",
                },
            },
            required: ["auction"],
        },
    },
    {
        name: "skew_cancel_rfq_auction",
        description: "Buyer-initiated cancel of an Open RFQ auction before close_slot. Returns the buyer's escrow.",
        inputSchema: {
            type: "object",
            properties: { auction: { type: "string", description: "Auction PDA base58." } },
            required: ["auction"],
        },
    },
    // ──────────────────────────────────────────────────────────────────────
    //  Isolated margin · LST vault · IF deposit
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_init_isolated_vault",
        description: "Initialise the per-(user, option) IsolatedVaultPda — one-time. Subsequent deposit/withdraw hang off this PDA.",
        inputSchema: {
            type: "object",
            properties: { option: { type: "string", description: "Option PDA base58." } },
            required: ["option"],
        },
    },
    {
        name: "skew_deposit_isolated",
        description: "Deposit USDC into a per-option isolated vault. Used to fund a position's IM separately from cross collateral.",
        inputSchema: {
            type: "object",
            properties: {
                option: { type: "string", description: "Option PDA base58." },
                amount_usdc: { type: "number", description: "USDC to deposit." },
            },
            required: ["option", "amount_usdc"],
        },
    },
    {
        name: "skew_withdraw_isolated",
        description: "Withdraw free USDC from a per-option isolated vault. Capped at usdc_micro − locked_micro.",
        inputSchema: {
            type: "object",
            properties: {
                option: { type: "string", description: "Option PDA base58." },
                amount_usdc: { type: "number", description: "USDC to withdraw." },
            },
            required: ["option", "amount_usdc"],
        },
    },
    {
        name: "skew_init_lst_vault",
        description: "Initialise per-(user, lst_mint) LST vault — one-time. Phase 1 supports jitoSOL only.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "skew_deposit_lst_collateral",
        description: "Deposit jitoSOL (or another whitelisted LST) into the LST vault as collateral.",
        inputSchema: {
            type: "object",
            properties: {
                amount_lamports: { type: "string", description: "Lamports as bigint string." },
            },
            required: ["amount_lamports"],
        },
    },
    {
        name: "skew_withdraw_lst_collateral",
        description: "Withdraw free LST collateral. Capped at lst_qty − locked_qty so pledged collateral can't be pulled.",
        inputSchema: {
            type: "object",
            properties: {
                amount_lamports: { type: "string", description: "Lamports as bigint string." },
            },
            required: ["amount_lamports"],
        },
    },
    // Phase 1A.2 (2026-05-04) — Native SOL collateral lifecycle tools.
    // Spec: V2_SOL_NATIVE_OPTIONS_PLAN_2026-05-04.md §5.
    {
        name: "skew_init_native_sol_vault",
        description: "Initialise per-user Native SOL (wSOL) vault — one-time. ETF APs / regulated US institutions cannot hold LSTs; this path lets them post Native SOL while retaining portfolio margin.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "skew_deposit_native_sol_collateral",
        description: "Deposit wrapped SOL (wSOL) into the Native SOL vault as collateral. The user must wrap native SOL → wSOL on the client side prior to deposit.",
        inputSchema: {
            type: "object",
            properties: {
                amount_lamports: {
                    type: "string",
                    description: "Lamports as bigint string (1 SOL = 1e9 lamports).",
                },
            },
            required: ["amount_lamports"],
        },
    },
    {
        name: "skew_withdraw_native_sol_collateral",
        description: "Withdraw free Native SOL collateral. Capped at sol_qty − locked_qty so pledged collateral can't be pulled.",
        inputSchema: {
            type: "object",
            properties: {
                amount_lamports: { type: "string", description: "Lamports as bigint string." },
            },
            required: ["amount_lamports"],
        },
    },
    {
        name: "skew_fetch_native_sol_vault",
        description: "Read NativeSolVault snapshot for any user. Returns sol_qty / locked_qty / free_qty / last_update_slot. Mirror of skew_fetch_lst_vault but no mint dimension (single wSOL mint).",
        inputSchema: {
            type: "object",
            properties: {
                user: { type: "string", description: "User pubkey base58. Default = wallet." },
            },
        },
    },
    {
        name: "skew_deposit_to_if",
        description: "Deposit USDC into IF escrow as this CM's contribution to one of the IF tiers. Increments cm.if_contribution_micro and the IF's total_cm_contributions_micro; it is no longer part of CM escrow collateral.",
        inputSchema: {
            type: "object",
            properties: {
                tier: {
                    type: "integer",
                    enum: [0, 1, 2],
                    description: "IF tier — 0=Tier-1 mutualized BTC/ETH/SOL, 1=Tier-2 (XRP/HYPE), 2=cross-spillover. Default 1.",
                },
                amount_usdc: { type: "number", description: "USDC to contribute." },
                is_sitg: {
                    type: "boolean",
                    description: "Skin-in-the-game flag (Tier-3 protocol contribution). Default false.",
                    default: false,
                },
            },
            required: ["amount_usdc"],
        },
    },
    // ──────────────────────────────────────────────────────────────────────
    //  OCO + execute_conditional + apply_*_action + finalize_combo_leg_v2
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_register_oco_pair",
        description: "Atomically register a Stop-Loss + Take-Profit pair (both Active) with mutual cancel-the-other linkage. Saves two register_conditional_order tx + sets up the OCO bookkeeping.",
        inputSchema: {
            type: "object",
            properties: {
                stop_loss: {
                    type: "object",
                    description: "Stop-loss leg args (same shape as register_conditional_order minus kind/direction which are forced).",
                    properties: {
                        order_id: { type: "string" },
                        underlying: { type: "string", enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"] },
                        trigger_price_usd: { type: "number" },
                        action: {
                            type: "string",
                            enum: ["CloseIsolatedPosition"],
                            description: "Only executable MCP action.",
                        },
                        action_target: { type: "string" },
                        valid_until_ts: { type: "string" },
                    },
                    required: [
                        "order_id",
                        "underlying",
                        "trigger_price_usd",
                        "action",
                        "action_target",
                        "valid_until_ts",
                    ],
                },
                take_profit: {
                    type: "object",
                    properties: {
                        order_id: { type: "string" },
                        underlying: { type: "string", enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"] },
                        trigger_price_usd: { type: "number" },
                        action: {
                            type: "string",
                            enum: ["CloseIsolatedPosition"],
                            description: "Only executable MCP action.",
                        },
                        action_target: { type: "string" },
                        valid_until_ts: { type: "string" },
                    },
                    required: [
                        "order_id",
                        "underlying",
                        "trigger_price_usd",
                        "action",
                        "action_target",
                        "valid_until_ts",
                    ],
                },
            },
            required: ["stop_loss", "take_profit"],
        },
    },
    {
        name: "skew_execute_conditional_order",
        description: "Permissionless keeper trigger — reads the stored ConditionalOrderPda, checks its Pyth EMA oracle, and flips Active -> Triggered when the crossing holds past grace_slots. Then call skew_apply_close_isolated_action for executable CloseIsolatedPosition orders.",
        inputSchema: {
            type: "object",
            properties: {
                order_authority: { type: "string", description: "Original order owner pubkey." },
                order_id: { type: "string", description: "u64 nonce as bigint string." },
                trigger_oracle: {
                    type: "string",
                    description: "Optional Pyth oracle account override. If omitted, MCP reads it from ConditionalOrderPda.",
                },
                action_target: {
                    type: "string",
                    description: "Optional option PDA override. If omitted, MCP reads it from ConditionalOrderPda.",
                },
                linked_order: {
                    type: "string",
                    description: "Optional linked OCO partner order PDA.",
                },
            },
            required: ["order_authority", "order_id"],
        },
    },
    {
        name: "skew_cleanup_expired_conditional_order",
        description: "Permissionless rent-recovery for a conditional order past valid_until_ts. Lamports refunded to the original authority.",
        inputSchema: {
            type: "object",
            properties: {
                order_authority: { type: "string" },
                order_id: { type: "string" },
            },
            required: ["order_authority", "order_id"],
        },
    },
    {
        name: "skew_apply_close_isolated_action",
        description: "After an SL/TP triggers with action=CloseIsolatedPosition, drain the linked IsolatedVault → user. Settles the conditional order.",
        inputSchema: {
            type: "object",
            properties: {
                order_id: { type: "string" },
                action_target: {
                    type: "string",
                    description: "Option PDA base58 the action operates on (must match the conditional order's action_target).",
                },
            },
            required: ["order_id", "action_target"],
        },
    },
    {
        name: "skew_apply_early_exercise_action",
        description: "Fail-closed guardrail. On-chain early-exercise automation is disabled until the direct exercise CPI ships; this tool returns an error instead of emitting a misleading state-only event.",
        inputSchema: {
            type: "object",
            properties: { order_id: { type: "string" } },
            required: ["order_id"],
        },
    },
    {
        name: "skew_apply_sell_via_rfq_action",
        description: "Fail-closed guardrail. On-chain sell-via-RFQ automation is disabled until the direct RFQ CPI ships; use the normal RFQ auction flow instead.",
        inputSchema: {
            type: "object",
            properties: { order_id: { type: "string" } },
            required: ["order_id"],
        },
    },
    {
        name: "skew_apply_buyback_via_rfq_action",
        description: "Fail-closed guardrail. On-chain buyback-via-RFQ automation is disabled until the direct RFQ CPI ships; use the normal RFQ auction flow instead.",
        inputSchema: {
            type: "object",
            properties: { order_id: { type: "string" } },
            required: ["order_id"],
        },
    },
    {
        name: "skew_finalize_combo_leg_v2",
        description: "Permissionless leg-fill recorder for a v2 combo intent. The SDK now verifies against the actual filled OptionAccount leg before stamping realised premium.",
        inputSchema: {
            type: "object",
            properties: {
                intent: { type: "string", description: "ComboIntentV2Pda base58." },
                leg_index: { type: "integer", minimum: 0, maximum: 31 },
                realised_premium_usd: { type: "number" },
            },
            required: ["intent", "leg_index", "realised_premium_usd"],
        },
    },
    // ──────────────────────────────────────────────────────────────────────
    //  Builder code lifecycle (newly enabled by SDK PR-E)
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_register_builder",
        description: "Register the caller as a fee-rebate Builder. Locks $1K USDC anti-spam deposit; earns 25% of taker fees on routed trades.",
        inputSchema: {
            type: "object",
            properties: {
                label: { type: "string", description: "ASCII label, ≤32 bytes (no NUL)." },
            },
            required: ["label"],
        },
    },
    {
        name: "skew_withdraw_builder_fees",
        description: "Withdraw accrued builder fees to the builder's USDC ATA. Capped at builder_code.fees_accrued_micro.",
        inputSchema: {
            type: "object",
            properties: { amount_usdc: { type: "number" } },
            required: ["amount_usdc"],
        },
    },
    {
        name: "skew_close_builder_code",
        description: "Close the BuilderCode PDA — refunds the $1K deposit. Requires fees_accrued_micro == 0 (drain first via withdraw_builder_fees) and volume_30d_routed below the refund-min threshold.",
        inputSchema: { type: "object", properties: {} },
    },
    // ──────────────────────────────────────────────────────────────────────
    //  Series-listing keeper helpers
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_list_series",
        description: "List a single (asset, strike, expiry, type, direction) grid cell. Pays ~0.0009 SOL rent. Permissionless — keepers run a σ·√T grid policy.",
        inputSchema: {
            type: "object",
            properties: {
                underlying: { type: "string", enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"] },
                strike_usd: { type: "number", description: "USD." },
                expiry: { type: "string", description: "ISO-8601 UTC." },
                option_type: {
                    type: "string",
                    enum: [
                        "Vanilla",
                        "Digital",
                        "CappedVanilla",
                        "RangeAccrual",
                        "VanillaInverse",
                        "DigitalInverse",
                    ],
                },
                direction: {
                    type: "integer",
                    enum: [1, -1, 0],
                    description: "+1 Call / -1 Put / 0 RangeAccrual",
                },
            },
            required: ["underlying", "strike_usd", "expiry", "option_type", "direction"],
        },
    },
    {
        name: "skew_delist_series",
        description: "Delist a series cell — closes the PDA + refunds rent. On-chain enforces post-expiry + zero OI.",
        inputSchema: {
            type: "object",
            properties: { series: { type: "string", description: "SeriesListingPda base58." } },
            required: ["series"],
        },
    },
    {
        name: "skew_governance_set_series_max_oi",
        description: "M6 (2026-05-03) — SKEW_AUTHORITY sets per-series `max_oi_count` cap (per-strike-bucket OI ceiling). cap=0 removes the cap (default for newly-listed series). Existing OI is NEVER force-closed. Caller must be SKEW_AUTHORITY (Phase 1) or Squads multisig (Phase 2). First-mover defense vs option-expiration pinning (NPP 2005 measured 16.5 bp / $9 B effect on equity options).",
        inputSchema: {
            type: "object",
            properties: {
                series: { type: "string", description: "SeriesListingPda base58." },
                max_oi_count: {
                    type: "integer",
                    minimum: 0,
                    description: "Cap as a u32. 0 = no cap (default).",
                },
            },
            required: ["series", "max_oi_count"],
        },
    },
    // ──────────────────────────────────────────────────────────────────────
    //  Pricing / risk forwarders — thin wrappers around skew-pricing endpoints
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_get_settlement_payoff",
        description: "Compute the settlement-time payoff (USD) for a single position at a given spot. Supports the same SdkPosition shape as /margin_breakdown — vanilla / digital / capped / range_accrual. Use accrued_fraction for path-dependent payoffs (e.g. range accrual time-spent fraction).",
        inputSchema: {
            type: "object",
            properties: {
                position: {
                    type: "object",
                    description: "SdkPosition shape — { underlying, payoff, strike, expiry, notional, qty, side, [upper_bound] }.",
                },
                settlement_spot: { type: "number", description: "Spot at settlement, USD." },
                accrued_fraction: {
                    type: "number",
                    description: "0..1 path-fraction for range accrual; 0 default.",
                },
            },
            required: ["position", "settlement_spot"],
        },
    },
    {
        name: "skew_get_dvol_replication",
        description: "Build a 28d / 90d DVOL crank payload from raw OTM strips + log-returns. Output is the bytes the on-chain DVOL crank ix accepts. Used by the DVOL keeper bot. Requires ATM-bracketed OTM strips (forward + strikes + otm_prices).",
        inputSchema: {
            type: "object",
            properties: {
                asset_idx: {
                    type: "integer",
                    enum: [0, 1, 2, 3, 4],
                    description: "0=BTC, 1=ETH, 2=SOL, 3=XRP, 4=HYPE.",
                },
                strip_28d: {
                    type: "object",
                    description: "{ forward, strikes:[number], otm_prices:[number] }",
                },
                strip_90d: { type: "object", description: "Same shape — 90d horizon." },
                returns: {
                    type: "array",
                    items: { type: "number" },
                    description: "Log returns trailing N samples.",
                },
                bars_per_day: {
                    type: "number",
                    description: "Sampling cadence (24=hourly, 96=15-min, 1=daily).",
                },
            },
            required: ["asset_idx", "strip_28d", "strip_90d", "returns", "bars_per_day"],
        },
    },
    {
        name: "skew_get_combo_quote",
        description: "Quote a multi-leg combo as a single net premium + Greeks aggregate. Each leg has its own (option spec, side ±1, qty). Returns net premium + delta/gamma/vega aggregated across legs. Use this before register_combo_intent to pre-validate the cap.",
        inputSchema: {
            type: "object",
            properties: {
                legs: {
                    type: "array",
                    minItems: 1,
                    maxItems: 32,
                    items: {
                        type: "object",
                        description: "ComboLeg shape — { underlying, payoff, strike, expiry, notional, qty, side, [upper_bound] }.",
                    },
                },
            },
            required: ["legs"],
        },
    },
    {
        name: "skew_get_recovery_priority",
        description: "Order the ADL / clawback queue for a given bad-debt residual. Pass per-CM profiles (equity, IM, recent volume) and a target loss in USDC micro; the planner returns who pays first + how much. Used by the liquidation keeper after the IF tier waterfall is exhausted.",
        inputSchema: {
            type: "object",
            properties: {
                target_loss_micro: {
                    type: "string",
                    description: "Bad-debt residual to absorb (USDC × 10⁶) as bigint string.",
                },
                kind: {
                    type: "string",
                    enum: ["adl", "clawback"],
                    description: "ADL = forced-position close; clawback = profit clawback.",
                },
                candidates: {
                    type: "array",
                    description: "Per-CM CmRecoveryProfile snapshots fetched from chain.",
                    items: { type: "object" },
                },
            },
            required: ["target_loss_micro", "kind", "candidates"],
        },
    },
    {
        name: "skew_get_if_replenish_check",
        description: "Check whether the Insurance Fund is below its TVL-pegged floor and how much USDC it should pull from the fee accumulator to top back up. Returns { needs_replenish, deficit_micro, target_micro }. Used by the IF replenish keeper.",
        inputSchema: {
            type: "object",
            properties: {
                current_capacity_micro: {
                    type: "string",
                    description: "IF current capacity (USDC micro) as bigint string.",
                },
                tvl_micro: { type: "string", description: "Protocol TVL (USDC micro) as bigint string." },
                static_floor_micro: {
                    type: "string",
                    description: "Optional override for the static floor — defaults to IF_STATIC_FLOOR_TOTAL_USDC_MICRO.",
                },
            },
            required: ["current_capacity_micro", "tvl_micro"],
        },
    },
    // ──────────────────────────────────────────────────────────────────────
    //  Combo intent v1 (≤ 4-leg) and v2 (≤ 32-leg)
    //  v1 escrows total max premium upfront; v2 captures premium per-leg
    //  via finalize_combo_leg_v2 (no upfront escrow). v2 is the keeper-
    //  friendly path — buyers cancel via cancel_combo_intent_v2 or anyone
    //  cleans up after expiry via cleanup_expired_combo_v2.
    // ──────────────────────────────────────────────────────────────────────
    {
        name: "skew_register_combo_intent",
        description: "Register a multi-leg combo intent (v1, max 4 legs). Escrows total max premium upfront in USDC; legs fill atomically via atomic_fill_relay. Use for spreads / risk-reversals / butterflies that must price as a unit. Each leg specifies an existing option PDA + side (+1 buy / -1 sell) + per-leg premium cap.",
        inputSchema: {
            type: "object",
            properties: {
                combo_id: {
                    type: "string",
                    description: "Caller-chosen u64 nonce as string. Must be unique per buyer.",
                },
                legs: {
                    type: "array",
                    minItems: 2,
                    maxItems: 4,
                    items: {
                        type: "object",
                        properties: {
                            option: { type: "string", description: "Option PDA (base58)." },
                            side: { type: "integer", enum: [1, -1], description: "+1 buy / -1 sell." },
                            max_premium_usd: { type: "number", description: "Per-leg premium cap (USDC)." },
                        },
                        required: ["option", "side", "max_premium_usd"],
                    },
                },
                total_max_premium_usd: {
                    type: "number",
                    description: "Total premium cap across all legs (USDC).",
                },
                expiry_ts: {
                    type: "string",
                    description: "Unix-seconds (bigint as string). Combo cancels after this.",
                },
            },
            required: ["combo_id", "legs", "total_max_premium_usd", "expiry_ts"],
        },
    },
    {
        name: "skew_cancel_combo_intent",
        description: "Cancel an Open v1 combo intent. Refunds residual escrow + closes PDA. Status must be Open (not Active/Cancelled).",
        inputSchema: {
            type: "object",
            properties: { combo_id: { type: "string", description: "Caller's combo nonce." } },
            required: ["combo_id"],
        },
    },
    {
        name: "skew_finalize_combo_intent",
        description: "Finalize a fully-filled v1 combo. Flips status → Active, refunds residual (max premium − actually paid), closes PDA + escrow. Call after all legs reported via atomic_fill_relay.",
        inputSchema: {
            type: "object",
            properties: { combo_id: { type: "string", description: "Caller's combo nonce." } },
            required: ["combo_id"],
        },
    },
    {
        name: "skew_register_combo_intent_v2",
        description: "Register a 1..32-leg combo intent (v2 — supersedes v1's max-4 limit). NO premium escrow at register; premium captured leg-by-leg in finalize_combo_leg_v2 (called by keeper as fills land). cleanup_expired_combo_v2 is permissionless past expires_ts. Use for box spreads / iron condors / structured products that need > 4 legs.",
        inputSchema: {
            type: "object",
            properties: {
                combo_id: { type: "string", description: "Caller's u64 nonce as string." },
                legs: {
                    type: "array",
                    minItems: 1,
                    maxItems: 32,
                    items: {
                        type: "object",
                        properties: {
                            option: { type: "string", description: "Option PDA (base58)." },
                            side: { type: "integer", enum: [1, -1], description: "+1 buy / -1 sell." },
                            max_premium_usd: { type: "number", description: "Per-leg premium cap (USDC)." },
                        },
                        required: ["option", "side", "max_premium_usd"],
                    },
                },
                total_max_premium_usd: {
                    type: "number",
                    description: "Total premium cap across all legs.",
                },
                expires_ts: {
                    type: "string",
                    description: "Unix-seconds — past this any caller can `cleanup_expired_combo_v2`.",
                },
            },
            required: ["combo_id", "legs", "total_max_premium_usd", "expires_ts"],
        },
    },
    {
        name: "skew_cancel_combo_intent_v2",
        description: "Buyer-initiated cancel of an Open v2 intent. Closes the PDA → rent refund.",
        inputSchema: {
            type: "object",
            properties: { combo_id: { type: "string", description: "Caller's combo nonce." } },
            required: ["combo_id"],
        },
    },
    {
        name: "skew_cleanup_expired_combo_v2",
        description: "Permissionless cleanup — closes an expired v2 intent past its expires_ts and refunds the buyer's rent. Caller pays the tx fee. Used by keepers to drain stale intents.",
        inputSchema: {
            type: "object",
            properties: {
                buyer_authority: { type: "string", description: "Original buyer's pubkey (base58)." },
                combo_id: { type: "string", description: "Combo nonce." },
            },
            required: ["buyer_authority", "combo_id"],
        },
    },
    {
        name: "skew_estimate_fee",
        description: "Compute the launch effective fee for a candidate options trade — VIP volume, clearing-class discount, and optional builder share. Returns effective bps, USD fee, fee-cap state, and the protocol/builder split. Public classes are M0 Segregated, M1 Portfolio, M2 Cross-Asset, and M3 Clearing Prime; compatibility values remain standard/silver/gold/platinum for IDL stability. Builder code share is 25% of effective taker. Spec: docs/fee-schedule-v5.1.md.",
        inputSchema: {
            type: "object",
            properties: {
                volume_30d_usd: {
                    type: "number",
                    description: "Caller's 30-day rolling options notional in USD. Drives VIP volume discount resolution.",
                },
                equity_usd: {
                    type: "number",
                    description: "Caller's equity in USD. VIP1 entry path is $25K equity (alternative to volume-based entry). Default 0.",
                },
                verified_tier: {
                    type: "string",
                    enum: ["standard", "silver", "gold", "platinum"],
                    description: "Clearing-class compatibility value. Adds 0/10/20/30% taker discount on top of VIP. Maker fee is unaffected by clearing class. Default `standard` = M0.",
                },
                side: {
                    type: "string",
                    enum: ["taker", "maker"],
                    description: "Trade side. Default `taker`. Only takers benefit from clearing-class discount.",
                },
                premium_usd: {
                    type: "number",
                    description: "Trade premium in USD. Used to dollarise the fee and check the 12.5%-of-premium fee cap. Default $100 (callers asking for bps only can ignore).",
                },
                has_builder: {
                    type: "boolean",
                    description: "True if this trade is routed through a registered builder code. When true, the taker fee is split 75% protocol / 25% builder. Default false.",
                },
            },
            required: ["volume_30d_usd"],
        },
    },
    // ── Phase 57301 (2026-05-04) — Paradigm-style OTC primitives ─────────────
    {
        name: "skew_take_best_quote",
        description: "Buyer accepts the current best firm quote on an Auction RFQ. This refunds unused max-premium escrow and marks the auction tape as taken. For fully cleared PM/CM option minting, use the Instant RFQ atomic-fill lane.",
        inputSchema: {
            type: "object",
            properties: {
                auction_pda: {
                    type: "string",
                    description: "Auction PDA pubkey (base58).",
                },
                expected_premium_usd: {
                    type: "number",
                    description: "Premium the trader saw at view time. Front-running guard — rejects with TakeQuotePriceMoved if a tighter quote has arrived between view and submit.",
                },
                expected_premium_micro: {
                    type: "string",
                    description: "Optional exact USDC-micro premium bigint string. If supplied, overrides expected_premium_usd.",
                },
                via_relay: {
                    type: "boolean",
                    description: "Deprecated no-op. Relay-signed take-best-quote remains disabled because only the buyer wallet can sign this direct auction accept.",
                },
            },
            required: ["auction_pda"],
        },
    },
    {
        name: "skew_refresh_quote",
        description: "Refresh the caller/MM's current best quote before close_slot. Requires a detached ed25519 signature over rfq_quote_digest, just like skew_submit_rfq_quote.",
        inputSchema: {
            type: "object",
            properties: {
                auction_pda: {
                    type: "string",
                    description: "Auction PDA (base58).",
                },
                premium_usd: {
                    type: "number",
                    description: "New premium in USD.",
                },
                valid_until_slot: {
                    type: "number",
                    description: "Slot number until which this quote remains valid. Must be ≥ auction.auction_close_slot.",
                },
                mm_signature_b64: {
                    type: "string",
                    description: "ed25519 signature (base58) over rfq_quote_digest. Caller signs externally.",
                },
            },
            required: ["auction_pda", "premium_usd", "valid_until_slot", "mm_signature_b64"],
        },
    },
    {
        name: "skew_publish_axe",
        description: "Publish a live on-chain MakerAxe inventory-intent entry. This is an MM discovery primitive, not settlement; traders use axes to route RFQs to likely counterparties.",
        inputSchema: {
            type: "object",
            properties: {
                axe_id: {
                    type: "number",
                    description: "Caller-supplied PDA seed (must be unique per MM).",
                },
                asset: { type: "number", description: "0=BTC / 1=ETH / 2=SOL / 3=XRP / 4=HYPE." },
                side: { type: "number", enum: [-1, 0, 1], description: "-1 SELL / 0 TWO-WAY / +1 BUY." },
                option_type_mask: {
                    type: "number",
                    description: "Bitmask over OptionType variants (Vanilla=0x01, Digital=0x02, CappedVanilla=0x04, RangeAccrual=0x08, VanillaInverse=0x10, DigitalInverse=0x20). Bits 10..15 reserved.",
                },
                strike_band_lo_usd: { type: "number" },
                strike_band_hi_usd: { type: "number" },
                expiry_band_lo_unix: { type: "number" },
                expiry_band_hi_unix: { type: "number" },
                size_usd: { type: "number" },
                bid_premium_band_lo_usd: { type: "number" },
                bid_premium_band_hi_usd: { type: "number" },
                ask_premium_band_lo_usd: { type: "number" },
                ask_premium_band_hi_usd: { type: "number" },
                valid_until_unix: { type: "number" },
            },
            required: [
                "axe_id",
                "asset",
                "side",
                "option_type_mask",
                "strike_band_lo_usd",
                "strike_band_hi_usd",
                "expiry_band_lo_unix",
                "expiry_band_hi_unix",
                "size_usd",
                "valid_until_unix",
            ],
        },
    },
    {
        name: "skew_update_axe",
        description: "Update a live on-chain MakerAxe inventory-intent entry. Owner/MM wallet only; pass the same mutable band, size, side, and validity fields used by publish.",
        inputSchema: {
            type: "object",
            properties: {
                axe_pda: { type: "string", description: "Existing MakerAxe PDA (base58)." },
                axe_id: {
                    type: "number",
                    description: "Caller-supplied PDA seed originally used for this MakerAxe.",
                },
                asset: { type: "number", description: "0=BTC / 1=ETH / 2=SOL / 3=XRP / 4=HYPE." },
                side: { type: "number", enum: [-1, 0, 1], description: "-1 SELL / 0 TWO-WAY / +1 BUY." },
                option_type_mask: {
                    type: "number",
                    description: "Bitmask over OptionType variants (Vanilla=0x01, Digital=0x02, CappedVanilla=0x04, RangeAccrual=0x08, VanillaInverse=0x10, DigitalInverse=0x20). Bits 10..15 reserved.",
                },
                strike_band_lo_usd: { type: "number" },
                strike_band_hi_usd: { type: "number" },
                expiry_band_lo_unix: { type: "number" },
                expiry_band_hi_unix: { type: "number" },
                size_usd: { type: "number" },
                bid_premium_band_lo_usd: { type: "number" },
                bid_premium_band_hi_usd: { type: "number" },
                ask_premium_band_lo_usd: { type: "number" },
                ask_premium_band_hi_usd: { type: "number" },
                valid_until_unix: { type: "number" },
            },
            required: [
                "axe_pda",
                "axe_id",
                "asset",
                "side",
                "option_type_mask",
                "strike_band_lo_usd",
                "strike_band_hi_usd",
                "expiry_band_lo_unix",
                "expiry_band_hi_unix",
                "size_usd",
                "valid_until_unix",
            ],
        },
    },
    {
        name: "skew_revoke_axe",
        description: "Revoke/close a live MakerAxe entry. Rent returns to the MM wallet.",
        inputSchema: {
            type: "object",
            properties: {
                axe_pda: { type: "string", description: "MakerAxe PDA (base58)." },
            },
            required: ["axe_pda"],
        },
    },
];
export function getSkewMcpProfile(raw) {
    if (raw === "trading" ||
        raw === "rfq" ||
        raw === "advanced" ||
        raw === "governance" ||
        raw === "all")
        return raw;
    return "core";
}
export function getSkewTools(profile) {
    const tools = SKEW_TOOLS.filter((tool) => {
        if (DEPRECATED_TOOL_NAMES.has(tool.name))
            return false;
        if (profile === "all")
            return true;
        if (profile === "core")
            return CORE_TOOL_NAMES.has(tool.name);
        if (profile === "trading")
            return TRADING_TOOL_NAMES.has(tool.name);
        if (profile === "rfq")
            return RFQ_TOOL_NAMES.has(tool.name);
        if (profile === "governance")
            return GOVERNANCE_TOOL_NAMES.has(tool.name);
        return !GOVERNANCE_ONLY_TOOL_NAMES.has(tool.name);
    });
    if (profile === "core")
        return orderTools(tools, CORE_TOOL_ORDER);
    if (profile === "trading")
        return orderTools(tools, TRADING_TOOL_ORDER);
    if (profile === "rfq")
        return orderTools(tools, RFQ_TOOL_ORDER);
    if (profile === "governance")
        return orderTools(tools, GOVERNANCE_TOOL_ORDER);
    return tools;
}
function orderTools(tools, order) {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    return order
        .map((name) => byName.get(name))
        .filter((tool) => tool !== undefined);
}
//# sourceMappingURL=tools.js.map