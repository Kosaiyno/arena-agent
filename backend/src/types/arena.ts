export type TokenInfo = {
  symbol: string;
  name: string;
  address: string | null;
  decimals: number;
  kind: "native" | "erc20";
};

export type ArenaState = {
  id: number;
  entryFeeWei: string;
  totalPoolWei: string;
  createdAt: number;
  endTime: number;
  closed: boolean;
  finalized: boolean;
  entryTokenAddress?: string | null;
  players: string[];
  settlementToken?: TokenInfo;
};

export type ScoreEntry = {
  user: string;
  score: number;
  updatedAt: number;
};

export type LeaderboardEntry = ScoreEntry & {
  rank: number;
};

export type WalletTokenBalance = {
  token: TokenInfo;
  rawBalance: string;
  formattedBalance: string;
  estimatedValueInSettlement: number;
  canCoverEntry: boolean;
};

export type RoutePlan = {
  provider: string;
  fromToken: TokenInfo;
  toToken: TokenInfo;
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
