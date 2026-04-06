const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

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

export type LeaderboardEntry = {
  rank: number;
  user: string;
  score: number;
  updatedAt: number;
};

export type ArenaMeta = {
  title?: string;
  game?: string;
  metric?: string;
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

export type WalletTokenBalance = {
  token: {
    symbol: string;
    name: string;
    address: string | null;
    decimals: number;
    kind: "native" | "erc20";
  };
  rawBalance: string;
  formattedBalance: string;
  estimatedValueInSettlement: number;
  canCoverEntry: boolean;
};

export type RoutePlan = {
  provider: string;
  fromToken: WalletTokenBalance["token"];
  toToken: WalletTokenBalance["token"];
  expectedInputAmount: string;
  expectedOutputAmount: string;
  routeType: "direct_join" | "swap_then_join";
  explanation: string;
  steps: string[];
  gasFeeUsd?: string;
  routeSummary?: string;
  quoteId?: string;
};

export type SwapTransaction = {
  to: string;
  data: string;
  value: string;
  gasEstimate?: string;
  provider: string;
};

export type ApprovalTransaction = {
  to: string;
  data: string;
  value: string;
  spender: string;
  label?: string;
};

export type SwapAndJoinPlan = {
  provider: string;
  isDirect: boolean;
  requiresApproval: boolean;
  approvalTxs: ApprovalTransaction[];
  swapTx: SwapTransaction | null;
  joinTx: SwapTransaction;
};

export type RouteTokenInput = {
  symbol: string;
  name: string;
  address: string | null;
  decimals: number;
  kind: "native" | "erc20";
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
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

export async function listArenas(): Promise<{ arenas: Arena[]; metaMap?: Record<number, ArenaMeta | null> }> {
  return request("/arena");
}

export async function createArena(payload: {
  entryFeeWei: string;
  durationSeconds: number;
  settlementTokenSymbol: string;
  title?: string;
  game?: string;
  metric?: string;
}): Promise<{ arena: Arena; meta?: ArenaMeta }> {
  return request("/arena", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function prepareJoin(arenaId: number, user: string): Promise<{
  arenaId: number;
  user: string;
  contractAddress?: string;
  entryFeeWei?: string;
  settlementToken?: Arena["settlementToken"];
  joinMethod?: string;
  relayed?: boolean;
  note: string;
}> {
  return request(`/arena/${arenaId}/join`, {
    method: "POST",
    body: JSON.stringify({ user }),
  });
}

export async function submitScore(arenaId: number, payload: { user: string; score: number }): Promise<{
  leaderboard: LeaderboardEntry[];
}> {
  return request(`/arena/${arenaId}/score`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getLeaderboard(arenaId: number): Promise<{ arena: Arena; leaderboard: LeaderboardEntry[]; meta: ArenaMeta | null }> {
  return request(`/arena/${arenaId}/leaderboard`);
}

export async function getOperatorStatus(): Promise<OperatorStatus> {
  return request("/operator/status");
}

export async function chatWithOperator(payload: { prompt: string; selectedArenaId?: number | null; history?: Array<{ role: "user" | "agent"; text: string }> }): Promise<OperatorReply> {
  return request("/operator/chat", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getOperatorHistory(): Promise<{ events: OperatorEvent[] }> {
  return request("/operator/history");
}

export async function getArenaRoutes(arenaId: number, user: string, customTokens: RouteTokenInput[] = []): Promise<{
  arena: Arena;
  user: string;
  balances: WalletTokenBalance[];
  recommendedRoute: RoutePlan | null;
  candidateRoutes: RoutePlan[];
}> {
  return request(`/arena/${arenaId}/routes`, {
    method: "POST",
    body: JSON.stringify({ user, customTokens }),
  });
}

export async function getAgentWallet(): Promise<AgentWalletIdentity> {
  return request("/agent/wallet");
}

export async function getX402Requirements(arenaId: number): Promise<X402PaymentRequirements> {
  const response = await fetch(`${API_BASE}/arena/${arenaId}/x402-join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await response.json() as X402PaymentRequirements;
  if (response.status === 402) return data;
  throw new Error((data as unknown as { error?: string }).error ?? `Unexpected status: ${response.status}`);
}

export async function verifyX402Payment(arenaId: number, txHash: string): Promise<X402Verification> {
  return request(`/arena/${arenaId}/x402-join`, {
    method: "POST",
    headers: { "x-payment-proof": txHash },
    body: JSON.stringify({}),
  });
}

export async function buildSwapAndJoin(
  arenaId: number,
  payload: { user: string; fromTokenSymbol?: string; fromToken?: RouteTokenInput; fromAmountBaseUnits?: string },
): Promise<SwapAndJoinPlan> {
  return request(`/arena/${arenaId}/swap-and-join`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getWalletBalances(user: string): Promise<{ user: string; balances: WalletTokenBalance[] }> {
  return request(`/wallet/balances?user=${encodeURIComponent(user)}`);
}
