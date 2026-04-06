export type OperatorIntent =
  | {
      type: "create_arena";
      entryFeeWei: string;
      durationSeconds: number;
      settlementTokenSymbol?: string;
      title?: string;
      game?: string;
      metric?: string;
      reason?: string;
    }
  | {
      type: "submit_score";
      arenaId: number;
      player: string;
      score: number;
    }
  | {
      type: "close_arena";
      arenaId?: number;
    }
  | {
      type: "finalize_arena";
      arenaId?: number;
    }
  | {
      type: "summarize_arena";
      arenaId?: number;
    }
  | {
      type: "summarize_leaderboard";
      arenaId?: number;
    }
  | {
      type: "summarize_winners";
      arenaId?: number;
    }
  | {
      type: "explain_payouts";
      arenaId?: number;
    }
  | {
      type: "list_arenas";
    }
  | {
      type: "help";
      reason?: string;
    };

export type OperatorResult = {
  mode: "ai" | "rules";
  reply: string;
  action: OperatorIntent["type"];
  arenaId?: number;
  createdArenaId?: number;
  leaderboard?: Array<{
    rank: number;
    user: string;
    score: number;
  }>;
};

export type OperatorEvent = {
  id: string;
  type: string;
  arenaId?: number;
  createdAt: number;
  detail: string;
  metadata?: Record<string, string | number | boolean | null>;
};