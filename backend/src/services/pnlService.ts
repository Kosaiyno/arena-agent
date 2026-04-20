import { ArenaViewService } from "./arenaViewService.js";
import { WalletInspectionService } from "./walletInspectionService.js";
import { ScoreService } from "./scoreService.js";
import { StateStore } from "./stateStore.js";

export class PnlService {
  constructor(
    private readonly arenaViewService: ArenaViewService,
    private readonly walletInspectionService: WalletInspectionService,
    private readonly scoreService: ScoreService,
    private readonly stateStore: StateStore,
  ) {}

  // Ensure a start snapshot exists for players and update peak PnL scores.
  async updateScoresForArena(arenaId: number): Promise<void> {
    const arena = await this.arenaViewService.getArena(arenaId);
    const players = arena.players ?? [];
    if (players.length === 0) return;

    const snapshots = this.stateStore.getArenaSnapshots(arenaId);

    for (const player of players) {
      try {
        const inspected = await this.walletInspectionService.inspectWallet(player, arena);
        // Find settlement token estimate
        const settlement = inspected.find((b) => b.token.symbol === (arena.settlementToken?.symbol ?? "USDC"));
        const current = settlement?.estimatedValueInSettlement ?? 0;

        const start = snapshots[player] ?? null;
        if (start === null) {
          // first time seeing this player for this arena, save their start balance
          this.stateStore.saveArenaSnapshot(arenaId, player, current);
        }

        const baseline = start ?? current;
        const delta = current - baseline;
        const score = Math.max(0, Number(delta.toFixed(6)));

        // Upsert peak score (ScoreService only updates if score is higher)
        this.scoreService.upsertScore(arenaId, player, score);
      } catch (err) {
        console.warn(`[PnlService] failed to update score for ${player} in arena #${arenaId}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Optional: clear stored snapshots for an arena
  clearSnapshots(arenaId: number): void {
    this.stateStore.deleteArenaSnapshots(arenaId);
  }
}

export default PnlService;
