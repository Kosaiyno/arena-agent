import { NextFunction, Request, Response, Router } from "express";
import { OperatorService } from "../services/operatorService.js";

export function createOperatorRouter(operatorService: OperatorService): Router {
  const router = Router();

  router.get("/operator/status", (_request: Request, response: Response) => {
    response.json(operatorService.getStatus());
  });

  router.get("/operator/history", (_request: Request, response: Response) => {
    response.json({ events: operatorService.getHistory() });
  });

  router.post("/operator/chat", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const { prompt, selectedArenaId, history } = request.body as {
        prompt?: string;
        selectedArenaId?: number | null;
        history?: Array<{ role: "user" | "agent"; text: string }>;
      };

      if (!prompt || typeof prompt !== "string") {
        response.status(400).json({ error: "prompt is required" });
        return;
      }

      const result = await operatorService.handlePrompt(prompt, { selectedArenaId }, history ?? []);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}