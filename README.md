# @skew-labs/mcp

MCP server for Skew — the venue-only Solana on-chain OTC options protocol.
Devnet launch-ready, audit-gated.

Install the current npm release with `npx -y @skew-labs/mcp@latest`.
The package backs the same `skew-master` Anchor
program (123 ix · devnet `3w2qSp1UnuTbTfdHPXxm3zZaz6JZRmPpbmHf56Y1DsgK`) as
`@skew-labs/sdk` `0.7.8+`.

The server lets AI agents read market data, estimate pricing and margin, and
inspect option, RFQ, collateral-policy, and clearing-member state through the
[Model Context Protocol](https://modelcontextprotocol.io/). The default profile
is deliberately read-only. Trading, RFQ, wider builder, and governance write
surfaces require explicit profiles and a configured keypair.

[![npm](https://img.shields.io/npm/v/@skew-labs/mcp?style=flat-square)](https://www.npmjs.com/package/@skew-labs/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## Agent Playbook

Every Skew MCP session should begin with the same two calls:

1. `skew_get_signer_info`
   - Confirms whether this MCP server can write.
   - Shows the signer public key when a local keypair is configured.
   - If `write_tools_enabled=false`, the agent must stay read-only or give
     wallet-mediated SDK/API instructions.
2. `skew_get_capabilities`
   - Returns supported assets, payoff names, collateral rails, tenor policy,
     profile counts, and an embedded `mcp.agentGuide`.
   - The embedded guide is the source of truth for lane selection when an
     agent has not read this README.

Do not let an agent infer the signer from chat text. A write workflow is valid
only when `skew_get_signer_info.signer_pubkey` matches the intended devnet
wallet.

### Lane Selection

| User intent | Correct MCP lane | Tools |
|---|---|---|
| Read markets, margin, collateral policy, RFQ tape, secondary tape | Core read profile | `skew_get_capabilities`, `skew_fetch_collateral_policy`, `skew_list_rfq_auctions`, `skew_list_secondary_listings`, `skew_fetch_portfolio` |
| Buyer wants PM-backed issuance now | Instant RFQ atomic fill | Buyer: `skew_request_instant_rfq_quotes` → `skew_hit_instant_rfq_quote`; maker terminal: `skew_serve_instant_rfq_mm_once` |
| Buyer starts from an Auction RFQ PDA but wants PM-backed issuance | Auction terms → Instant RFQ bridge | `skew_request_instant_rfq_from_auction` → `skew_hit_instant_rfq_from_auction_quote` |
| Buyer wants price discovery / firm quote tape | Auction RFQ | `skew_register_rfq_auction`, `skew_submit_rfq_quote_direct`, `skew_finalize_rfq_auction` |
| Buyer and seller intentionally use fully funded legacy issuance | Advanced-only pre-funded bridge | `SKEW_MCP_PROFILE=advanced`; maker: `skew_create_option_from_rfq_quote`; buyer: `skew_buy_option_from_rfq_quote` |
| Seller lists an existing option | Secondary discovery tape | Seller: `skew_create_secondary_listing`; buyer: `skew_buy_secondary_listing`; seller delivery: `skew_transfer_option` |

### Receipt Rules

Agents should report success only after readback:

- RFQ request visible: auction PDA or relay nonce appears in the tape.
- PM-backed fill complete: response includes transaction signature, option
  PDA, buyer-long readback, maker-short/CM registry readback, and margin or PM
  preflight data.
- Trading receipts include normalized `execution_lane`, `trade_state`,
  `clearing_state`, `pm_backed`, `pm_guarantee`, `registry_updated`, and
  when relevant `rejection_reason`. Agents should report these fields instead
  of inferring lifecycle state from a tx signature alone.
- Auction finalize complete: report firm tape/refund status only. It is not an
  option mint by itself.
- Secondary payment complete: report pending delivery until
  `skew_transfer_option` returns `readback_ok=true` and the buyer is the option
  holder.

### Things Agents Must Not Say

- Do not say `finalize_rfq_auction` minted an option.
- Do not use the quote-bound pre-funded bridge for official Auction execution.
- Do not say a secondary listing is delivered after payment alone.
- Do not say a local script or smoke test proves MCP product success.
- Do not continue a write workflow when `skew_get_signer_info` shows the wrong
  signer or no write signer.

## Scope

Skew MCP is profile-gated because agents choose tools better when the visible surface is coherent.

| Profile | Set with `SKEW_MCP_PROFILE` | Visible tools | Intended user |
|---|---:|---:|---|
| `core` | default | 20 | First-time builders, desks, and evaluation sessions |
| `trading` | `trading` | 41 | Core + lifecycle write tools (create / buy / settle / CM bootstrap). Quote-bound Auction bridge tools stay advanced-only. |
| `rfq` | `rfq` | 43 | Core + auction RFQ, Instant RFQ, maker quote, and secondary trade tools. Official Auction execution uses the Instant PM handoff. |
| `advanced` | `advanced` | 114 | Builders operating conditional, combo, vault, builder, series, and snapshot workflows |
| `governance` | `governance` | 8 | Explicit admin/governance sessions only |
| `all` | `all` | 119 | Internal development and audit checks |

The current IDL exposes Auction RFQ direct quote, `refresh_quote`, and the MakerAxe instruction family. Write tools remain hidden at runtime unless local signing mode is active and `SKEW_KEYPAIR_PATH`, `KEYPAIR_PATH`, or `SKEW_PRIVATE_KEY` is configured.
Four unsafe/state-only actions are hidden from every profile until their complete settlement routes ship: `skew_take_best_quote`, `skew_apply_early_exercise_action`, `skew_apply_sell_via_rfq_action`, and `skew_apply_buyback_via_rfq_action`. The legacy quote-bound pre-funded bridge remains available only in `advanced` / `all`; it is hidden from `trading` and `rfq` so Auction settlement routes through Instant PM fill. Stale clients receive a typed `ToolDisabled` error.

> Counts above are sourced from `src/tools.ts` (`CORE_TOOL_ORDER`, `TRADING_TOOL_ORDER`, `RFQ_TOOL_ORDER`, `GOVERNANCE_TOOL_ORDER`, `DEPRECATED_TOOL_NAMES`, `GOVERNANCE_ONLY_TOOL_NAMES`). Cross-referenced in `docs/audit/W29_MCP_PRICING_INDEXER_WEB_ALIGNMENT_2026-05-09.md` §1. Re-verify with: `node -e 'import("./dist/tools.js").then(m=>["core","trading","rfq","advanced","governance","all"].forEach(p=>console.log(p, m.getSkewTools(p).length)))'`.

What the **core profile** covers:
- Capability discovery — supported assets, 11 payoff names, collateral rails, tenor policy, and trade lanes (`skew_get_capabilities`)
- Market data — spot, IV smile, term structure, and volatility summary
- Pricing + margin — fair value, one-line margin, margin breakdown, v5.1 fee estimate, and live collateral-policy reads
- Portfolio and option inventory readback
- Auction RFQ tape — list auctions, fetch one auction, and list quotes
- Secondary tape — list active and historical listings
- Clearing member basics — fetch CM account state only

What MCP **does not** cover:
- Liquidation / ADL / clawback / IF replenishment cranks (keeper-side, not user-side).
- Auction-lane one-click HIT. `skew_take_best_quote` is hidden at launch because it does not complete option mint/close semantics; cleared PM/CM option minting routes through Instant RFQ atomic fill.

If you need any of those, hit `@skew-labs/sdk` directly — see the `Methods` table at <https://github.com/skew-labs/skew/tree/main/skew/skew-sdk#methods>.

For programmatic RFQ integrations, the canonical flow is the SDK facade
documented at <https://github.com/skew-labs/skew/blob/main/docs/api/official-rfq.md>:
`skew.rfq.request() -> rfq.quotes() -> rfq.accept()`. If the user starts with
Auction discovery, use `skew.rfq.auctionAndFill()` or the MCP
`skew_request_instant_rfq_from_auction -> skew_hit_instant_rfq_from_auction_quote`
handoff; both force settlement through Instant RFQ `atomic_fill_from_relay`.
MCP exposes the same Instant RFQ lane for agents, but SDK is the cleanest
surface for production bots and institutional integrations.

---

## Public Terminology

Agents should describe Skew as Solana OTC clearing infrastructure in a devnet
launch-ready, mainnet audit-gated posture. Public responses should label
margin-mode ranks as `M0`, `M1`, `M2`, and `M3`.

Some tool JSON may still expose compatibility names such as `tier` or
`verified_tier`. Treat those as rank fields and render the public label as
`M0` through `M3` in user-facing output.

---

## Core Tools (20)

The default profile is the surface most users should install first. All 20 are read-only — no keypair required.

### Discovery

`skew_get_capabilities`, `skew_get_signer_info`.

`skew_get_signer_info` is the first tool to call before any write workflow. It
returns the active signing mode, signer public key when a local write key is
configured, profile, visible tool count, and warnings. This is how an agent
proves that fees and collateral will come from the user's own configured
devnet keypair.

### Market data

`skew_get_spot`, `skew_get_iv_smile`, `skew_get_term_structure`, `skew_get_volatility_summary`.

### Pricing and margin

`skew_get_fair_value`, `skew_get_margin_breakdown`, `skew_estimate_fee`, `skew_fetch_collateral_policy`, `skew_fetch_pm_cache`, `skew_preview_incremental_margin`, `skew_list_rent_reclaimable`.

`skew_fetch_collateral_policy` is the runtime mint allowlist. `skew_get_capabilities`
describes what Skew can support; the policy PDA describes what this deployment
currently accepts. Agents should call it before routing wSOL/jitoSOL or custom
devnet mints.

`skew_get_capabilities.tenorPolicy` is the runtime-safe expiry guide for write
tools. Live create/fill paths accept asset-specific buckets with +/-1h
tolerance: BTC/ETH/SOL support 1d / 7d / 14d / 28d / 90d, XRP supports
7d / 14d / 28d, and HYPE supports 1d / 7d / 14d / 28d. Sub-1d binaries are
intentionally not enabled.

`skew_fetch_pm_cache` reports the registry-hash-pinned CM risk cache state.
Agents should treat `usable=false` as a hard blocker and route through
`skew_refresh_pm_cache_full` or the full-walk path. The cache is a hot-path
optimization with full-walk audit fallback, not off-chain margin.

`skew_list_rent_reclaimable` exposes owner-first PDA close candidates and
their blockers. It never claims an account can be closed if a holder claim,
locked collateral quantity, liquidation hold, or slashable maker state remains.

### Pre-funded marketplace (read)

`skew_list_options`.

### Auction RFQ Tape (read)

`skew_list_rfq_auctions`, `skew_fetch_rfq_auction`, `skew_list_rfq_quotes`.

This is the read snapshot of the public price-discovery lane. Write-side RFQ
tools (`skew_register_rfq_auction`, `skew_register_rfq_maker`,
`skew_submit_rfq_quote`, `skew_submit_rfq_quote_direct`,
`skew_finalize_rfq_auction`, `skew_cancel_rfq_auction`) live in the `rfq`
profile. PM-backed one-click issuance uses the separate Instant RFQ relay lane:
`buyer_accept -> cm_sign -> buyer_tx_signed -> atomic_fill_from_relay`.
For live demos and human approval, MCP Instant RFQ tools now allow a 10 minute
window: quote collection defaults to 60 seconds and can be set to
`timeout_ms=600000`; maker one-shot serving and quote/digest validity default
to 600 seconds.

### Secondary Tape (read)

`skew_list_secondary_listings`.

This is the public discovery tape for existing options. It is not an escrowed
orderbook. A buyer can pay or accept terms with `skew_buy_secondary_listing`,
but delivery is complete only after the seller calls `skew_transfer_option` and
the tool returns `readback_ok=true`.

### Clearing member basics (read)

`skew_fetch_clearing_member`.

Write-side lifecycle tools (`skew_create_option`, `skew_buy_option`, `skew_settle_option`, `skew_register_clearing_member`, `skew_cm_add_collateral`, `skew_refresh_pm_cache_full`, `skew_prepare_rent_reclaim_batch`) live in the `trading` profile.

## Advanced And Governance Profiles

Use `SKEW_MCP_PROFILE=advanced` when you intentionally want the wider builder surface: conditional/OCO, combo intents, isolated margin, LST and native SOL vaults, builder codes, series listings, extra volatility tools, and read snapshots.

Use `SKEW_MCP_PROFILE=governance` for explicit admin sessions. This profile is intentionally small and separate from normal builder workflows.

For volatility snapshots, `skew_fetch_dvol` accepts the same asset selectors
agents use elsewhere: `underlying` or `asset` as `BTC|ETH|SOL|XRP|HYPE`, or
`assetIdx` / `asset_idx` as `0..4`.

### Conditional / SL+TP execution posture

The MCP conditional surface is deliberately executable-only. It exposes
`CloseIsolatedPosition` for SL/TP/OCO because that path performs the live
on-chain CPI: `register_conditional_order -> execute_conditional_order ->
apply_close_isolated_action`.

`SellViaRfq`, `EarlyExercise`, and `BuybackViaRfq` remain SDK-level
fail-closed intent/state paths until their direct CPI routes ship. MCP rejects
those actions instead of making an agent demo look executable when no fill is
sent.

For keeper demos, `skew_execute_conditional_order` reads the stored
`ConditionalOrderPda` to recover the original Pyth oracle and action target.
You can still pass `trigger_oracle` and `action_target` explicitly for
stateless cranks.

---

## Cursor — quick install

Add to your `.cursor/mcp.json` (project-level) or Cursor Settings → MCP (global):

```json
{
  "mcpServers": {
    "skew": {
      "command": "npx",
      "args": ["-y", "@skew-labs/mcp@latest"],
      "env": {
        "SKEW_MCP_PROFILE": "trading",
        "SKEW_RPC_URL": "https://api.devnet.solana.com",
        "SKEW_KEYPAIR_PATH": "~/.config/solana/devnet.json",
        "SKEW_DEVNET_USDC_MINT": "4T2KU8PXd25XvMh6kzv3F7d55yPP6NcS7HemERBe97K8"
      }
    }
  }
}
```

Then in Cursor chat:

> **"Build me a BTC delta-neutral straddle, $1K notional, expiring next Friday."**

The model:
1. Calls `skew_get_spot` to read BTC.
2. Calls `skew_get_fair_value` for the ATM call and put.
3. Calls `skew_create_option` twice — call + put at the spot strike.
4. Reports net premium and the two transaction signatures.

The agent returns the proposed transactions and signatures with the same
provenance fields exposed by the terminal.

Or, just ask the agent for a market view:

> **"How do you see BTC vol next week?"**

The model calls `skew_get_volatility_summary` and reports the current ATM 30-day IV, smile skew, the 7d/30d/90d term structure, and a generic vol-view label (`stable` / `elevated` / `compressing` / `expanding`).

The IV value is read directly from the on-chain `PoVSState` PDA when the account is initialised (`iv_source.source: "on-chain-povs"`), with a `last_update_minutes_ago` field showing freshness. On a fresh devnet deploy where the account hasn't been seeded yet, the response falls back to a per-asset heuristic surface labelled `iv_source.source: "heuristic-v1"` — same response shape, transparent about provenance. Settlement remains Pyth-only; MCP volatility tools are advisory reads.

Write tools also accept simulation-first flows where exposed. For example,
`skew_create_option` supports `dry_run: true`, `simulate: true`, or
`simulate_only: true`; it
returns the combined create+deposit simulation logs and compute units without
sending a transaction.

MCP transports JSON as `content[0].text`. Tool responses are deliberately valid
JSON strings so agents can `JSON.parse` once and continue with typed fields.

---

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "skew": {
      "command": "npx",
      "args": ["-y", "@skew-labs/mcp@latest"],
      "env": {
        "SKEW_MCP_PROFILE": "core",
        "SKEW_RPC_URL": "https://api.devnet.solana.com",
        "SKEW_KEYPAIR_PATH": "~/.config/solana/devnet.json"
      }
    }
  }
}
```

Restart Claude Desktop. The Skew tools appear in the tool picker.

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SKEW_SIGNING_MODE` | No | `local` | `local` exposes write tools only when a local key is configured. `hosted` / `hosted_unsigned` hides write tools so a shared server cannot sign with one omnibus key |
| `SKEW_KEYPAIR_PATH` / `KEYPAIR_PATH` | For local write tools | — | Path to the user's Solana keypair JSON, e.g. `~/.config/solana/devnet.json`. Preferred for local devnet sessions and used before `SKEW_PRIVATE_KEY` when both are present |
| `SKEW_PRIVATE_KEY` | For local write tools | — | Base58-encoded Solana secret key. Use only for isolated devnet keys. Prefer `SKEW_KEYPAIR_PATH` |
| `SKEW_MCP_PROFILE` | No | `core` | Tool surface: `core`, `trading`, `rfq`, `advanced`, `governance`, or `all` |
| `SKEW_RPC_URL` | No | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `SKEW_PRICING_URL` | No | `https://skew-pricing.fly.dev` | Fair-value HTTP API |
| `SKEW_DEVNET_USDC_MINT` | No | `4T2KU8...K8` | Devnet USDC mint |

> **Devnet only.** Never paste a mainnet private key. In local signing mode the
> MCP server runs on your machine and signs with your configured keypair. In
> hosted mode, do not configure a server private key; return unsigned
> transactions through the SDK/API and let the user's wallet, HSM, or bot sign.
> Use `skew_get_signer_info` to verify the signer before sending any write tool.

For lower cold-start latency in demos, install the binary once and point the
editor at `skew-mcp` instead of spawning `npx` each session:

```bash
npm i -g @skew-labs/mcp
skew-mcp
```

---

## Build from source

```bash
cd skew/skew-mcp
pnpm install
pnpm run build
# server: dist/server.js
```

---

## Operating Posture

MCP is an agent interface, not a custody workaround. The default posture is
local signer mode: each user runs the server in their own editor process and
sets `SKEW_KEYPAIR_PATH` to their own devnet keypair. A shared hosted MCP
server must use `SKEW_SIGNING_MODE=hosted`; write tools are hidden in that mode
so one server key cannot trade for multiple users. For production integrations,
prefer wallet-mediated SDK flows or a dedicated signing service with explicit
policy checks.

The design split is simple: **the SDK is for bots, the MCP server is for
agents.** Same protocol, different operating surface.

---

## License

MIT. © Skew Labs.
