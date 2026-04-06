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
import { OperatorService } from "./services/operatorService.js";
import { RouteRecommendationService } from "./services/routeRecommendationService.js";
import { ScoreService } from "./services/scoreService.js";
import { StateStore } from "./services/stateStore.js";
import { TokenRegistry } from "./services/tokenRegistry.js";
import { UniswapTradeService } from "./services/uniswapTradeService.js";
import { WalletInspectionService } from "./services/walletInspectionService.js";

const app = express();
const stateStore = new StateStore();
const contractService = new ContractService();
const tokenRegistry = new TokenRegistry();
const arenaViewService = new ArenaViewService(contractService, stateStore, tokenRegistry);
const scoreService = new ScoreService(stateStore);
const walletInspectionService = new WalletInspectionService(contractService, tokenRegistry);
const uniswapTradeService = new UniswapTradeService();
const onchainOsService = new OnchainOsService();
const routeRecommendationService = new RouteRecommendationService(tokenRegistry, uniswapTradeService, onchainOsService);
const operatorService = new OperatorService(contractService, scoreService, stateStore, uniswapTradeService, onchainOsService);
const arenaMonitor = new ArenaMonitor(contractService, scoreService, stateStore);
const agentWalletService = new AgentWalletService();

app.use(cors());
app.use(express.json());
app.use(createArenaRouter(contractService, arenaViewService, scoreService, walletInspectionService, routeRecommendationService, stateStore));
app.use(createOperatorRouter(operatorService));
app.use(createAgentRouter(agentWalletService));

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
