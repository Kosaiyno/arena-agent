import { env } from "../config/env.js";
import { ContractService } from "./contractService.js";
import { PayoutService } from "./payoutService.js";
import { ScoreService } from "./scoreService.js";
import { StateStore } from "./stateStore.js";

export class ArenaMonitor {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly contractService: ContractService,
    private readonly scoreService: ScoreService,
    private readonly stateStore: StateStore,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) => {
        console.warn("[ArenaMonitor] tick error:", err instanceof Error ? err.message : String(err));
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
    const arenas = await this.contractService.listArenas();
    const now = Math.floor(Date.now() / 1000);

    for (const arena of arenas) {
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
      }
    }
  }
}
