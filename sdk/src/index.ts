export type Arena = {
  id: number;
  entryFeeWei: string;
  totalPoolWei: string;
  createdAt: number;
  endTime: number;
  closed: boolean;
  finalized: boolean;
  players: string[];
  settlementToken?: {
    symbol: string;
    name: string;
    address: string | null;
    decimals: number;
    kind: "native" | "erc20";
  };
};

export type ArenaMeta = {
  title?: string;
  game?: string;
  metric?: string;
};

export type LeaderboardEntry = {
  rank: number;
  user: string;
  score: number;
  updatedAt: number;
};

export type OperatorReply = {
  mode: "ai" | "rules";
  reply: string;
  action: "create_arena" | "close_arena" | "finalize_arena" | "summarize_arena" | "summarize_leaderboard" | "summarize_winners" | "explain_payouts" | "help";
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

export type RouteTokenInput = {
  symbol: string;
  name: string;
  address: string | null;
  decimals: number;
  kind: "native" | "erc20";
};

export type WalletTokenBalance = {
  token: RouteTokenInput;
  rawBalance: string;
  formattedBalance: string;
  estimatedValueInSettlement: number;
  canCoverEntry: boolean;
};

export type RoutePlan = {
  provider: string;
  fromToken: RouteTokenInput;
  toToken: RouteTokenInput;
  expectedInputAmount: string;
  expectedOutputAmount: string;
  routeType: "direct_join" | "swap_then_join";
  explanation: string;
  steps: string[];
  gasFeeUsd?: string;
  routeSummary?: string;
  quoteId?: string;
};

export type ApprovalTransaction = {
  to: string;
  data: string;
  value: string;
  spender: string;
  label?: string;
};

export type SwapTransaction = {
  to: string;
  data: string;
  value: string;
  gasEstimate?: string;
  provider: string;
};

export type SwapAndJoinPlan = {
  provider: string;
  isDirect: boolean;
  requiresApproval: boolean;
  approvalTxs: ApprovalTransaction[];
  swapTx: SwapTransaction | null;
  joinTx: SwapTransaction;
};

export type AgentWalletIdentity = {
  name: string;
  address: string;
  role: string;
  chain: {
    name: string;
    chainId: number;
  };
  capabilities: string[];
  skills: string[];
  integrations: {
    uniswapTradingApi: boolean;
    onchainOs: boolean;
    x402: boolean;
  };
  contractAddress: string;
};

export type X402PaymentRequirements = {
  error: string;
  x402: true;
  payment: {
    scheme: string;
    network: string;
    maxAmountRequired: string;
    resource: string;
    description: string;
    payTo: string;
    asset: string;
    extra: {
      name: string;
      version: string;
      contract: string;
      method: string;
      arenaId: number;
    };
  };
};

export type X402Verification = {
  verified: boolean;
  arenaId: number;
  player: string;
  txHash: string;
  message: string;
};

export type OperatorStatus = {
  aiEnabled: boolean;
  mode: "ai" | "rules";
  model: string | null;
  capabilities: string[];
  skills: Array<{
    name: string;
    status: string;
    note: string;
  }>;
  integrations?: {
    uniswapTradingApi: boolean;
    onchainOs: boolean;
  };
};

export type CreateArenaInput = {
  entryFeeWei: string;
  durationSeconds: number;
  settlementTokenSymbol?: string;
  title?: string;
  game?: string;
  metric?: string;
};

export type ActivityFeedItem = {
  id: string;
  createdAt: number;
  arenaId: number;
  arenaLabel: string;
  title: string;
  detail: string;
  tone: "live" | "success" | "warning" | "neutral";
  source: "operator-event" | "arena-state" | "leaderboard";
};

export type ActivityFeedOptions = {
  limit?: number;
  leaderboardArenaId?: number | null;
};

type RequestOptions = {
  headers?: Record<string, string>;
};

function truncateAddress(address: string): string {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";
}

function formatTimeLeft(endTime: number, nowSeconds: number): string {
  const remaining = endTime - nowSeconds;
  if (remaining <= 0) return "ended";
  if (remaining < 60) return `${remaining}s left`;
  if (remaining < 3600) return `${Math.floor(remaining / 60)}m left`;
  const hours = Math.floor(remaining / 3600);
  const minutes = Math.floor((remaining % 3600) / 60);
  return `${hours}h ${minutes}m left`;
}

function metricLabel(meta: ArenaMeta | null | undefined): string {
  return meta?.metric ?? "score";
}

function arenaLabel(arenaId: number, metaMap?: Record<number, ArenaMeta | null>): string {
  const meta = metaMap?.[arenaId] ?? null;
  return meta?.title ?? (meta?.game ? `${meta.game} Arena` : `Arena #${arenaId}`);
}

function mapOperatorEventToActivityItem(
  event: OperatorEvent,
  metaMap?: Record<number, ArenaMeta | null>,
): ActivityFeedItem | null {
  if (typeof event.arenaId !== "number") {
    return null;
  }

  const metadata = event.metadata ?? {};
  const metric = typeof metadata.metric === "string" && metadata.metric ? metadata.metric : null;
  const game = typeof metadata.game === "string" && metadata.game ? metadata.game : null;
  const creationPurpose = metric && game
    ? ` for ${metric} in ${game}`
    : metric
      ? ` for ${metric}`
      : game
        ? ` for ${game}`
        : "";

  switch (event.type) {
    case "operator_created_arena":
      return {
        id: event.id,
        createdAt: event.createdAt,
        arenaId: event.arenaId,
        arenaLabel: arenaLabel(event.arenaId, metaMap),
        title: "Arena opened",
        detail: `I translated the request into arena #${event.arenaId}${creationPurpose}, configured the rules, and opened entries.`,
        tone: "live",
        source: "operator-event",
      };
    case "monitor_closed_arena":
      return {
        id: event.id,
        createdAt: event.createdAt,
        arenaId: event.arenaId,
        arenaLabel: arenaLabel(event.arenaId, metaMap),
        title: "Arena closed",
        detail: `I stopped new entries for arena #${event.arenaId} because the countdown expired and it was time to lock the board.`,
        tone: "warning",
        source: "operator-event",
      };
    case "monitor_finalized_arena":
      return {
        id: event.id,
        createdAt: event.createdAt,
        arenaId: event.arenaId,
        arenaLabel: arenaLabel(event.arenaId, metaMap),
        title: "Payout finalized",
        detail: `I verified the final ranking for arena #${event.arenaId}, selected the winner, and completed payout settlement.`,
        tone: "success",
        source: "operator-event",
      };
    default:
      return {
        id: event.id,
        createdAt: event.createdAt,
        arenaId: event.arenaId,
        arenaLabel: arenaLabel(event.arenaId, metaMap),
        title: "Arena update",
        detail: event.detail.replace(/^Monitor\s+/i, "I ").replace(/^Operator\s+/i, "I "),
        tone: "neutral",
        source: "operator-event",
      };
  }
}

export function buildActivityFeed(params: {
  arenas: Arena[];
  metaMap?: Record<number, ArenaMeta | null>;
  events?: OperatorEvent[];
  leaderboardArenaId?: number | null;
  leaderboard?: LeaderboardEntry[];
  limit?: number;
  nowMs?: number;
}): ActivityFeedItem[] {
  const {
    arenas,
    metaMap,
    events = [],
    leaderboardArenaId,
    leaderboard = [],
    limit = 10,
    nowMs = Date.now(),
  } = params;
  const nowSeconds = Math.floor(nowMs / 1000);

  const arenaStateItems: ActivityFeedItem[] = arenas.flatMap((arena): ActivityFeedItem[] => {
    const label = arenaLabel(arena.id, metaMap);
    if (!arena.closed && !arena.finalized && arena.endTime > nowSeconds) {
      return [{
        id: `arena-live-${arena.id}`,
        createdAt: nowMs - (arena.id % 5) * 1000,
        arenaId: arena.id,
        arenaLabel: label,
        title: "Arena live",
        detail: `I am running ${label} with ${arena.players.length} player${arena.players.length === 1 ? "" : "s"} and ${formatTimeLeft(arena.endTime, nowSeconds)} on the clock.`,
        tone: "live" as const,
        source: "arena-state" as const,
      }];
    }

    if (arena.finalized) {
      return [{
        id: `arena-finalized-${arena.id}`,
        createdAt: arena.endTime * 1000,
        arenaId: arena.id,
        arenaLabel: label,
        title: "Arena finalized",
        detail: `I finished ${label} and completed the reward flow.`,
        tone: "success" as const,
        source: "arena-state" as const,
      }];
    }

    return [{
      id: `arena-closed-${arena.id}`,
      createdAt: arena.endTime * 1000,
      arenaId: arena.id,
      arenaLabel: label,
      title: "Arena closed",
      detail: `I closed ${label} and I am waiting to finalize results.`,
      tone: "warning" as const,
      source: "arena-state" as const,
    }];
  });

  const operatorItems = events
    .map((event) => mapOperatorEventToActivityItem(event, metaMap))
    .filter((item): item is ActivityFeedItem => item !== null);

  const leaderboardItems: ActivityFeedItem[] = leaderboardArenaId && leaderboard.length > 0
    ? [{
        id: `leader-${leaderboardArenaId}-${leaderboard[0].user}-${leaderboard[0].score}`,
        createdAt: leaderboard[0].updatedAt,
        arenaId: leaderboardArenaId,
        arenaLabel: arenaLabel(leaderboardArenaId, metaMap),
        title: "Leaderboard lead",
        detail: `I am tracking ${truncateAddress(leaderboard[0].user)} in first place with ${leaderboard[0].score} ${metricLabel(metaMap?.[leaderboardArenaId] ?? null)}.`,
        tone: "neutral" as const,
        source: "leaderboard" as const,
      }]
    : [];

  const items: ActivityFeedItem[] = [...leaderboardItems, ...operatorItems, ...arenaStateItems]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit);

  if (items.length > 0) {
    return items;
  }

  return [{
    id: "activity-idle",
    createdAt: nowMs,
    arenaId: -1,
    arenaLabel: "Standby",
    title: "Waiting for the next arena",
    detail: "I am standing by. Create an arena or fetch activity again to watch what I am doing in real time.",
    tone: "neutral",
    source: "arena-state",
  }];
}

export class ArenaAgentClient {
  constructor(
    private readonly apiBase: string,
    private readonly options: RequestOptions = {},
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, {
      headers: {
        "Content-Type": "application/json",
        ...(this.options.headers ?? {}),
        ...(init?.headers ?? {}),
      },
      ...init,
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `Request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  }

  listArenas(): Promise<{ arenas: Arena[]; metaMap?: Record<number, ArenaMeta | null> }> {
    return this.request("/arena");
  }

  createArena(input: CreateArenaInput): Promise<{ arena: Arena; meta?: ArenaMeta }> {
    return this.request("/arena", {
      method: "POST",
      body: JSON.stringify({
        settlementTokenSymbol: input.settlementTokenSymbol ?? "USDC",
        ...input,
      }),
    });
  }

  createArenaFromPrompt(prompt: string, selectedArenaId?: number | null): Promise<OperatorReply> {
    return this.chatWithOperator({ prompt, selectedArenaId });
  }

  prepareJoin(arenaId: number, user: string): Promise<{
    arenaId: number;
    user: string;
    contractAddress?: string;
    entryFeeWei?: string;
    settlementToken?: Arena["settlementToken"];
    joinMethod?: string;
    relayed?: boolean;
    note: string;
  }> {
    return this.request(`/arena/${arenaId}/join`, {
      method: "POST",
      body: JSON.stringify({ user }),
    });
  }

  submitScore(arenaId: number, user: string, score: number): Promise<{ leaderboard: LeaderboardEntry[] }> {
    return this.request(`/arena/${arenaId}/score`, {
      method: "POST",
      body: JSON.stringify({ user, score }),
    });
  }

  getLeaderboard(arenaId: number): Promise<{ arena: Arena; leaderboard: LeaderboardEntry[]; meta: ArenaMeta | null }> {
    return this.request(`/arena/${arenaId}/leaderboard`);
  }

  getArenaRoutes(arenaId: number, user: string, customTokens: RouteTokenInput[] = []): Promise<{
    arena: Arena;
    user: string;
    balances: WalletTokenBalance[];
    recommendedRoute: RoutePlan | null;
    candidateRoutes: RoutePlan[];
  }> {
    return this.request(`/arena/${arenaId}/routes`, {
      method: "POST",
      body: JSON.stringify({ user, customTokens }),
    });
  }

  buildSwapAndJoin(arenaId: number, payload: { user: string; fromTokenSymbol?: string; fromToken?: RouteTokenInput; fromAmountBaseUnits?: string }): Promise<SwapAndJoinPlan> {
    return this.request(`/arena/${arenaId}/swap-and-join`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  getAgentWallet(): Promise<AgentWalletIdentity> {
    return this.request("/agent/wallet");
  }

  getOperatorStatus(): Promise<OperatorStatus> {
    return this.request("/operator/status");
  }

  getOperatorHistory(): Promise<{ events: OperatorEvent[] }> {
    return this.request("/operator/history");
  }

  async getActivityFeed(options: ActivityFeedOptions = {}): Promise<ActivityFeedItem[]> {
    const [arenaResponse, historyResponse, leaderboardResponse] = await Promise.all([
      this.listArenas(),
      this.getOperatorHistory(),
      options.leaderboardArenaId ? this.getLeaderboard(options.leaderboardArenaId).catch(() => null) : Promise.resolve(null),
    ]);

    return buildActivityFeed({
      arenas: arenaResponse.arenas,
      metaMap: arenaResponse.metaMap,
      events: historyResponse.events,
      leaderboardArenaId: options.leaderboardArenaId ?? null,
      leaderboard: leaderboardResponse?.leaderboard ?? [],
      limit: options.limit,
    });
  }

  chatWithOperator(payload: { prompt: string; selectedArenaId?: number | null; history?: Array<{ role: "user" | "agent"; text: string }> }): Promise<OperatorReply> {
    return this.request("/operator/chat", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  getWalletBalances(user: string): Promise<{ user: string; balances: WalletTokenBalance[] }> {
    return this.request(`/wallet/balances?user=${encodeURIComponent(user)}`);
  }

  async getX402Requirements(arenaId: number): Promise<X402PaymentRequirements> {
    const response = await fetch(`${this.apiBase}/arena/${arenaId}/x402-join`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.headers ?? {}),
      },
      body: JSON.stringify({}),
    });
    const data = await response.json() as X402PaymentRequirements;
    if (response.status === 402) {
      return data;
    }
    throw new Error((data as unknown as { error?: string }).error ?? `Unexpected status: ${response.status}`);
  }

  verifyX402Payment(arenaId: number, txHash: string): Promise<X402Verification> {
    return this.request(`/arena/${arenaId}/x402-join`, {
      method: "POST",
      headers: { "x-payment-proof": txHash },
      body: JSON.stringify({}),
    });
  }
}