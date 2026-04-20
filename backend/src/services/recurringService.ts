import { StateStore } from "./stateStore.js";
import { ContractService } from "./contractService.js";
import { env } from "../config/env.js";

export type RecurringConfig = {
  id: string;
  title?: string;
  cron?: string | null;
  intervalSeconds?: number | null;
  entryFeeWei: string;
  durationSeconds: number;
  settlementTokenSymbol: string;
  supportedTokens?: string[];
  minTrades?: number;
  owner?: string | null;
  enabled?: boolean;
  lastRunAt?: number | null;
  createdAt: number;
};

export class RecurringService {
  constructor(private readonly stateStore: StateStore, private readonly contractService: ContractService) {}

  listConfigs(): RecurringConfig[] {
    const raw = this.stateStore.getRecurringConfigs();
    return Object.values(raw ?? {});
  }

  createConfig(payload: Partial<RecurringConfig>): RecurringConfig {
    const id = `rec-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const cfg: RecurringConfig = {
      id,
      title: payload.title ?? "Recurring Arena",
      cron: payload.cron ?? null,
      intervalSeconds: payload.intervalSeconds ?? 86400,
      entryFeeWei: payload.entryFeeWei ?? "0",
      durationSeconds: payload.durationSeconds ?? 3600,
      settlementTokenSymbol: payload.settlementTokenSymbol ?? "USDC",
      supportedTokens: payload.supportedTokens ?? [],
      minTrades: payload.minTrades ?? 1,
      owner: payload.owner ?? null,
      enabled: payload.enabled ?? true,
      lastRunAt: payload.lastRunAt ?? null,
      createdAt: Date.now(),
    };
    this.stateStore.saveRecurringConfig(id, cfg);
    return cfg;
  }

  getConfig(id: string): RecurringConfig | null {
    const all = this.stateStore.getRecurringConfigs();
    return all[id] ?? null;
  }

  deleteConfig(id: string): void {
    this.stateStore.deleteRecurringConfig(id);
  }

  async triggerNow(id: string): Promise<{ arenaId: number } | null> {
    const cfg = this.getConfig(id);
    if (!cfg) return null;
    // resolve entry token address from configured supported tokens for this symbol
    const tokenInfo = env.supportedTokens.find((t) => t.symbol.toLowerCase() === (cfg.settlementTokenSymbol ?? "").toLowerCase());
    // pass undefined when token address is not available so ContractService uses its default; pass explicit address when known
    const entryTokenAddress = tokenInfo?.address ?? undefined;
    const arenaId = await this.contractService.createArena(cfg.entryFeeWei, cfg.durationSeconds, entryTokenAddress);
    // save meta to state store
    this.stateStore.saveArenaMeta(arenaId, { title: cfg.title, game: "Trading", metric: "PnL" });
    this.stateStore.appendOperatorEvent({
      id: `recurring_triggered-${Date.now()}`,
      createdAt: Date.now(),
      type: "operator_created_arena",
      arenaId,
      detail: `Recurring config ${cfg.id} triggered and created arena #${arenaId}`,
      metadata: { recurringId: cfg.id },
    });
    return { arenaId };
  }
}

export default RecurringService;
