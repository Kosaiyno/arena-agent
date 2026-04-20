import { RecurringService } from "./recurringService.js";
import { StateStore } from "./stateStore.js";

export class SchedulerService {
  private intervalId: NodeJS.Timeout | null = null;

  constructor(private readonly recurringService: RecurringService, private readonly stateStore: StateStore) {}

  start(pollSeconds = 60) {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => void this.tick(), pollSeconds * 1000);
    // run immediately once
    void this.tick();
  }

  stop() {
    if (!this.intervalId) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  private async tick() {
    try {
      const now = Math.floor(Date.now() / 1000);
      const configs = this.recurringService.listConfigs();
      for (const cfg of configs) {
        if (!cfg.enabled) continue;
        const last = cfg.lastRunAt ?? 0;
        if (cfg.cron === "midnight-utc") {
          // compute UTC midnight for today
          const utcNow = new Date();
          const utcMidnight = Math.floor(Date.UTC(utcNow.getUTCFullYear(), utcNow.getUTCMonth(), utcNow.getUTCDate()) / 1000);
          // if we haven't run for today's midnight yet, trigger
          if (last < utcMidnight) {
            try {
              const res = await this.recurringService.triggerNow(cfg.id);
              if (res) {
                const updated = { ...cfg, lastRunAt: utcMidnight };
                this.stateStore.saveRecurringConfig(cfg.id, updated);
              }
            } catch (err) {
              console.warn(`[Scheduler] failed to trigger recurring ${cfg.id}:`, err instanceof Error ? err.message : String(err));
            }
          }
        } else {
          const interval = cfg.intervalSeconds ?? 86400;
          if (last === 0 || (now - last) >= interval) {
            // trigger
            try {
              const res = await this.recurringService.triggerNow(cfg.id);
              if (res) {
                // update lastRunAt and persist
                const updated = { ...cfg, lastRunAt: now };
                this.stateStore.saveRecurringConfig(cfg.id, updated);
              }
            } catch (err) {
              console.warn(`[Scheduler] failed to trigger recurring ${cfg.id}:`, err instanceof Error ? err.message : String(err));
            }
          }
        }
      }
    } catch (err) {
      console.warn("[Scheduler] tick failed:", err instanceof Error ? err.message : String(err));
    }
  }
}

export default SchedulerService;
