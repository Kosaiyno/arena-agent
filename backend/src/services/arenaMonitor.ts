import { env } from "../config/env.js";
import { ContractService } from "./contractService.js";
import { PayoutService } from "./payoutService.js";
import { ScoreService } from "./scoreService.js";
import { StateStore } from "./stateStore.js";
import { PnlService } from "./pnlService.js";

export class ArenaMonitor {
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;

  constructor(
    private readonly contractService: ContractService,
    private readonly scoreService: ScoreService,
    private readonly stateStore: StateStore,
    private readonly pnlService?: PnlService,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      if (this.tickInFlight) {
        return;
      }

      this.tickInFlight = true;
      this.tick().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.toLowerCase().includes("too many rpc calls in batch request") || message.toLowerCase().includes("missing response for request")) {
          console.warn("[ArenaMonitor] X Layer RPC throttled monitor reads; retrying on the next poll.");
          return;
        }

        console.warn("[ArenaMonitor] tick error:", message);
      }).finally(() => {
        this.tickInFlight = false;
      });
    }, env.pollIntervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const arenas = await this.contractService.listArenasForMonitor();
    const now = Math.floor(Date.now() / 1000);

    for (const arena of arenas) {
      // For active arenas, update PnL scores so leaderboard reflects live PnL
      try {
        if (!arena.closed && this.pnlService) {
          await this.pnlService.updateScoresForArena(arena.id);
        }
      } catch (err) {
        console.warn(`[ArenaMonitor] live pnl update failed for arena #${arena.id}:`, err instanceof Error ? err.message : String(err));
      }

      if (!arena.closed && now >= arena.endTime) {
        await this.contractService.closeArena(arena.id);
        this.stateStore.appendOperatorEvent({
          id: `close-${arena.id}-${Date.now()}`,
          type: "monitor_closed_arena",
          arenaId: arena.id,
          createdAt: Date.now(),
          detail: `Monitor closed arena #${arena.id} after the configured end time.`,
        });
      }

      if (arena.closed && !arena.finalized) {
        // Ensure PnL-based scores are updated before choosing winners
        try {
          if (this.pnlService) await this.pnlService.updateScoresForArena(arena.id);
        } catch (err) {
          console.warn(`[ArenaMonitor] pnl update failed for arena #${arena.id}:`, err instanceof Error ? err.message : String(err));
        }

        const winners = this.scoreService.getTopWinners(arena.id, 1);
        if (winners.length === 0) {
          continue;
        }

        const normalized = PayoutService.getNormalizedPayouts(env.defaultPayouts, winners.length);

        await this.contractService.finalizeArena(
          arena.id,
          winners.map((winner) => winner.user),
          normalized,
        );
        this.stateStore.appendOperatorEvent({
          id: `finalize-${arena.id}-${Date.now()}`,
          type: "monitor_finalized_arena",
          arenaId: arena.id,
          createdAt: Date.now(),
          detail: `Monitor finalized arena #${arena.id} with winners ${winners.map((winner) => winner.user).join(", ")}.`,
          metadata: {
            payouts: PayoutService.describe(env.defaultPayouts, winners.length),
          },
        });
        // After finalization the monitor leaves payout handling to the contract/operator.
      }
    }
  }
}
