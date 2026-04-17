import { NextFunction, Request, Response, Router } from "express";
import { formatUnits, isAddress } from "ethers";
import { env } from "../config/env.js";
import { WalletTokenBalance } from "../types/arena.js";
import { ArenaViewService } from "../services/arenaViewService.js";
import { ContractService } from "../services/contractService.js";
import { OkxPortfolioService } from "../services/okxPortfolioService.js";
import { OkxX402Service } from "../services/okxX402Service.js";
import { RouteRecommendationService } from "../services/routeRecommendationService.js";
import { ScoreService } from "../services/scoreService.js";
import { StateStore } from "../services/stateStore.js";
import { WalletInspectionService } from "../services/walletInspectionService.js";

function arenaHasEnded(arena: { closed: boolean; finalized: boolean; endTime: number }): boolean {
  return arena.closed || arena.finalized || arena.endTime <= Math.floor(Date.now() / 1000);
}

function playerAlreadyJoined(arena: { players: string[] }, user: string): boolean {
  return arena.players.some((player) => player.toLowerCase() === user.toLowerCase());
}

function parseCustomTokens(value: unknown): Array<{ symbol: string; name: string; address: string | null; decimals: number; kind: "native" | "erc20" }> {
  if (!Array.isArray(value)) return [];
  return value.filter((token): token is { symbol: string; name: string; address: string | null; decimals: number; kind: "native" | "erc20" } => (
    Boolean(token)
    && typeof token === "object"
    && typeof (token as { symbol?: unknown }).symbol === "string"
    && typeof (token as { name?: unknown }).name === "string"
    && (typeof (token as { address?: unknown }).address === "string" || (token as { address?: unknown }).address === null)
    && typeof (token as { decimals?: unknown }).decimals === "number"
    && (((token as { kind?: unknown }).kind === "native") || ((token as { kind?: unknown }).kind === "erc20"))
  ));
}

export function createArenaRouter(
  contractService: ContractService,
  arenaViewService: ArenaViewService,
  scoreService: ScoreService,
  walletInspectionService: WalletInspectionService,
  routeRecommendationService: RouteRecommendationService,
  stateStore: StateStore,
  okxPortfolioService: OkxPortfolioService,
  okxX402Service: OkxX402Service,
): Router {
  const router = Router();

  router.get("/arena", async (_request: Request, response: Response, next: NextFunction) => {
    try {
      const arenas = await arenaViewService.listArenas();
      response.json({ arenas, metaMap: stateStore.getArenaMetaMap() });
    } catch (error) {
      next(error);
    }
  });



  router.post("/arena", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const { entryFeeWei, durationSeconds, settlementTokenSymbol, title, game, metric } = request.body as {
        entryFeeWei?: string;
        durationSeconds?: number;
        settlementTokenSymbol?: string;
        title?: string;
        game?: string;
        metric?: string;
      };

      if (!entryFeeWei || !durationSeconds || durationSeconds <= 0) {
        response.status(400).json({ error: "entryFeeWei and durationSeconds are required" });
        return;
      }

      const desiredSymbol = settlementTokenSymbol ?? "USDC";
      const entryTokenAddress = env.supportedTokens.find((token) => token.symbol.toLowerCase() === desiredSymbol.toLowerCase())?.address ?? null;
      const arenaId = await contractService.createArena(entryFeeWei, durationSeconds, entryTokenAddress);
      arenaViewService.saveArenaSettlementToken(arenaId, desiredSymbol);
      const normalizedMeta = {
        title: typeof title === "string" && title.trim() ? title.trim() : undefined,
        game: typeof game === "string" && game.trim() ? game.trim() : undefined,
        metric: typeof metric === "string" && metric.trim() ? metric.trim() : undefined,
      };
      if (normalizedMeta.title || normalizedMeta.game || normalizedMeta.metric) {
        stateStore.saveArenaMeta(arenaId, normalizedMeta);
      }
      stateStore.appendOperatorEvent({
        id: `operator_created_arena-${Date.now()}`,
        createdAt: Date.now(),
        type: "operator_created_arena",
        arenaId,
        detail: `API created arena #${arenaId}.`,
        metadata: {
          entryFeeWei,
          settlementTokenSymbol: desiredSymbol,
          durationSeconds,
          title: normalizedMeta.title ?? null,
          game: normalizedMeta.game ?? null,
          metric: normalizedMeta.metric ?? null,
        },
      });
      const arena = await arenaViewService.getArena(arenaId);
      response.status(201).json({ arena, meta: normalizedMeta });
    } catch (error) {
      next(error);
    }
  });

  router.post("/arena/:id/join", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const arenaId = Number(request.params.id);
      const { user } = request.body as { user?: string };
      if (!Number.isInteger(arenaId) || arenaId <= 0 || !user || !isAddress(user)) {
        response.status(400).json({ error: "Valid arena id and user address are required" });
        return;
      }

      const arena = await arenaViewService.getArena(arenaId);
      if (arenaHasEnded(arena)) {
        response.status(400).json({ error: "Arena has already ended. Joining is closed." });
        return;
      }
      if (playerAlreadyJoined(arena, user)) {
        response.status(400).json({ error: "You already joined this arena." });
        return;
      }

      if (arena.settlementToken?.kind === "erc20") {
        try {
          await contractService.joinArenaFor(arenaId, user);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("transfer amount exceeds allowance")) {
            response.status(400).json({ error: `Approve ${arena.settlementToken.symbol} for the arena contract, then try join again.` });
            return;
          }
          if (message.includes("transfer amount exceeds balance")) {
            response.status(400).json({ error: `Your wallet does not hold enough ${arena.settlementToken.symbol} to join this arena.` });
            return;
          }
          throw error;
        }
        const updatedArena = await arenaViewService.getArena(arenaId);
        response.json({
          arenaId,
          user,
          relayed: true,
          settlementToken: updatedArena.settlementToken,
          note: "ArenaAgent relayed the approved token transfer and joined the arena.",
        });
        return;
      }

      response.json({
        arenaId,
        user,
        contractAddress: env.contractAddress,
        entryFeeWei: arena.entryFeeWei,
        settlementToken: arena.settlementToken,
        joinMethod: "joinArena(uint256)",
        note: "The client wallet must send the payable joinArena transaction.",
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/arena/:id/score", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const arenaId = Number(request.params.id);
      const { user, score } = request.body as { user?: string; score?: number };
      if (!Number.isInteger(arenaId) || arenaId <= 0 || !user || !isAddress(user) || typeof score !== "number" || score < 0) {
        response.status(400).json({ error: "Valid arena id, user, and score are required" });
        return;
      }

      const entry = scoreService.upsertScore(arenaId, user, score);
      if (entry.score === score) {
        try {
          await contractService.submitScore(arenaId, user, score);
        } catch (err) {
          console.warn(`[score] on-chain submitScore failed for arena #${arenaId} (score saved locally):`, err instanceof Error ? err.message : String(err));
        }
      }

      response.status(201).json({ entry, leaderboard: scoreService.getLeaderboard(arenaId) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/arena/:id/leaderboard", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const arenaId = Number(request.params.id);
      if (!Number.isInteger(arenaId) || arenaId <= 0) {
        response.status(400).json({ error: "Valid arena id is required" });
        return;
      }

      const arena = await arenaViewService.getArena(arenaId);
      const meta = stateStore.getArenaMeta(arenaId);
      response.json({ arena, leaderboard: scoreService.getLeaderboard(arenaId), meta });
    } catch (error) {
      next(error);
    }
  });

  router.post("/arena/:id/routes", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const arenaId = Number(request.params.id);
      const { user, customTokens } = request.body as {
        user?: string;
        customTokens?: Array<{ symbol: string; name: string; address: string | null; decimals: number; kind: "native" | "erc20" }>;
      };
      if (!Number.isInteger(arenaId) || arenaId <= 0 || !user || !isAddress(user)) {
        response.status(400).json({ error: "Valid arena id and user address are required" });
        return;
      }

      const arena = await arenaViewService.getArena(arenaId);
      if (arenaHasEnded(arena)) {
        response.json({
          arena,
          user,
          balances: [],
          recommendedRoute: null,
          candidateRoutes: [],
        });
        return;
      }

      if (playerAlreadyJoined(arena, user)) {
        response.json({
          arena,
          user,
          balances: [],
          recommendedRoute: null,
          candidateRoutes: [],
        });
        return;
      }

      const provider = contractService.getProvider();
      const inspectedBalances = await walletInspectionService.inspectWallet(user, arena, parseCustomTokens(customTokens));
      const portfolio = await okxPortfolioService.enrichBalances(
        user,
        inspectedBalances,
        (address) => provider.getBalance(address),
      );
      const routes = await routeRecommendationService.getRecommendation(arena, user, portfolio.balances);
      response.json({
        arena,
        user,
        balances: portfolio.balances,
        portfolio: {
          enabled: portfolio.enabled,
          source: portfolio.source,
          tokenCount: portfolio.tokenCount,
        },
        recommendedRoute: routes.recommended,
        candidateRoutes: routes.candidates,
      });
    } catch (error) {
      next(error);
    }
  });

  // x402 Payment Required join flow.
  // Without X-Payment-Proof header → 402 with payment requirements.
  // With X-Payment-Proof: <txHash> → verify the on-chain transaction and confirm the join.
  router.post("/arena/:id/x402-join", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const arenaId = Number(request.params.id);
      if (!Number.isInteger(arenaId) || arenaId <= 0) {
        response.status(400).json({ error: "Valid arena id is required" });
        return;
      }

      const arena = await arenaViewService.getArena(arenaId);
      if (arenaHasEnded(arena)) {
        response.status(400).json({ error: "Arena has already ended. Joining is closed." });
        return;
      }

      const okxPayment = okxX402Service.parsePaymentHeaders(request.headers);
      if (okxPayment?.authorization?.from && playerAlreadyJoined(arena, okxPayment.authorization.from)) {
        response.status(400).json({ error: "You already joined this arena." });
        return;
      }

      if (!okxPayment?.authorization || !okxPayment.signature) {
        const okxChallenge = okxX402Service.buildChallenge({
          arenaId,
          entryFee: arena.entryFeeWei,
          settlementToken: arena.settlementToken,
          resourcePath: `/arena/${arenaId}/x402-join`,
        });
        if (okxChallenge.requiredHeaderValue) {
          response.setHeader("PAYMENT-REQUIRED", okxChallenge.requiredHeaderValue);
        }
        response.status(402).json({
          error: "Payment required",
          x402: true,
          payment: {
            scheme: "x402",
            network: `eip155:${env.appChainId}`,
            maxAmountRequired: arena.entryFeeWei,
            resource: `/arena/${arenaId}/x402-join`,
            description: `Arena #${arenaId} entry fee – ${arena.entryFeeWei} wei`,
            payTo: env.contractAddress,
            asset: "0x0000000000000000000000000000000000000000",
            extra: {
              name: "ArenaAgent Entry",
              version: "1",
              contract: env.contractAddress,
              method: "joinArena(uint256)",
              arenaId,
            },
          },
          okxX402: okxChallenge,
        });
        return;
      }

      if (arena.settlementToken?.kind !== "erc20" || !arena.settlementToken.address) {
        response.status(400).json({ error: "x402 entry is only available for ERC-20 arenas." });
        return;
      }

      const payment = okxPayment;
      const authorization = payment.authorization;
      const signature = payment.signature;
      if (!authorization) {
        response.status(400).json({ error: "x402 authorization payload is incomplete." });
        return;
      }
      if (!signature) {
        response.status(400).json({ error: "x402 signature payload is missing." });
        return;
      }

      if (payment.network !== `eip155:${env.appChainId}`) {
        response.status(400).json({ error: "x402 payment network does not match this arena." });
        return;
      }

      if (payment.payTo?.toLowerCase() !== env.contractAddress.toLowerCase()) {
        response.status(400).json({ error: "x402 payment recipient does not match the arena contract." });
        return;
      }

      if (payment.asset?.toLowerCase() !== arena.settlementToken.address.toLowerCase()) {
        response.status(400).json({ error: `x402 payment asset does not match ${arena.settlementToken.symbol}.` });
        return;
      }

      if (payment.amount !== arena.entryFeeWei || authorization.value !== arena.entryFeeWei) {
        response.status(400).json({ error: "x402 payment amount does not match the arena entry fee." });
        return;
      }

      if (authorization.to.toLowerCase() !== env.contractAddress.toLowerCase()) {
        response.status(400).json({ error: "x402 authorization destination does not match the arena contract." });
        return;
      }

      await contractService.joinArenaWithAuthorization(arenaId, authorization, signature);
      const updatedArena = await arenaViewService.getArena(arenaId);

      response.json({
        verified: true,
        provider: "okx-x402-payment",
        arenaId,
        player: authorization.from,
        relayed: true,
        settlementToken: updatedArena.settlementToken,
        message: `x402 payment authorized and ${authorization.from} joined arena #${arenaId}.`,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/arena/:id/swap-and-join", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const arenaId = Number(request.params.id);
      const { user, fromTokenSymbol, fromToken, fromAmountBaseUnits } = request.body as {
        user?: string;
        fromTokenSymbol?: string;
        fromToken?: { symbol: string; name: string; address: string | null; decimals: number; kind: "native" | "erc20" };
        fromAmountBaseUnits?: string;
      };

      if (!Number.isInteger(arenaId) || arenaId <= 0 || !user || !isAddress(user)) {
        response.status(400).json({ error: "Valid arena id and user address are required" });
        return;
      }

      const arena = await arenaViewService.getArena(arenaId);
      if (arenaHasEnded(arena)) {
        response.status(400).json({ error: "Arena has already ended. Joining is closed." });
        return;
      }
      if (playerAlreadyJoined(arena, user)) {
        response.status(400).json({ error: "You already joined this arena." });
        return;
      }
      const plan = await routeRecommendationService.buildSwapAndJoinPlan(
        arena,
        user,
        fromToken ?? fromTokenSymbol ?? arena.settlementToken?.symbol ?? "OKB",
        fromAmountBaseUnits ?? arena.entryFeeWei,
      );

      response.json(plan);
    } catch (error) {
      next(error);
    }
  });

  // Wallet token balances — no arena context required; uses a zero-fee dummy arena
  router.get("/wallet/balances", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const user = String(request.query.user ?? "");
      if (!user || !isAddress(user)) {
        response.status(400).json({ error: "Valid user address is required" });
        return;
      }
      const dummyArena = {
        id: 0,
        entryFeeWei: "0",
        totalPoolWei: "0",
        createdAt: 0,
        endTime: 0,
        closed: false,
        finalized: false,
        players: [] as string[],
      };
      const provider = contractService.getProvider();
      const inspectedBalances = await walletInspectionService.inspectWallet(user, dummyArena);
      const portfolio = await okxPortfolioService.enrichBalances(
        user,
        inspectedBalances,
        (address) => provider.getBalance(address),
      );
      response.json({
        user,
        balances: portfolio.balances,
        portfolio: {
          enabled: portfolio.enabled,
          source: portfolio.source,
          tokenCount: portfolio.tokenCount,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/wallet/portfolio", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const user = String(request.query.user ?? "");
      if (!user || !isAddress(user)) {
        response.status(400).json({ error: "Valid user address is required" });
        return;
      }

      const provider = contractService.getProvider();
      const dummyArena = {
        id: 0,
        entryFeeWei: "0",
        totalPoolWei: "0",
        createdAt: 0,
        endTime: 0,
        closed: false,
        finalized: false,
        players: [] as string[],
      };
      const inspectedBalances = await walletInspectionService.inspectWallet(user, dummyArena);
      const portfolio = await okxPortfolioService.enrichBalances(
        user,
        inspectedBalances,
        (address) => provider.getBalance(address),
      );
      response.json({
        user,
        source: portfolio.source,
        enabled: portfolio.enabled,
        tokenCount: portfolio.tokenCount,
        balances: portfolio.balances,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
