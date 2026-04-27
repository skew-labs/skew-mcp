# @skew-labs/mcp — Skew MCP Server

> **AI agents create, price, settle, and analyze Solana options on Skew via the [Model Context Protocol](https://modelcontextprotocol.io/).**

Drop this server into your Cursor, Claude Desktop, or Copilot config and your editor gains nine tools that drive the Skew protocol end-to-end.

---

## Tools

### Read tools (no wallet required)

| Tool | Description |
|---|---|
| `skew_get_spot` | Live BTC/ETH/SOL/XRP/HYPE spot via Pyth Hermes |
| `skew_get_fair_value` | Suggested fair-value premium for an option (Greeks included) |
| `skew_list_options` | Enumerate on-chain option PDAs |
| `skew_get_iv_smile` | IV smile across a strike ladder for one expiry, plus 25-delta risk-reversal and butterfly |
| `skew_get_term_structure` | ATM IV across the 7d / 14d / 30d / 60d / 90d / 180d expiry ladder |
| `skew_get_volatility_summary` | One-shot vol view: spot, ATM 30d IV, smile skew, term-structure shape, vol-view label |

### Write tools (require `SKEW_PRIVATE_KEY`)

| Tool | Description |
|---|---|
| `skew_create_option` | Issue a new option + deposit USDC collateral |
| `skew_buy_option` | Pay premium and receive the option SPL token |
| `skew_settle_option` | Settle an expired option via Pyth |

---

## Cursor — quick install

Add to your `.cursor/mcp.json` (project-level) or Cursor Settings → MCP (global):

```json
{
  "mcpServers": {
    "skew": {
      "command": "node",
      "args": ["<path-to-repo>/skew/skew-mcp/dist/server.js"],
      "env": {
        "SKEW_RPC_URL": "https://api.devnet.solana.com",
        "SKEW_PRIVATE_KEY": "<base58 devnet key — devnet only>",
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

One prompt. Two on-chain transactions. ~60 seconds.

Or, just ask the agent for a market view:

> **"How do you see BTC vol next week?"**

The model calls `skew_get_volatility_summary` and reports the current ATM 30-day IV, smile skew, the 7d/30d/90d term structure, and a generic vol-view label (`stable` / `elevated` / `compressing` / `expanding`).

The IV value is read directly from the on-chain volatility-state PDA when the account is initialised (`iv_source.source: "on-chain-povs"`), with a `last_update_minutes_ago` field showing freshness. On a fresh devnet deploy where the account hasn't been seeded yet, the response falls back to a per-asset heuristic surface labelled `iv_source.source: "heuristic-v1"` — same response shape, transparent about provenance.

---

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "skew": {
      "command": "node",
      "args": ["<path-to-repo>/skew/skew-mcp/dist/server.js"],
      "env": {
        "SKEW_RPC_URL": "https://api.devnet.solana.com",
        "SKEW_PRIVATE_KEY": "<base58 devnet key — devnet only>"
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
| `SKEW_PRIVATE_KEY` | For write tools | — | Base58 wallet key (devnet only — see warning below) |
| `SKEW_RPC_URL` | No | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `SKEW_PRICING_URL` | No | `https://skew-pricing.fly.dev` | Fair-value HTTP API |
| `SKEW_DEVNET_USDC_MINT` | No | `4T2KU8...K8` | Devnet USDC mint |

> **Devnet only.** Never paste a mainnet private key. The MCP server runs on your machine — your editor sees the key. Use a fresh devnet keypair.

---

## Build from source

```bash
cd skew/skew-mcp
pnpm install
pnpm run build
# server: dist/server.js
```

---

## Why it matters

Every other Solana protocol assumes a human in the loop — open the dApp, sign a tx, repeat. Skew's MCP server lets an agent drive the same protocol with no UI in the middle.

You can:
- Hand a Cursor session a strategy prompt and walk away.
- Wire the tools into a long-running scheduler that maintains a delta-hedge.
- Let a research notebook iterate over strategies with real on-chain feedback.

The point is: **the SDK is for bots, the MCP server is for agents.** Same protocol, different verbs.

---

## License

MIT. © Skew Labs.
