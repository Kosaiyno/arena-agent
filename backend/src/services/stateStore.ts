import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env } from "../config/env.js";
import { ScoreEntry } from "../types/arena.js";
import { OperatorEvent } from "../types/operator.js";

export type ArenaMeta = {
  title?: string;
  game?: string;
  metric?: string;
};

type PersistedState = {
  contractAddress: string;
  scores: Record<string, Record<string, ScoreEntry>>;
  operatorEvents: OperatorEvent[];
  arenaConfigs: Record<string, { settlementTokenSymbol: string }>;
  arenaMeta: Record<string, ArenaMeta>;
  recurringConfigs?: Record<string, any>;
  arenaSnapshots?: Record<string, Record<string, number>>;
};

const emptyState = (): PersistedState => ({
  contractAddress: env.contractAddress.toLowerCase(),
  scores: {},
  operatorEvents: [],
  arenaConfigs: {},
  arenaMeta: {},
    recurringConfigs: {},
    arenaSnapshots: {},
});

export class StateStore {
  private readonly filePath = resolve(process.cwd(), env.stateFilePath);
  private state: PersistedState;

  constructor() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.state = this.loadState();
  }

  getScores(): Record<string, Record<string, ScoreEntry>> {
    return this.state.scores;
  }

  saveScores(scores: Record<string, Record<string, ScoreEntry>>): void {
    this.state = {
      ...this.state,
      scores,
    };
    this.persist();
  }

  getOperatorEvents(limit = 20): OperatorEvent[] {
    return [...this.state.operatorEvents].slice(-limit).reverse();
  }

  getArenaConfig(arenaId: number): { settlementTokenSymbol: string } | null {
    return this.state.arenaConfigs[String(arenaId)] ?? null;
  }

  saveArenaConfig(arenaId: number, config: { settlementTokenSymbol: string }): void {
    this.state = {
      ...this.state,
      arenaConfigs: {
        ...this.state.arenaConfigs,
        [String(arenaId)]: config,
      },
    };
    this.persist();
  }

  getArenaMeta(arenaId: number): ArenaMeta | null {
    return this.state.arenaMeta[String(arenaId)] ?? null;
  }

  // Arena snapshots (start balances per user, numeric settlement units)
  getArenaSnapshots(arenaId: number): Record<string, number> {
    return this.state.arenaSnapshots?.[String(arenaId)] ?? {};
  }

  saveArenaSnapshot(arenaId: number, user: string, value: number): void {
    const next = { ...(this.state.arenaSnapshots ?? {}) };
    next[String(arenaId)] = { ...(next[String(arenaId)] ?? {}), [user]: value };
    this.state = { ...this.state, arenaSnapshots: next };
    this.persist();
  }

  deleteArenaSnapshots(arenaId: number): void {
    const next = { ...(this.state.arenaSnapshots ?? {}) };
    delete next[String(arenaId)];
    this.state = { ...this.state, arenaSnapshots: next };
    this.persist();
  }

  // Recurring configs
  getRecurringConfigs(): Record<string, any> {
    return this.state.recurringConfigs ?? {};
  }

  saveRecurringConfig(id: string, config: any): void {
    this.state = {
      ...this.state,
      recurringConfigs: {
        ...this.state.recurringConfigs,
        [id]: config,
      },
    };
    this.persist();
  }

  deleteRecurringConfig(id: string): void {
    const next = { ...this.state.recurringConfigs } ?? {};
    delete next[id];
    this.state = {
      ...this.state,
      recurringConfigs: next,
    };
    this.persist();
  }
 

  getArenaMetaMap(): Record<number, ArenaMeta | null> {
    const entries = Object.entries(this.state.arenaMeta).map(([arenaId, meta]) => [Number(arenaId), meta ?? null] as const);
    return Object.fromEntries(entries);
  }

  saveArenaMeta(arenaId: number, meta: ArenaMeta): void {
    this.state = {
      ...this.state,
      arenaMeta: {
        ...this.state.arenaMeta,
        [String(arenaId)]: { ...this.state.arenaMeta[String(arenaId)], ...meta },
      },
    };
    this.persist();
  }

  appendOperatorEvent(event: OperatorEvent): void {
    this.state = {
      ...this.state,
      operatorEvents: [...this.state.operatorEvents, event].slice(-200),
    };
    this.persist();
  }

  private loadState(): PersistedState {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      const currentContractAddress = env.contractAddress.toLowerCase();
      if ((parsed.contractAddress ?? "").toLowerCase() !== currentContractAddress) {
        const initial = emptyState();
        writeFileSync(this.filePath, JSON.stringify(initial, null, 2));
        return initial;
      }

      return {
        contractAddress: currentContractAddress,
        scores: parsed.scores ?? {},
        operatorEvents: parsed.operatorEvents ?? [],
        arenaConfigs: parsed.arenaConfigs ?? {},
        arenaMeta: parsed.arenaMeta ?? {},
        recurringConfigs: parsed.recurringConfigs ?? {},
        arenaSnapshots: parsed.arenaSnapshots ?? {},
      };
    } catch {
      const initial = emptyState();
      writeFileSync(this.filePath, JSON.stringify(initial, null, 2));
      return initial;
    }
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }
}