import { Request, Response, Router } from "express";
import { AgentWalletService } from "../services/agentWalletService.js";

export function createAgentRouter(agentWalletService: AgentWalletService): Router {
  const router = Router();

  router.get("/agent/wallet", (_request: Request, response: Response) => {
    response.json(agentWalletService.getIdentity());
  });

  return router;
}
