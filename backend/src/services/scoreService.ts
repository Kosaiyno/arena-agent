import { LeaderboardEntry, ScoreEntry } from "../types/arena.js";
import { StateStore } from "./stateStore.js";

export class ScoreService {
  private readonly arenaScores = new Map<number, Map<string, ScoreEntry>>();

  constructor(private readonly stateStore: StateStore) {
    const persistedScores = this.stateStore.getScores();
    for (const [arenaId, scores] of Object.entries(persistedScores)) {
      this.arenaScores.set(Number(arenaId), new Map<string, ScoreEntry>(Object.entries(scores)));
    }
  }

  upsertScore(arenaId: number, user: string, score: number): ScoreEntry {
    const scores = this.arenaScores.get(arenaId) ?? new Map<string, ScoreEntry>();
    const previous = scores.get(user);
    if (!previous || score > previous.score) {
      const next = { user, score, updatedAt: Date.now() };
      scores.set(user, next);
      this.arenaScores.set(arenaId, scores);
      this.persist();
      return next;
    }

    return previous;
  }

  getLeaderboard(arenaId: number): LeaderboardEntry[] {
    const scores = this.arenaScores.get(arenaId);
    if (!scores) {
      return [];
    }

    return Array.from(scores.values())
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.updatedAt - right.updatedAt;
      })
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  getTopWinners(arenaId: number, limit = 3): LeaderboardEntry[] {
    return this.getLeaderboard(arenaId).slice(0, limit);
  }

  private persist(): void {
    const snapshot: Record<string, Record<string, ScoreEntry>> = {};
    for (const [arenaId, scores] of this.arenaScores.entries()) {
      snapshot[String(arenaId)] = Object.fromEntries(scores.entries());
    }
    this.stateStore.saveScores(snapshot);
  }
}
