# ArenaAgent

> **X Layer Arena · Build X Hackathon submission**

ArenaAgent turns competitions into autonomous on-chain economic systems, where entry, participation, and payouts are fully managed by an AI agent.

ArenaAgent is an autonomous on-chain competition operator deployed on X Layer. It can create, manage, and settle competitive environments without human intervention. An on-chain operator wallet (Agentic Wallet) manages the full lifecycle of paid competitive arenas: creation → join → play → score → rank → reward settlement. Players can enter arenas using any supported token. The agent evaluates wallet balances and recommends funding paths using live routing integrations, and entry verification is supported via the x402 payment protocol for machine-to-machine proof-of-payment.

## Why ArenaAgent Matters

Most online competitions still rely on:

- manual trust
- centralized orchestration
- off-chain payouts

ArenaAgent replaces that model with:

- trust-minimized on-chain settlement
- agent-driven competition orchestration
- token-agnostic entry via live routing

This enables a new class of applications: competitive economies that can run autonomously on X Layer.

## Agent Decision Layer

ArenaAgent is not just executing actions, it continuously evaluates state and makes decisions across the competition lifecycle.

ArenaAgent actively reasons about:

- user wallet balances
- required settlement tokens
- optimal swap routes across live liquidity providers
- join execution path selection
- payment verification via x402
- arena close and payout timing

Example decision flow:

```text
User wants to join a USDC-settled arena
→ wallet holds OKB
→ agent evaluates available routes
→ agent selects the best OKB → USDC path
→ agent confirms join eligibility
→ agent executes or guides the final entry flow
```

## Example Use Case: Trading Arena

Users join a 1-hour trading competition with an on-chain entry fee.

ArenaAgent:

- opens the arena and enforces the timer
- evaluates how each player can fund entry
- routes tokens into the correct settlement asset
- records scores from an external results source
- finalizes the winner on-chain and executes payout, with fallback claim support if needed

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend (React + Vite)                                        │
│  • Agentic Wallet panel  • Operator chat  • Play flow          │
│  • x402 join  • Route inspector  • Leaderboard  • Claim        │
└───────────────────┬─────────────────────────────────────────────┘
                    │ REST
┌───────────────────▼─────────────────────────────────────────────┐
│  Backend Operator Service (Node.js + Express + TypeScript)      │
│                                                                 │
│  AgentWalletService  ← Agentic Wallet identity                  │
│  OperatorService     ← LLM/rules operator chat                  │
│  ArenaMonitor        ← Polling loop: close + finalize           │
│  RouteRecommendation ← Uniswap API + OKX DEX aggregator         │
│  WalletInspection    ← On-chain balance reader                  │
│  X402 join endpoint  ← 402 challenge + on-chain proof verify    │
│  StateStore          ← JSON persistence (scores, events)        │
└───────────────────┬─────────────────────────────────────────────┘
                    │ ethers v6 / JSON-RPC
┌───────────────────▼─────────────────────────────────────────────┐
│  AgenticCompetitionEngine.sol (Solidity 0.8.24)                 │
│  createArena · joinArena · submitScore · closeArena             │
│  finalizeArena · claim                                          │
│  Deployed on X Layer (see Deployment section)                   │
└─────────────────────────────────────────────────────────────────┘
```

External integrations:

| Integration | Purpose |
|---|---|
| Uniswap Trading API | Live swap quotes for token-to-settlement routing |
| OKX DEX Aggregator (Onchain OS) | Optional route quote and swap transaction fallback for supported token pairs |
| OKX Onchain OS API (HMAC-signed) | Signed access to OKX DEX aggregation endpoints used by the routing layer |
| x402 Payment Protocol | HTTP 402 payment challenges + on-chain tx proof verification |
| OpenAI-compatible LLM | Natural-language operator intent parsing (optional) |

---

## Deployment

| Network | Contract Address |
|---|---|
| X Layer Mainnet (Chain 196) | `0xD058F2228463277E38c093CC50ad42677e0DfbE8` |
| X Layer Testnet (Chain 195) | Not deployed |
| Local Hardhat | Local development only |

After deployment, set `CONTRACT_ADDRESS` and `APP_CHAIN_ID` in `backend/.env`.

---

## Onchain OS / Uniswap Skill Usage

### Uniswap — `swap-integration` skill

The backend `UniswapTradeService` calls the Uniswap Trading API (`trade-api.gateway.uniswap.org/v1`) to fetch live swap quotes for any `fromToken → settlementToken` pair. The integration follows the documented flow:

1. `POST /quote` — EXACT_INPUT quote with auto-slippage and BEST_PRICE routing
2. Route returned to the user with gas estimate, route string, and a quoteId
3. User signs the swap + join transaction in their own wallet (non-custodial)

Set `UNISWAP_API_KEY` to activate live quotes. Without it, the system falls back to shape-correct estimation using token rate metadata.

### OKX / Onchain OS integration

The backend `OnchainOsService` uses HMAC-SHA256 signed requests to the OKX DEX Aggregator API:

```
GET /api/v5/dex/aggregator/quote
Headers: OK-ACCESS-KEY · OK-ACCESS-SIGN · OK-ACCESS-TIMESTAMP · OK-ACCESS-PASSPHRASE
```

- When Onchain OS credentials are configured, the routing layer can request OKX DEX quotes and build swap transactions for supported token pairs on X Layer.
- The route recommender uses this integration as an additional live liquidity source alongside Uniswap, allowing ArenaAgent to compare available execution paths before presenting a swap-and-join plan.
- The **Agentic Wallet** (`AgentWalletService`) derives its identity from the operator private key and exposes it at `GET /agent/wallet`, while wallet balance inspection is provided by the backend balance inspection pipeline and optional OKLink enrichment.

Set `ONCHAIN_OS_API_KEY`, `ONCHAIN_OS_SECRET_KEY`, and `ONCHAIN_OS_PASSPHRASE` to activate.

### x402 Payment Flow

The `POST /arena/:id/x402-join` endpoint implements the x402 payment standard:

1. Without `X-Payment-Proof` header → `402 Payment Required` response with payment requirements (scheme, network, amount, payTo, asset, contract method)
2. User calls `joinArena(arenaId)` on-chain with the exact entry fee
3. With `X-Payment-Proof: <txHash>` header → backend verifies the tx on-chain (receipt status, destination contract) and returns proof confirmation

This is visible to agent judges via on-chain transaction history.

---

## Working Mechanics

```
Operator creates an arena (entry fee + duration)
          ↓
Player connects wallet → Agent inspects token balances
          ↓
Agent recommends best route (Uniswap quote or OKX DEX quote)
          ↓
Player joins via direct join or x402 payment flow
          ↓
Scores are submitted by the operator (off-platform game result)
          ↓
ArenaMonitor polls → auto-closes arena after endTime
          ↓
ArenaMonitor finalizes the top winner on-chain and executes payout, with fallback claim support if needed
          ↓
If automatic payout fails, a fallback claim() remains available for the winner
```

**Operator Chat**: Natural language commands via `POST /operator/chat`. With `OPENAI_API_KEY`, intents are parsed by an LLM. Without it, a deterministic rules engine handles: create arena, close, finalize, leaderboard summary, explain payouts.

---

## Local Setup

### 1. Install

```powershell
Set-Location .\contracts; npm install
Set-Location ..\backend;  npm install
Set-Location ..\frontend; npm install
```

### 2. Run local chain

```powershell
Set-Location .\contracts
npx hardhat node
```

### 3. Deploy contract

```powershell
npx hardhat run scripts/deploy.ts --network localhost
```

### 4. Configure backend

```powershell
Copy-Item backend\.env.example backend\.env
# Edit backend\.env: set PRIVATE_KEY, CONTRACT_ADDRESS, RPC_URL
```

### 5. Start backend

```powershell
Set-Location .\backend; npm run dev
```

### 6. Start frontend

```powershell
Set-Location .\frontend
Copy-Item .env.example .env
# Set VITE_CONTRACT_ADDRESS
npm run dev
```

### Deploy to X Layer Testnet

```powershell
# Add PRIVATE_KEY and XLAYER_TESTNET_RPC_URL to contracts\.env or shell.
Set-Location .\contracts
npx hardhat run scripts/deploy.ts --network xlayer_testnet
```

---

## API Reference

| Method | Path | Description |
|---|---|---|
| GET | `/agent/wallet` | Agentic Wallet identity (address, chain, skills, integrations) |
| GET | `/arena` | List all arenas |
| POST | `/arena` | Create arena `{ entryFeeWei, durationSeconds, settlementTokenSymbol, title?, game?, metric? }` |
| POST | `/arena/:id/join` | Prepare join — returns contract address and entry fee |
| POST | `/arena/:id/routes` | Wallet balance inspection + swap route recommendation for `{ user, customTokens? }` |
| POST | `/arena/:id/x402-join` | x402 join: no header → 402, with `X-Payment-Proof` → verify |
| POST | `/arena/:id/score` | Submit player score (operator only in production) |
| GET | `/arena/:id/leaderboard` | Ranked leaderboard for the arena |
| POST | `/arena/:id/swap-and-join` | Build swap + join plan for an external wallet or client app |
| GET | `/wallet/balances?user=` | Inspect wallet balances without arena context |
| GET | `/operator/status` | AI/rules mode, skills, integration status |
| GET | `/operator/history` | Recent operator events |
| POST | `/operator/chat` | Natural-language operator command |
| GET | `/health` | Health check |

---

## SDK

ArenaAgent now includes a minimal TypeScript SDK for external apps in `sdk/src/index.ts`.

Primary client methods:

- `listArenas()`
- `createArena()`
- `createArenaFromPrompt()`
- `getActivityFeed()`
- `prepareJoin()`
- `getArenaRoutes()`
- `buildSwapAndJoin()`
- `submitScore()`
- `getLeaderboard()`
- `chatWithOperator()`
- `getOperatorHistory()`
- `getAgentWallet()`
- `getWalletBalances()`
- `getX402Requirements()`
- `verifyX402Payment()`

Example:

```ts
import { ArenaAgentClient } from "./sdk/src/index.js";

const client = new ArenaAgentClient("http://localhost:4000");

const created = await client.createArena({
    entryFeeWei: "50000",
    durationSeconds: 3600,
    settlementTokenSymbol: "USDC",
    title: "Debug Sprint Challenge",
    game: "Debugging",
    metric: "bugs fixed",
});

console.log(created.arena.id);

const activity = await client.getActivityFeed({
    limit: 6,
    leaderboardArenaId: created.arena.id,
});

console.log(activity[0]);
```

`getActivityFeed()` returns a normalized, feed-ready activity stream that combines live arena state, operator history, and optional leaderboard context so external apps can render ArenaAgent activity without rebuilding the frontend mapping logic.

---

## Integration Example

An example external integration is included at `examples/integration-demo.ts`.

It demonstrates how another app can:

1. Create an arena without using the frontend.
2. Submit scores from an external system.
3. Fetch the leaderboard.
4. Fetch a normalized ArenaAgent activity feed.
5. Ask ArenaAgent to summarize the state.

Run it with a TypeScript runner such as `tsx` once the backend is live.

---

## Team

| Name | Role | Contact |
|---|---|---|
| Vigo (Kosaiyno) | Solo builder / full-stack / smart contracts | @vigothecreator |

Vigo (Kosaiyno) - Solo builder / full-stack / smart contracts - @vigothecreator

---

## Project Positioning in the X Layer Ecosystem

ArenaAgent demonstrates how an Agentic Wallet can manage real economic activity on X Layer end-to-end without manual intervention:

- **Low-fee settlement**: X Layer's EVM compatibility and gas efficiency make it practical to run competitive micro-economies with small entry fees.
- **Routing-aware operator flow**: The operator wallet is not just a key pair — it coordinates quote discovery, join path selection, settlement, and payout logic across on-chain and API-backed integrations.
- **Uniswap for token-agnostic entry**: Players on X Layer can hold OKB, USDT, USDC, or any supported token and the agent routes them into the correct settlement asset using Uniswap quotes.
- **OKX as an additional routing surface**: When configured, the backend can also source OKX DEX quotes and swap transaction payloads for supported pairs on X Layer.
- **x402 for machine-to-machine payments**: The x402 flow enables future agent-to-agent compositions where an upstream AI agent can challenge-pay into an arena on behalf of a user, verified fully on-chain.
- **Composable design**: The arena contract, operator service, scoring logic, and routing layer are each independently replaceable, making ArenaAgent a building block for game studios, prediction markets, or any competitive module running on X Layer.

---

## Environment Variables

See `backend/.env.example` for the full reference. Key variables:

| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Operator wallet private key |
| `CONTRACT_ADDRESS` | Deployed `AgenticCompetitionEngine` address |
| `RPC_URL` | JSON-RPC endpoint (X Layer or local) |
| `APP_CHAIN_ID` | Chain ID (195 = X Layer Testnet, 196 = Mainnet) |
| `UNISWAP_API_KEY` | Uniswap Trading API key for live quotes |
| `ONCHAIN_OS_API_KEY/SECRET/PASSPHRASE` | OKX Onchain OS API credentials |
| `OPENAI_API_KEY` | LLM for operator chat intent parsing (optional) |
| `X402_ENABLED` | Enable x402 payment challenge endpoint (default: true) |


## Plug-and-Play Submission Scope

This submission now exposes ArenaAgent at three usable layers:

1. A full-stack demo app on X Layer.
2. A documented REST API for external apps.
3. A minimal TypeScript SDK for integrators.

That means judges can test ArenaAgent either through the frontend or as reusable competition infrastructure.

ArenaAgent can be integrated into any external app, game, platform, or service as a competition layer.

External apps:

- create arenas via API or SDK
- onboard their own users
- submit results from their own logic

ArenaAgent:

- handles routing, joining, ranking, and payouts
- exposes competition state and agent reasoning

The ArenaAgent activity feed provides a real-time, observable view of agent decisions, actions, and lifecycle events, making the agent's behavior transparent to users and integrators.

---

## Judge Quick Test

The fastest way to verify the plug-and-play integration flow is:

1. Start the backend.
2. Call `POST /operator/chat` or use the SDK to create an arena.
3. Call `POST /arena/:id/score` with a test wallet and score.
4. Call `GET /arena/:id/leaderboard`.
5. Ask ArenaAgent who is leading or who won.

That proves:

- agent orchestration
- routing logic
- onchain settlement
- end-to-end competition lifecycle

---

## Recent Changes (x402 Join & Routing Update)

- **x402 authorization join**: Replaced the standing-approval join flow with an atomic x402-style authorization path. The contract now exposes `joinArenaWithAuthorization(...)` and the backend accepts x402 payloads at `POST /arena/:id/x402-join` for server-side verification and settlement.
- **Routing preference change**: The routing layer now prefers Uniswap (`uniswap-trading-api`) first and falls back to OKX DEX aggregator (`okx-dex-aggregator`) only when Uniswap cannot provide a usable quote. This reduces unnecessary OKX calls and ensures consistent Uniswap-first UX.
- **Files updated**:
    - `backend/src/services/routeRecommendationService.ts` — prefer Uniswap and treat OKX as fallback; try Uniswap-first swap quote flow in both recommendation and swap-and-join plan building.
    - `backend/src/services/onchainOsService.ts` — OKX Onchain OS wrapper (unchanged for usage; used as fallback).
    - `backend/.env` — `PREFER_OKX_SWAP` now set to `false` by default in the repository; enable OKX explicitly if you want to prefer it.
    - `contracts/` — added `joinArenaWithAuthorization` and a `MockX402ERC20` used in tests.
    - `frontend/src/lib/contract.ts` & `frontend/src/App.tsx` — wallet x402 signing helper and UI flow updates to use x402 authorization flows.
- **Tests**: Added Hardhat tests for the x402 path using a mock token. Run `npx hardhat test` inside `contracts/` to validate.
- **How to roll back or switch behavior**: If you want to prefer OKX again, set `PREFER_OKX_SWAP=true` in `backend/.env` (not recommended for the default demo UX).

If you'd like, I can also produce a short changelog file summarizing these edits or update any other docs with step-by-step examples for the x402 flow.

- agent orchestration
- reusable integration surface
- leaderboard/state visibility
- onchain-aware competition flow on X Layer
