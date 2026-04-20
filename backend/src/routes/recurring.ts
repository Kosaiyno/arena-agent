import { NextFunction, Request, Response, Router } from "express";
import { RecurringService } from "../services/recurringService.js";

export function createRecurringRouter(recurringService: RecurringService): Router {
  const router = Router();

  router.get("/recurring", (_req: Request, res: Response, next: NextFunction) => {
    try {
      const list = recurringService.listConfigs();
      res.json({ recurring: list });
    } catch (err) {
      next(err);
    }
  });

  router.post("/recurring", (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = req.body;
      const created = recurringService.createConfig(payload);
      res.status(201).json({ recurring: created });
    } catch (err) {
      next(err);
    }
  });

  router.post("/recurring/:id/trigger", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      const result = await recurringService.triggerNow(id);
      if (!result) {
        res.status(404).json({ error: "Recurring config not found" });
        return;
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/recurring/:id", (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id);
      recurringService.deleteConfig(id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
