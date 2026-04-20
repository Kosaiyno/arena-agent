import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { env } from "./config/env.js";
import { createAgentRouter } from "./routes/agent.js";
import { createArenaRouter } from "./routes/arena.js";
import { createOperatorRouter } from "./routes/operator.js";
import { AgentWalletService } from "./services/agentWalletService.js";
import { ArenaViewService } from "./services/arenaViewService.js";
import { ArenaMonitor } from "./services/arenaMonitor.js";
import { ContractService } from "./services/contractService.js";
import { OnchainOsService } from "./services/onchainOsService.js";
import { OkxPortfolioService } from "./services/okxPortfolioService.js";
import { OkxX402Service } from "./services/okxX402Service.js";
import { OperatorService } from "./services/operatorService.js";
import { RouteRecommendationService } from "./services/routeRecommendationService.js";
import { ScoreService } from "./services/scoreService.js";
import { StateStore } from "./services/stateStore.js";
import { TokenRegistry } from "./services/tokenRegistry.js";
import { UniswapTradeService } from "./services/uniswapTradeService.js";
import { WalletInspectionService } from "./services/walletInspectionService.js";
import { RecurringService } from "./services/recurringService.js";
import { createRecurringRouter } from "./routes/recurring.js";
import { SchedulerService } from "./services/schedulerService.js";

const app = express();
const stateStore = new StateStore();
const contractService = new ContractService();
const tokenRegistry = new TokenRegistry();
const arenaViewService = new ArenaViewService(contractService, stateStore, tokenRegistry);
const scoreService = new ScoreService(stateStore);
const walletInspectionService = new WalletInspectionService(contractService, tokenRegistry);
const uniswapTradeService = new UniswapTradeService();
const onchainOsService = new OnchainOsService();
const okxPortfolioService = new OkxPortfolioService(tokenRegistry);
const okxX402Service = new OkxX402Service();
const routeRecommendationService = new RouteRecommendationService(tokenRegistry, uniswapTradeService, onchainOsService);
const operatorService = new OperatorService(contractService, scoreService, stateStore, uniswapTradeService, onchainOsService);
import { PnlService } from "./services/pnlService.js";

const pnlService = new PnlService(arenaViewService, walletInspectionService, scoreService, stateStore);
const arenaMonitor = new ArenaMonitor(contractService, scoreService, stateStore, pnlService);
const agentWalletService = new AgentWalletService();
const recurringService = new RecurringService(stateStore, contractService);
const schedulerService = new SchedulerService(recurringService, stateStore);

app.use(cors());
app.use(express.json());
app.use(createArenaRouter(contractService, arenaViewService, scoreService, walletInspectionService, routeRecommendationService, stateStore, okxPortfolioService, okxX402Service));
app.use(createOperatorRouter(operatorService));
app.use(createAgentRouter(agentWalletService));
app.use(createRecurringRouter(recurringService));
schedulerService.start();

// Temporary admin endpoint to trigger PnL update for an arena (useful for debugging)
app.post("/admin/pnl/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const arenaId = Number(req.params.id);
    if (!Number.isInteger(arenaId) || arenaId <= 0) {
      res.status(400).json({ error: "Valid arena id is required" });
      return;
    }
    if (!pnlService) {
      res.status(500).json({ error: "PnlService not configured" });
      return;
    }
    await pnlService.updateScoresForArena(arenaId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/health", (_request: Request, response: Response) => {
  response.json({ status: "ok" });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  response.status(500).json({ error: message });
});

app.listen(env.port, () => {
  arenaMonitor.start();
  console.log(`ArenaAgent backend listening on port ${env.port}`);
});
