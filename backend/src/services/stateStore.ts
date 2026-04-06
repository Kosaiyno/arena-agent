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
  scores: Record<string, Record<string, ScoreEntry>>;
  operatorEvents: OperatorEvent[];
  arenaConfigs: Record<string, { settlementTokenSymbol: string }>;
  arenaMeta: Record<string, ArenaMeta>;
};

const emptyState = (): PersistedState => ({
  scores: {},
  operatorEvents: [],
  arenaConfigs: {},
  arenaMeta: {},
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
      return {
        scores: parsed.scores ?? {},
        operatorEvents: parsed.operatorEvents ?? [],
        arenaConfigs: parsed.arenaConfigs ?? {},
        arenaMeta: parsed.arenaMeta ?? {},
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