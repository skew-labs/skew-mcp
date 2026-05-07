# @skew-labs/mcp

MCP server for Skew, the Solana OTC options clearing infrastructure.

The server lets AI agents read market data, estimate pricing and margin, create
pre-funded options, operate Auction RFQ, and inspect clearing-member state
through the [Model Context Protocol](https://modelcontextprotocol.io/). The
default profile is deliberately small: **23 core tools**. Wider builder and
governance surfaces require explicit profiles.

[![npm](https://img.shields.io/npm/v/@skew-labs/mcp?style=flat-square)](https://www.npmjs.com/package/@skew-labs/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## Scope

Skew MCP is profile-gated because agents choose tools better when the visible surface is coherent.

| Profile | Set with `SKEW_MCP_PROFILE` | Visible tools | Intended user |
|---|---:|---:|---|
| `core` | default | 23 | First-time builders, desks, and evaluation sessions |
| `advanced` | `advanced` | 89 | Builders operating conditional, combo, vault, builder, series, and snapshot workflows |
| `governance` | `governance` | 8 | Explicit admin/governance sessions only |
| `all` | `all` | 94 | Internal development and audit checks |

Four retired compatibility stubs are intentionally hidden from every profile: `skew_take_best_quote`, `skew_refresh_quote`, `skew_publish_axe`, and `skew_revoke_axe`. The current on-chain IDL does not expose those instructions.

What the **core profile** covers:
- Capability discovery — supported assets, 11 payoff names, collateral rails, and trade lanes (`skew_get_capabilities`)
- Market data — spot, IV smile, term structure, and volatility summary
- Pricing + margin — fair value, one-line margin, margin breakdown, v5.1 fee estimate, and live collateral-policy reads
- Pre-funded marketplace — list, create, buy, and settle options
- Auction RFQ — register RFQ, register maker, submit quote, finalize, cancel, and fetch RFQ account state
- Clearing member basics — register CM, add collateral, fetch CM account state

What MCP **does not** cover (use `@skew-labs/sdk` directly):
- Liquidation / ADL / clawback / IF replenishment cranks (keeper-side, not user-side).

If you need any of those, hit `@skew-labs/sdk` directly — see the `Methods` table at <https://github.com/skew-labs/skew/tree/main/skew/skew-sdk#methods>.

---

## Core Tools (23)

The default profile is the surface most users should install first.

### Discovery

`skew_get_capabilities`.

### Market data

`skew_get_spot`, `skew_get_iv_smile`, `skew_get_term_structure`, `skew_get_volatility_summary`.

### Pricing and margin

`skew_get_fair_value`, `skew_get_margin`, `skew_get_margin_breakdown`, `skew_estimate_fee`, `skew_fetch_collateral_policy`.

`skew_fetch_collateral_policy` is the runtime mint allowlist. `skew_get_capabilities`
describes what Skew can support; the policy PDA describes what this deployment
currently accepts. Agents should call it before routing wSOL/jitoSOL or custom
devnet mints.

### Pre-funded marketplace

`skew_list_options`, `skew_create_option`, `skew_buy_option`, `skew_settle_option`.

### Auction RFQ

`skew_register_rfq_auction`, `skew_register_rfq_maker`, `skew_submit_rfq_quote`, `skew_finalize_rfq_auction`, `skew_cancel_rfq_auction`, `skew_fetch_rfq_auction`.

This is the public price-discovery lane. One-click HIT uses the separate Instant RFQ relay lane in the SDK: `buyer_accept -> cm_sign -> buyer_tx_signed -> atomic_fill_from_relay`.

### Clearing member basics

`skew_register_clearing_member`, `skew_cm_add_collateral`, `skew_fetch_clearing_member`.

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
      "args": ["-y", "@skew-labs/mcp"],
      "env": {
        "SKEW_MCP_PROFILE": "core",
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
      "args": ["-y", "@skew-labs/mcp"],
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
| `SKEW_KEYPAIR_PATH` / `KEYPAIR_PATH` | For write tools | — | Path to a Solana keypair JSON, e.g. `~/.config/solana/devnet.json`. Preferred for local devnet sessions |
| `SKEW_PRIVATE_KEY` | For write tools | — | Base58-encoded Solana secret key. Use only for isolated devnet keys; if both write-key envs are set, this takes precedence |
| `SKEW_MCP_PROFILE` | No | `core` | Tool surface: `core`, `advanced`, `governance`, or `all` |
| `SKEW_RPC_URL` | No | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `SKEW_PRICING_URL` | No | `https://skew-pricing.fly.dev` | Fair-value HTTP API |
| `SKEW_DEVNET_USDC_MINT` | No | `4T2KU8...K8` | Devnet USDC mint |

> **Devnet only.** Never paste a mainnet private key. The MCP server runs on your machine — your editor sees the key. Use a fresh devnet keypair.

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

MCP is an agent interface, not a custody workaround. Write tools require
`SKEW_KEYPAIR_PATH` or `SKEW_PRIVATE_KEY`, and the server runs locally in the user's editor process.
Use devnet keys by default. For production integrations, prefer wallet-mediated
SDK flows or a dedicated signing service with explicit policy checks.

The design split is simple: **the SDK is for bots, the MCP server is for
agents.** Same protocol, different operating surface.

---

## License

MIT. © Skew Labs.
