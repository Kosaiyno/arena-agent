import { FormEvent, useEffect, useRef, useState } from "react";
import { parseUnits } from "ethers";
import { Leaderboard } from "./components/Leaderboard";
import {
  AgentWalletIdentity,
  Arena,
  ArenaMeta,
  LeaderboardEntry,
  OperatorEvent,
  OperatorStatus,
  RoutePlan,
  RouteTokenInput,
  SwapAndJoinPlan,
  WalletTokenBalance,
  buildSwapAndJoin,
  chatWithOperator,
  getAgentWallet,
  getArenaRoutes,
  getLeaderboard,
  getOperatorHistory,
  getOperatorStatus,
  getX402Requirements,
  getWalletBalances,
  listArenas,
  prepareJoin,
  submitX402Payment,
  submitScore,
} from "./lib/api";
import { claimReward, CustomTokenBalance, executeSwapAndJoin, executeSwapOnly, fetchCustomTokenBalance, getConnectedAddress, getFallbackReward, joinArenaWithWallet, loadCustomTokenAddresses, saveCustomTokenAddress, signX402ExactPayment } from "./lib/contract";

const DEFAULT_CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS ?? "";

function truncate(addr: string): string {
  return addr ? addr.slice(0, 6) + "..." + addr.slice(-4) : "";
}

function fmtOKB(wei: string): string {
  return (Number(wei) / 1e18).toFixed(4).replace(/\.?0+$/, "") + " OKB";
}

function fmtTokenAmount(value: string, decimals = 18, symbol = "OKB"): string {
  const scaled = Number(value) / (10 ** decimals);
  const precision = decimals >= 6 ? 4 : Math.min(decimals, 4);
  return scaled.toFixed(precision).replace(/\.?0+$/, "") + ` ${symbol}`;
}

function fmtTimeLeft(endTime: number): string {
  const remaining = endTime - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return "Ended";
  if (remaining < 60) return remaining + "s left";
  if (remaining < 3600) return Math.floor(remaining / 60) + "m left";
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  return h + "h " + m + "m left";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function describeArenaPurpose(meta: ArenaMeta | null): string {
  if (meta?.metric && meta?.game) {
    return `Most ${meta.metric} in ${meta.game}`;
  }
  if (meta?.metric) {
    return `Competition tracks ${meta.metric}`;
  }
  if (meta?.game) {
    return `${meta.game} challenge`;
  }
  if (meta?.title) {
    return meta.title;
  }
  return "On-chain skill competition";
}

type ArenaFeedItem = {
  id: string;
  createdAt: number;
  arenaId: number;
  title: string;
  detail: string;
  tone: "live" | "success" | "warning" | "neutral";
};

function upsertActivityItem(
  items: ArenaFeedItem[],
  nextItem: ArenaFeedItem,
  limit: number,
): ArenaFeedItem[] {
  return [nextItem, ...items.filter((item) => item.id !== nextItem.id)].slice(0, limit);
}

function fmtRelativeTime(timestamp: number): string {
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 10) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function mapOperatorEvent(event: OperatorEvent): ArenaFeedItem | null {
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
        title: "Arena opened",
        detail: `I translated the request into arena #${event.arenaId}${creationPurpose}, configured the rules, and opened entries.`,
        tone: "live",
      };
    case "monitor_closed_arena":
      return {
        id: event.id,
        createdAt: event.createdAt,
        arenaId: event.arenaId,
        title: "Arena closed",
        detail: `I stopped new entries for arena #${event.arenaId} because the countdown expired and it was time to lock the board.`,
        tone: "warning",
      };
    case "monitor_finalized_arena":
      return {
        id: event.id,
        createdAt: event.createdAt,
        arenaId: event.arenaId,
        title: "Payout finalized",
        detail: `I verified the final ranking for arena #${event.arenaId}, selected the winner, and completed payout settlement.`,
        tone: "success",
      };
    default:
      return {
        id: event.id,
        createdAt: event.createdAt,
        arenaId: event.arenaId,
        title: "Arena update",
        detail: event.detail.replace(/^Monitor\s+/i, "I ").replace(/^Operator\s+/i, "I "),
        tone: "neutral",
      };
  }
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "uniswap-trading-api":
      return "Uniswap";
    case "okx-dex-aggregator":
      return "OKX";
    case "wallet":
      return "Wallet";
    case "direct":
      return "Direct";
    case "insufficient-balance":
      return "Insufficient Balance";
    default:
      return provider;
  }
}

function formatGasUsd(value?: string): string | null {
  if (!value) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  if (numeric === 0) return "$0";
  if (numeric < 0.001) return "<$0.001";
  if (numeric < 0.01) return `$${numeric.toFixed(4)}`;
  if (numeric < 1) return `$${numeric.toFixed(3)}`;
  return `$${numeric.toFixed(2)}`;
}

function settlementTokenLabel(arena: Arena): string {
  return arena.settlementToken?.symbol ?? "OKB";
}

function resolveActiveRoute(
  routes: RoutePlan[],
  preferredSymbol: string,
  fallback: RoutePlan | null,
): RoutePlan | null {
  if (routes.length > 1) {
    return preferredSymbol
      ? routes.find((route) => route.fromToken.symbol === preferredSymbol) ?? null
      : null;
  }
  return fallback;
}

export default function App() {
  const [arenas, setArenas] = useState<Arena[]>([]);
  const [selectedArenaId, setSelectedArenaId] = useState<number | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [arenaMetaMap, setArenaMetaMap] = useState<Record<number, ArenaMeta | null>>({});
  const [walletAddress, setWalletAddress] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [operatorStatus, setOperatorStatus] = useState<OperatorStatus | null>(null);
  const [operatorEvents, setOperatorEvents] = useState<OperatorEvent[]>([]);
  const [operatorPrompt, setOperatorPrompt] = useState<string>("");
  const [scoreForm, setScoreForm] = useState({ user: "", score: "" });
  const [recommendedRoute, setRecommendedRoute] = useState<RoutePlan | null>(null);
  const [candidateRoutes, setCandidateRoutes] = useState<RoutePlan[]>([]);
  const [selectedSwapSourceSymbol, setSelectedSwapSourceSymbol] = useState<string>("");
  const [routeLoading, setRouteLoading] = useState(false);
  const [agentWallet, setAgentWallet] = useState<AgentWalletIdentity | null>(null);
  const [joinStep, setJoinStep] = useState<string>("");
  const [joiningArenaId, setJoiningArenaId] = useState<number | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [walletBalances, setWalletBalances] = useState<WalletTokenBalance[]>([]);
  const [customTokenBalances, setCustomTokenBalances] = useState<CustomTokenBalance[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const [addTokenInput, setAddTokenInput] = useState("");
  const [addTokenLoading, setAddTokenLoading] = useState(false);
  const [addTokenError, setAddTokenError] = useState<string | null>(null);
  const [operatorLoading, setOperatorLoading] = useState(false);
  const [localArenaFeed, setLocalArenaFeed] = useState<Record<number, ArenaFeedItem[]>>({});
  const [personalActivity, setPersonalActivity] = useState<ArenaFeedItem[]>([]);
  const [clockMs, setClockMs] = useState(Date.now());
  const [fallbackRewardWei, setFallbackRewardWei] = useState<string>("0");
  const [allowanceReady, setAllowanceReady] = useState(false);
  const [allowanceLoading, setAllowanceLoading] = useState(false);
  const routeFetchKeyRef = useRef<string>("");
  const connectApprovalWarmupRef = useRef<string>("");
  const personalRouteNarrationRef = useRef<string>("");
  const personalApprovalNarrationRef = useRef<string>("");
  const profileRef = useRef<HTMLDivElement>(null);
  const [chatMessages, setChatMessages] = useState<Array<{ role: "user" | "agent"; text: string }>>([{
    role: "agent",
    text: "Hello! I'm ArenaAgent — your autonomous on-chain competition operator. Tell me what competition to create, or ask about existing arenas.",
  }]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatWindowRef = useRef<HTMLDivElement>(null);
  const nowSec = Math.floor(clockMs / 1000);
  const liveArenas = arenas.filter((arena) => !arena.finalized && !arena.closed && arena.endTime > nowSec);
  const payoutArenas = arenas.filter((arena) => arena.finalized || arena.closed || arena.endTime <= nowSec);

  async function loadCustomRouteTokens(address: string): Promise<RouteTokenInput[]> {
    const savedAddrs = loadCustomTokenAddresses();
    if (savedAddrs.length === 0) return [];

    const customBalances = await Promise.all(
      savedAddrs.map((tokenAddress) => fetchCustomTokenBalance(tokenAddress, address).catch(() => null)),
    );

    return customBalances
      .filter((token): token is CustomTokenBalance => token !== null)
      .map((token) => ({
        symbol: token.symbol,
        name: token.name,
        address: token.address,
        decimals: token.decimals,
        kind: "erc20" as const,
      }));
  }

  async function refreshJoinState(arena: Arena, user: string): Promise<void> {
    routeFetchKeyRef.current = "";
    setRouteLoading(true);

    try {
      const customTokens = await loadCustomRouteTokens(user);
      const response = await getArenaRoutes(arena.id, user, customTokens);
      setRecommendedRoute(response.recommendedRoute);
      setCandidateRoutes(response.candidateRoutes);
    } catch {
      setRecommendedRoute(null);
      setCandidateRoutes([]);
    } finally {
      setRouteLoading(false);
    }

    setAllowanceReady(true);
    setAllowanceLoading(false);

    if (profileOpen) {
      try {
        const balances = await getWalletBalances(user);
        setWalletBalances(balances.balances);
      } catch {
        // Ignore wallet balance refresh failures; join state already updated above.
      }
    }
  }

  async function warmupArenaApprovals(address: string): Promise<void> {
    void address;
  }

  function countLiveErc20Arenas(sourceArenas: Arena[]): number {
    return sourceArenas.filter((arena) => {
      const arenaEnded = arena.closed || arena.finalized || arena.endTime <= Math.floor(Date.now() / 1000);
      return !arenaEnded && arena.settlementToken?.kind === "erc20" && Boolean(arena.settlementToken.address);
    }).length;
  }

  async function refreshArenas(nextId?: number | null) {
    const response = await listArenas();
    setArenas(response.arenas);
    if (response.metaMap) {
      setArenaMetaMap(response.metaMap);
    }
    const arenaId = selectedArenaId;
    if (arenaId) {
      const found = response.arenas.find((a) => a.id === arenaId);
      if (found) {
        const board = await getLeaderboard(arenaId);
        setLeaderboard(board.leaderboard);
        setArenaMetaMap((m) => ({ ...m, [arenaId]: board.meta }));
      }
    }
  }

  function isRpcThrottleError(message: string): boolean {
    const lower = message.toLowerCase();
    return lower.includes("too many rpc calls in batch request")
      || lower.includes("missing response for request")
      || lower.includes("request timeout")
      || lower.includes("bad_data");
  }

  async function confirmJoinedAfterRpcError(arenaId: number, user: string): Promise<boolean> {
    try {
      const response = await listArenas();
      setArenas(response.arenas);
      if (response.metaMap) {
        setArenaMetaMap(response.metaMap);
      }
      const found = response.arenas.find((arena) => arena.id === arenaId);
      return Boolean(found?.players.some((player) => player.toLowerCase() === user.toLowerCase()));
    } catch {
      return false;
    }
  }

  function appendArenaFeedItem(
    arenaId: number,
    item: Omit<ArenaFeedItem, "id" | "createdAt" | "arenaId">,
  ) {
    const nextItem: ArenaFeedItem = {
      id: `${arenaId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      createdAt: Date.now(),
      arenaId,
      ...item,
    };

    setLocalArenaFeed((previous) => ({
      ...previous,
      [arenaId]: [nextItem, ...(previous[arenaId] ?? [])].slice(0, 12),
    }));
  }

  function upsertArenaFeedItem(
    arenaId: number,
    activityKey: string,
    item: Omit<ArenaFeedItem, "id" | "createdAt" | "arenaId">,
  ) {
    const nextItem: ArenaFeedItem = {
      id: `arena-${arenaId}-${activityKey}`,
      createdAt: Date.now(),
      arenaId,
      ...item,
    };

    setLocalArenaFeed((previous) => ({
      ...previous,
      [arenaId]: upsertActivityItem(previous[arenaId] ?? [], nextItem, 12),
    }));
  }

  function appendPersonalActivityItem(
    arenaId: number,
    item: Omit<ArenaFeedItem, "id" | "createdAt" | "arenaId">,
  ) {
    const nextItem: ArenaFeedItem = {
      id: `personal-${arenaId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      createdAt: Date.now(),
      arenaId,
      ...item,
    };

    setPersonalActivity((previous) => [nextItem, ...previous].slice(0, 16));
  }

  function upsertPersonalActivityItem(
    activityKey: string,
    arenaId: number,
    item: Omit<ArenaFeedItem, "id" | "createdAt" | "arenaId">,
  ) {
    const nextItem: ArenaFeedItem = {
      id: `personal-${activityKey}`,
      createdAt: Date.now(),
      arenaId,
      ...item,
    };

    setPersonalActivity((previous) => upsertActivityItem(previous, nextItem, 16));
  }

  function buildArenaFeed(arena: Arena, meta: ArenaMeta | null, activeRouteForArena: RoutePlan | null): ArenaFeedItem[] {
    const persisted = operatorEvents
      .filter((event) => event.arenaId === arena.id)
      .map(mapOperatorEvent)
      .filter((item): item is ArenaFeedItem => item !== null);
    const local = localArenaFeed[arena.id] ?? [];
    const derived: ArenaFeedItem[] = [];
    const arenaName = meta?.title ?? (meta?.game ? `${meta.game} Arena` : `Arena #${arena.id}`);

    if (!arena.closed && !arena.finalized && arena.endTime > nowSec) {
      derived.push({
        id: `derived-live-${arena.id}`,
        createdAt: Date.now(),
        arenaId: arena.id,
        title: "ArenaAgent is coordinating",
        detail: `I'm coordinating ${arenaName}. ${arena.players.length} player${arena.players.length === 1 ? " is" : "s are"} in, and I will close entries in ${fmtTimeLeft(arena.endTime)}.`,
        tone: "live",
      });
    }

    if (leaderboard.length > 0 && selectedArenaId === arena.id) {
      derived.push({
        id: `derived-leader-${arena.id}-${leaderboard[0].user}-${leaderboard[0].score}`,
        createdAt: leaderboard[0].updatedAt,
        arenaId: arena.id,
        title: "Leaderboard lead",
        detail: `I'm tracking ${truncate(leaderboard[0].user)} in first place with ${leaderboard[0].score} ${metricLabelFor(meta)}.`,
        tone: "neutral",
      });
    }

    if (walletAddress && activeRouteForArena?.routeType === "swap_then_join" && !arena.players.some((player) => player.toLowerCase() === walletAddress.toLowerCase())) {
      derived.push({
        id: `derived-route-${arena.id}-${activeRouteForArena.fromToken.symbol}`,
        createdAt: Date.now(),
        arenaId: arena.id,
        title: "Best entry route ready",
        detail: `I found an entry route from ${activeRouteForArena.fromToken.symbol} into ${activeRouteForArena.toToken.symbol} for this arena.`,
        tone: "neutral",
      });
    }

    if (joiningArenaId === arena.id && joinStep) {
      derived.push({
        id: `derived-joining-${arena.id}`,
        createdAt: Date.now(),
        arenaId: arena.id,
        title: "Live action",
        detail: `I'm working on your entry now: ${joinStep}`,
        tone: "live",
      });
    }

    return [...derived, ...local, ...persisted]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 8);
  }

  function metricLabelFor(meta: ArenaMeta | null): string {
    return meta?.metric ? meta.metric : "score";
  }

  function arenaLabelFor(arenaId: number): string {
    const meta = arenaMetaMap[arenaId] ?? null;
    return meta?.title ?? (meta?.game ? `${meta.game} Arena` : `Arena #${arenaId}`);
  }

  function buildAgentThinking(): ArenaFeedItem[] {
    const live: ArenaFeedItem[] = [];

    if (selectedArenaId && joiningArenaId === selectedArenaId && joinStep) {
      live.push({
        id: `personal-live-${selectedArenaId}`,
        createdAt: Date.now() - 150,
        arenaId: selectedArenaId,
        title: "Live execution",
        detail: `I'm working through your current flow: ${joinStep}`,
        tone: "live",
      });
    }

    const arenaWide = buildGeneralActivity().filter((item) => item.id !== "feed-idle");

    const items = [...live, ...personalActivity, ...arenaWide]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 10);

    if (items.length > 0) {
      return items;
    }

    if (walletAddress) {
      return [{
        id: "personal-idle-connected",
        createdAt: Date.now(),
        arenaId: -1,
        title: "Wallet ready",
        detail: "I will keep my live reasoning here, including wallet-specific guidance and the most important arena decisions I am making.",
        tone: "neutral",
      }];
    }

    return [{
      id: "personal-idle",
      createdAt: Date.now(),
      arenaId: -1,
      title: "ArenaAgent standing by",
      detail: "Connect a wallet or open an arena and I will show my live reasoning here, including route checks, approvals, joins, closures, and payout decisions.",
      tone: "neutral",
    }];
  }

  function buildGeneralActivity(): ArenaFeedItem[] {
    const derived = arenas.flatMap((arena) => {
      const meta = arenaMetaMap[arena.id] ?? null;
      const items: ArenaFeedItem[] = [];

      if (!arena.closed && !arena.finalized && arena.endTime > nowSec) {
        items.push({
          id: `global-live-${arena.id}`,
          createdAt: Date.now() - (arena.id % 5) * 1000,
          arenaId: arena.id,
          title: "Arena live",
          detail: `I'm running ${arenaLabelFor(arena.id)} with ${arena.players.length} player${arena.players.length === 1 ? "" : "s"} and ${fmtTimeLeft(arena.endTime)} left on the clock.`,
          tone: "live",
        });
      }

      if (arena.finalized) {
        items.push({
          id: `global-finalized-${arena.id}`,
          createdAt: arena.endTime * 1000,
          arenaId: arena.id,
          title: "Arena finalized",
          detail: `I finished ${arenaLabelFor(arena.id)} and the reward flow is complete.`,
          tone: "success",
        });
      } else if (arena.closed || arena.endTime <= nowSec) {
        items.push({
          id: `global-closed-${arena.id}`,
          createdAt: arena.endTime * 1000,
          arenaId: arena.id,
          title: "Arena closed",
          detail: `I closed ${arenaLabelFor(arena.id)} and I'm waiting to finalize results.`,
          tone: "warning",
        });
      }

      if (selectedArenaId === arena.id && leaderboard.length > 0) {
        items.push({
          id: `global-leader-${arena.id}-${leaderboard[0].user}-${leaderboard[0].score}`,
          createdAt: leaderboard[0].updatedAt,
          arenaId: arena.id,
          title: "Leaderboard lead",
          detail: `I'm tracking ${truncate(leaderboard[0].user)} in first place with ${leaderboard[0].score} ${metricLabelFor(meta)}.`,
          tone: "neutral",
        });
      }

      return items;
    });

    const persisted = operatorEvents
      .map(mapOperatorEvent)
      .filter((item): item is ArenaFeedItem => item !== null);
    const local = Object.values(localArenaFeed).flat();
    const items = [...local, ...persisted, ...derived]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 8);

    if (items.length > 0) {
      return items;
    }

    return [{
      id: "feed-idle",
      createdAt: Date.now(),
      arenaId: -1,
      title: "Waiting for the next arena",
      detail: "I'm standing by. Create an arena or open one to watch what I'm doing in real time.",
      tone: "neutral",
    }];
  }

  async function selectArena(arenaId: number) {
    if (selectedArenaId === arenaId) {
      setSelectedArenaId(null);
      setLeaderboard([]);
      setRecommendedRoute(null);
      setCandidateRoutes([]);
      setSelectedSwapSourceSymbol("");
      return;
    }
    setSelectedArenaId(arenaId);
    setScoreForm({ user: walletAddress, score: "" });
    setRecommendedRoute(null);
    setCandidateRoutes([]);
    setSelectedSwapSourceSymbol("");
    const board = await getLeaderboard(arenaId);
    setLeaderboard(board.leaderboard);
    setArenaMetaMap((m) => ({ ...m, [arenaId]: board.meta }));
  }

  // Initial load
  useEffect(() => {
    void (async () => {
      const [{ arenas: list, metaMap }, status, history, wallet] = await Promise.all([
        listArenas(),
        getOperatorStatus().catch(() => null),
        getOperatorHistory().catch(() => ({ events: [] })),
        getAgentWallet().catch(() => null),
      ]);
      setArenas(list);
      if (metaMap) {
        setArenaMetaMap(metaMap);
      }
      setOperatorStatus(status);
      setOperatorEvents(history.events ?? []);
      setAgentWallet(wallet);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const poll = () => {
      void getOperatorHistory()
        .then((response) => setOperatorEvents(response.events))
        .catch(() => undefined);
    };

    poll();
    const id = setInterval(poll, 10_000);
    return () => clearInterval(id);
  }, []);

  // Auto-fetch best payment route when wallet + arena known
  useEffect(() => {
    const id = setInterval(() => setClockMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!walletAddress || !selectedArenaId) {
      setRecommendedRoute(null);
      setCandidateRoutes([]);
      setSelectedSwapSourceSymbol("");
      setRouteLoading(false);
      routeFetchKeyRef.current = "";
      return;
    }

    const selectedArena = arenas.find((arena) => arena.id === selectedArenaId);
    if (!selectedArena) {
      setRecommendedRoute(null);
      setCandidateRoutes([]);
      setSelectedSwapSourceSymbol("");
      setRouteLoading(false);
      routeFetchKeyRef.current = "";
      return;
    }

    const alreadyJoined = selectedArena.players.some((player) => player.toLowerCase() === walletAddress.toLowerCase());
    const arenaEnded = selectedArena.closed || selectedArena.finalized || selectedArena.endTime <= nowSec;
    if (alreadyJoined || arenaEnded) {
      setRecommendedRoute(null);
      setCandidateRoutes([]);
      setSelectedSwapSourceSymbol("");
      setRouteLoading(false);
      routeFetchKeyRef.current = "";
      return;
    }

    const routeFetchKey = [
      walletAddress.toLowerCase(),
      selectedArena.id,
      selectedArena.entryFeeWei,
      selectedArena.settlementToken?.address ?? selectedArena.settlementToken?.symbol ?? "native",
      selectedArena.players.length,
      selectedArena.closed ? "closed" : "open",
      selectedArena.finalized ? "finalized" : "active",
    ].join(":");

    if (routeFetchKeyRef.current === routeFetchKey) {
      return;
    }

    routeFetchKeyRef.current = routeFetchKey;
    if (personalRouteNarrationRef.current !== routeFetchKey) {
      personalRouteNarrationRef.current = routeFetchKey;
      upsertPersonalActivityItem(`route-${selectedArena.id}`, selectedArena.id, {
        title: "Evaluating entry options",
        detail: `I am checking wallet balances and available liquidity to determine the best way to enter ${arenaLabelFor(selectedArena.id)}.`,
        tone: "live",
      });
    }
    setRouteLoading(true);
    void (async () => {
      try {
        const customTokens = await loadCustomRouteTokens(walletAddress);
        const response = await getArenaRoutes(selectedArenaId, walletAddress, customTokens);
        setRecommendedRoute(response.recommendedRoute);
        setCandidateRoutes(response.candidateRoutes);

        const swapChoices = response.candidateRoutes.filter((route) => route.routeType === "swap_then_join" && (route.provider === "uniswap-trading-api" || route.provider === "okx-dex-aggregator"));
        if (swapChoices.length > 1) {
          upsertPersonalActivityItem(`route-${selectedArena.id}`, selectedArena.id, {
            title: "Multiple routes available",
            detail: `I found ${swapChoices.length} viable funding paths for ${arenaLabelFor(selectedArena.id)}. Choose the token you want me to route from and I will use that route.`,
            tone: "neutral",
          });
        } else if (response.recommendedRoute?.routeType === "direct_join") {
          upsertPersonalActivityItem(`route-${selectedArena.id}`, selectedArena.id, {
            title: "Direct route available",
            detail: `Direct route available — sufficient ${settlementTokenLabel(selectedArena)} balance detected for ${arenaLabelFor(selectedArena.id)}, so no swap is needed.`,
            tone: "success",
          });
        } else if (response.recommendedRoute?.routeType === "swap_then_join") {
          upsertPersonalActivityItem(`route-${selectedArena.id}`, selectedArena.id, {
            title: "Swap route selected",
            detail: `Swap route selected — ${response.recommendedRoute.fromToken.symbol} to ${response.recommendedRoute.toToken.symbol} via ${providerLabel(response.recommendedRoute.provider)} best satisfies the entry requirement.`,
            tone: "neutral",
          });
        } else {
          upsertPersonalActivityItem(`route-${selectedArena.id}`, selectedArena.id, {
            title: "Entry route unavailable",
            detail: `Entry route unavailable — current balances do not cover the ${fmtTokenAmount(selectedArena.entryFeeWei, selectedArena.settlementToken?.decimals ?? 18, settlementTokenLabel(selectedArena))} requirement plus gas for ${arenaLabelFor(selectedArena.id)}.`,
            tone: "warning",
          });
        }
      } catch (error) {
        setRecommendedRoute(null);
        setCandidateRoutes([]);
        upsertPersonalActivityItem(`route-${selectedArena.id}`, selectedArena.id, {
          title: isRpcThrottleError(error instanceof Error ? error.message : String(error)) ? "Route checks delayed" : "Route evaluation failed",
          detail: isRpcThrottleError(error instanceof Error ? error.message : String(error))
            ? `Route checks are temporarily delayed because the X Layer RPC is rate-limiting balance and liquidity reads for ${arenaLabelFor(selectedArena.id)}. Try again in a moment.`
            : `Route evaluation failed — I could not complete balance and liquidity checks for ${arenaLabelFor(selectedArena.id)}.`,
          tone: "warning",
        });
      } finally {
        setRouteLoading(false);
      }
    })();
  }, [walletAddress, selectedArenaId, arenas]);

  useEffect(() => {
    if (!walletAddress) {
      connectApprovalWarmupRef.current = "";
      return;
    }

    const liveErc20ArenaCount = countLiveErc20Arenas(arenas);

    const warmupKey = `${walletAddress.toLowerCase()}:${liveErc20ArenaCount}`;
    if (connectApprovalWarmupRef.current === warmupKey || liveErc20ArenaCount === 0) {
      return;
    }

    connectApprovalWarmupRef.current = warmupKey;
    void warmupArenaApprovals(walletAddress)
      .then(() => {
        setStatusMsg("Wallet connected. x402 entry is ready.");
        upsertPersonalActivityItem("wallet-approval-warmup", -1, {
          title: "x402 entry ready",
          detail: "I evaluated live ERC20 arenas and confirmed that future joins will use one-time x402 authorizations instead of reusable token approvals.",
          tone: "success",
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "x402 warmup was skipped.";
        setStatusMsg(message);
      })
      .finally(() => setJoinStep(""));
  }, [walletAddress, arenas]);

  useEffect(() => {
    const swapChoices = candidateRoutes.filter((route) => route.routeType === "swap_then_join" && (route.provider === "uniswap-trading-api" || route.provider === "okx-dex-aggregator"));
    if (swapChoices.length <= 1) {
      setSelectedSwapSourceSymbol("");
      return;
    }

    if (!swapChoices.some((route) => route.fromToken.symbol === selectedSwapSourceSymbol)) {
      setSelectedSwapSourceSymbol("");
    }
  }, [candidateRoutes, selectedSwapSourceSymbol]);

  useEffect(() => {
    if (!walletAddress || !selectedArenaId) {
      setFallbackRewardWei("0");
      return;
    }
    const selectedArena = arenas.find((arena) => arena.id === selectedArenaId);
    if (!selectedArena || !selectedArena.finalized) {
      setFallbackRewardWei("0");
      return;
    }
    void getFallbackReward(DEFAULT_CONTRACT_ADDRESS, selectedArenaId, walletAddress)
      .then((value) => setFallbackRewardWei(value.toString()))
      .catch(() => setFallbackRewardWei("0"));
  }, [walletAddress, selectedArenaId, arenas]);

  useEffect(() => {
    if (!walletAddress || !selectedArenaId || !DEFAULT_CONTRACT_ADDRESS) {
      setAllowanceReady(false);
      setAllowanceLoading(false);
      personalApprovalNarrationRef.current = "";
      return;
    }
    const selectedArena = arenas.find((arena) => arena.id === selectedArenaId);
    if (!selectedArena || selectedArena.settlementToken?.kind !== "erc20" || !selectedArena.settlementToken.address) {
      setAllowanceReady(true);
      setAllowanceLoading(false);
      personalApprovalNarrationRef.current = "";
      return;
    }
    setAllowanceReady(true);
    setAllowanceLoading(false);
    personalApprovalNarrationRef.current = "";
  }, [walletAddress, selectedArenaId, arenas]);

  async function completeX402Join(arena: Arena): Promise<void> {
    setJoinStep("Requesting x402 payment requirements...");
    const requirements = await getX402Requirements(arena.id);
    const challenge = requirements.okxX402;
    if (!challenge?.supported || !challenge.accepts?.length) {
      throw new Error(challenge?.reason ?? "x402 is not available for this arena.");
    }

    const headerValue = await signX402ExactPayment(challenge, setJoinStep);
    setJoinStep("Submitting x402 payment...");
    await submitX402Payment(arena.id, headerValue);
  }

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(() => void refreshArenas(), 10_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArenaId]);

  useEffect(() => {
    try {
      const el = chatWindowRef.current;
      if (el) {
        // Keep the chat window scrolled to the bottom when messages change.
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        return;
      }
    } catch {
      // Fallback to previous behavior if needed
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages]);

  // Close profile panel on outside click
  useEffect(() => {
    if (!profileOpen) return;
    function onOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [profileOpen]);

  async function connectWallet() {
    try {
      const address = await getConnectedAddress();
      const arenasResponse = arenas.length > 0 ? null : await listArenas().catch(() => null);
      const nextArenas = arenasResponse?.arenas ?? arenas;
      const nextMetaMap = arenasResponse?.metaMap;
      if (arenasResponse) {
        setArenas(arenasResponse.arenas);
      }
      if (nextMetaMap) {
        setArenaMetaMap(nextMetaMap);
      }

      setWalletAddress(address);
      setScoreForm((c) => ({ ...c, user: address }));
      upsertPersonalActivityItem("wallet-status", -1, {
        title: "Wallet connected",
        detail: `Wallet connected — I can now inspect balances, determine routes, and guide x402-authorized entries for ${truncate(address)}.`,
        tone: "success",
      });
      const liveErc20ArenaCount = countLiveErc20Arenas(nextArenas);
      if (liveErc20ArenaCount === 0) {
        setStatusMsg("Connected: " + address + ".");
        return;
      }

      const warmupKey = `${address.toLowerCase()}:${liveErc20ArenaCount}`;
      connectApprovalWarmupRef.current = warmupKey;
      setStatusMsg("Connected: " + address + ". Preparing x402 entry flow...");
      await warmupArenaApprovals(address);
      setStatusMsg("Wallet connected. x402 entry is ready.");
      setJoinStep("");
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : "Failed to connect wallet");
    }
  }

  async function openProfile() {
    if (!walletAddress) { void connectWallet(); return; }
    const opening = !profileOpen;
    setProfileOpen(opening);
    if (opening) {
      setBalancesLoading(true);
      setBalancesError(null);
      upsertPersonalActivityItem("wallet-balance-check", -1, {
        title: "Refreshing balances",
        detail: "I am refreshing wallet balances so route selection is based on the latest token inventory, not stale data.",
        tone: "live",
      });
      try {
        const [res, savedAddrs] = await Promise.all([
          getWalletBalances(walletAddress),
          Promise.resolve(loadCustomTokenAddresses()),
        ]);
        setWalletBalances(res.balances);
        if (savedAddrs.length > 0) {
          const customs = await Promise.all(
            savedAddrs.map((addr) => fetchCustomTokenBalance(addr, walletAddress).catch(() => null)),
          );
          setCustomTokenBalances(customs.filter((c): c is CustomTokenBalance => c !== null));
        } else {
          setCustomTokenBalances([]);
        }
        upsertPersonalActivityItem("wallet-balance-check", -1, {
          title: "Balances refreshed",
          detail: "Balances refreshed — I can now compare available tokens against entry requirements and choose the best path.",
          tone: "success",
        });
      } catch (err) {
        setBalancesError(err instanceof Error ? err.message : "Failed to load balances");
        setWalletBalances([]);
        upsertPersonalActivityItem("wallet-balance-check", -1, {
          title: "Balance refresh failed",
          detail: err instanceof Error ? err.message : "I could not refresh wallet balances.",
          tone: "warning",
        });
      } finally {
        setBalancesLoading(false);
      }
    }
  }

  async function handleAddToken(e: FormEvent) {
    e.preventDefault();
    const addr = addTokenInput.trim();
    if (!addr || !walletAddress) return;
    setAddTokenLoading(true);
    setAddTokenError(null);
    try {
      const tb = await fetchCustomTokenBalance(addr, walletAddress);
      saveCustomTokenAddress(addr);
      setCustomTokenBalances((prev) => {
        const filtered = prev.filter((t) => t.address.toLowerCase() !== addr.toLowerCase());
        return [...filtered, tb];
      });
      setAddTokenInput("");
    } catch {
      setAddTokenError("Not a valid ERC20 on X Layer");
    } finally {
      setAddTokenLoading(false);
    }
  }

  async function handleJoin(arena: Arena) {
    const swapChoices = candidateRoutes.filter((route) => route.routeType === "swap_then_join" && (route.provider === "uniswap-trading-api" || route.provider === "okx-dex-aggregator"));
    const activeRoute = resolveActiveRoute(swapChoices, selectedSwapSourceSymbol, recommendedRoute);

    if (!walletAddress) { setStatusMsg("Connect a wallet first."); return; }
    if (arena.players.some((player) => player.toLowerCase() === walletAddress.toLowerCase())) {
      setStatusMsg("You already joined this arena.");
      return;
    }
    if (arena.closed || arena.finalized || arena.endTime <= nowSec) {
      setStatusMsg("Arena has already ended. Joining is closed.");
      return;
    }
    setJoiningArenaId(arena.id);
    try {
      upsertArenaFeedItem(arena.id, "join-flow", {
        title: "Joining arena",
        detail: `Joining ${arenaLabelFor(arena.id)} — I am validating wallet balance, route availability, and whether the entry can be completed directly or through x402 authorization.`,
        tone: "live",
      });
      if (activeRoute?.routeType === "swap_then_join") {
        if (arena.settlementToken?.kind === "erc20") {
          setJoinStep(`Swap into ${arena.settlementToken.symbol} first, then ArenaAgent will request x402 authorization to finalize the join.`);
          upsertArenaFeedItem(arena.id, "join-flow", {
            title: "Join paused",
            detail: `Join paused — I determined that ${activeRoute.fromToken.symbol} should be converted into ${arena.settlementToken.symbol}, and the x402 authorization can only happen after the settlement token lands in your wallet.`,
            tone: "warning",
          });
          setStatusMsg(`Swap into ${arena.settlementToken.symbol} first, then join again to authorize the x402 payment.`);
          return;
        }
        upsertArenaFeedItem(arena.id, "join-flow", {
          title: "Joining arena",
          detail: `Joining ${arenaLabelFor(arena.id)} — selected ${activeRoute.fromToken.symbol} to ${activeRoute.toToken.symbol} via ${providerLabel(activeRoute.provider)} because that is the best funding path for the entry requirement.`,
          tone: "live",
        });
        setJoinStep("Building swap plan...");
        const [whole, frac = ""] = activeRoute.expectedInputAmount.split(".");
        const safeFrac = frac.slice(0, activeRoute.fromToken.decimals);
        const safeAmount = safeFrac ? whole + "." + safeFrac : whole;
        const fromAmountBaseUnits = parseUnits(safeAmount, activeRoute.fromToken.decimals).toString();
        const plan: SwapAndJoinPlan = await buildSwapAndJoin(arena.id, {
          user: walletAddress,
          fromTokenSymbol: activeRoute.fromToken.symbol,
          fromToken: activeRoute.fromToken,
          fromAmountBaseUnits,
        });
        await executeSwapAndJoin(plan, setJoinStep);
        setJoinStep("Joined successfully.");
        upsertArenaFeedItem(arena.id, "join-flow", {
          title: "Join completed",
          detail: `Join completed — converted ${activeRoute.fromToken.symbol} into ${activeRoute.toToken.symbol} and confirmed your entry into ${arenaLabelFor(arena.id)}.`,
          tone: "success",
        });
        setStatusMsg("Joined arena #" + arena.id + " via swap.");
      } else {
        upsertArenaFeedItem(arena.id, "join-flow", {
          title: "Joining arena",
          detail: `Joining ${arenaLabelFor(arena.id)} — direct route available because sufficient ${settlementTokenLabel(arena)} balance was detected in your wallet.`,
          tone: "live",
        });
        if (arena.settlementToken?.kind === "erc20") {
          await completeX402Join(arena);
          setJoinStep("Joined successfully.");
          upsertArenaFeedItem(arena.id, "join-flow", {
            title: "Join completed",
            detail: `Join completed — your wallet signed a one-time x402 authorization and ArenaAgent finalized your ${arena.settlementToken.symbol} entry into ${arenaLabelFor(arena.id)}.`,
            tone: "success",
          });
          setStatusMsg("Joined arena #" + arena.id + " via x402.");
        } else {
          setJoinStep("Preparing transaction...");
          const join = await prepareJoin(arena.id, walletAddress);
          const contractAddress = join.contractAddress || DEFAULT_CONTRACT_ADDRESS;
          setJoinStep("Waiting for wallet confirmation...");
          await joinArenaWithWallet(contractAddress, arena.id, join.entryFeeWei ?? arena.entryFeeWei, setJoinStep);
          setJoinStep("Joined successfully.");
          upsertArenaFeedItem(arena.id, "join-flow", {
            title: "Join completed",
            detail: `Join completed — I saw your wallet confirm the entry transaction and locked your participation in ${arenaLabelFor(arena.id)}.`,
            tone: "success",
          });
          setStatusMsg("Joined arena #" + arena.id + ".");
        }
      }
      await refreshArenas(arena.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to join";
      if (isRpcThrottleError(message)) {
        const confirmedJoined = await confirmJoinedAfterRpcError(arena.id, walletAddress);
        if (confirmedJoined) {
          setJoinStep("Joined successfully.");
          upsertArenaFeedItem(arena.id, "join-flow", {
            title: "Join confirmed",
            detail: `Your join to ${arenaLabelFor(arena.id)} was confirmed on-chain, but X Layer RPC throttling delayed the status refresh.`,
            tone: "success",
          });
          setStatusMsg(`Joined arena #${arena.id}. RPC refresh was delayed, but your entry is confirmed.`);
          return;
        }

        setJoinStep("Waiting for chain refresh...");
        upsertArenaFeedItem(arena.id, "join-flow", {
          title: "Join submitted",
          detail: `Your transaction was submitted, but X Layer RPC throttling delayed confirmation checks for ${arenaLabelFor(arena.id)}. Refresh and verify in a moment.`,
          tone: "warning",
        });
        setStatusMsg("Join may be complete, but X Layer RPC throttling delayed confirmation. Refresh in a moment.");
        return;
      }
      setJoinStep(message);
      upsertArenaFeedItem(arena.id, "join-flow", {
        title: "Join failed",
        detail: message,
        tone: "warning",
      });
      setStatusMsg(message);
    } finally {
      window.setTimeout(() => {
        setJoinStep("");
        setJoiningArenaId(null);
      }, 1500);
    }
  }

  async function handleSwapToSettlement(arena: Arena) {
    const swapChoices = candidateRoutes.filter((route) => route.routeType === "swap_then_join" && (route.provider === "uniswap-trading-api" || route.provider === "okx-dex-aggregator"));
    const activeRoute = resolveActiveRoute(swapChoices, selectedSwapSourceSymbol, recommendedRoute);

    if (!walletAddress) {
      setStatusMsg("Connect a wallet first.");
      return;
    }
    if (!activeRoute || activeRoute.routeType !== "swap_then_join") {
      setStatusMsg("No swap route is available right now.");
      return;
    }

    setJoiningArenaId(arena.id);
    try {
      upsertArenaFeedItem(arena.id, "swap-flow", {
        title: "Preparing swap",
        detail: `Preparing swap — selected ${activeRoute.fromToken.symbol} to ${arena.settlementToken?.symbol ?? "the settlement token"} via ${providerLabel(activeRoute.provider)} because that route best satisfies the entry requirement.`,
        tone: "live",
      });
      setJoinStep("Building swap plan...");
      const [whole, frac = ""] = activeRoute.expectedInputAmount.split(".");
      const safeFrac = frac.slice(0, activeRoute.fromToken.decimals);
      const safeAmount = safeFrac ? whole + "." + safeFrac : whole;
      const fromAmountBaseUnits = parseUnits(safeAmount, activeRoute.fromToken.decimals).toString();
      const plan: SwapAndJoinPlan = await buildSwapAndJoin(arena.id, {
        user: walletAddress,
        fromTokenSymbol: activeRoute.fromToken.symbol,
        fromToken: activeRoute.fromToken,
        fromAmountBaseUnits,
      });
      await executeSwapOnly(plan, setJoinStep);
      upsertArenaFeedItem(arena.id, "swap-flow", {
        title: "Swap executed",
        detail: `Swap executed — converted ${activeRoute.fromToken.symbol} into ${arena.settlementToken?.symbol ?? "the arena token"} to meet the entry requirement, and I am now checking whether I can finish the join immediately.`,
        tone: "success",
      });
      await refreshJoinState(arena, walletAddress);
      setJoinStep("Finalizing arena join...");

      if (arena.settlementToken?.kind === "erc20") {
        await completeX402Join(arena);
        setJoinStep("Joined successfully.");
        upsertArenaFeedItem(arena.id, "swap-flow", {
          title: "Swap and join complete",
          detail: `Swap and join complete — I converted into ${arena.settlementToken.symbol}, then finalized entry into ${arenaLabelFor(arena.id)} with a one-time x402 authorization.`,
          tone: "success",
        });
        setStatusMsg(`Swap complete and joined arena #${arena.id} via x402.`);
      } else {
        const join = await prepareJoin(arena.id, walletAddress);
        if (join.relayed) {
          setJoinStep("Joined successfully.");
          upsertArenaFeedItem(arena.id, "swap-flow", {
            title: "Swap and join complete",
            detail: `Swap and join complete — I converted into the settlement token, verified the balance, and relayed your final entry into ${arenaLabelFor(arena.id)}.`,
            tone: "success",
          });
          setStatusMsg(`Swap complete and joined arena #${arena.id}.`);
        } else {
          setJoinStep(`${arena.settlementToken?.symbol ?? "Settlement token"} received.`);
          upsertArenaFeedItem(arena.id, "swap-flow", {
            title: "Awaiting final join",
            detail: `Awaiting final join — ${arena.settlementToken?.symbol ?? "Settlement token"} is now in your wallet, but I still need your final join action to complete entry.`,
            tone: "warning",
          });
          setStatusMsg(`Swap complete. If you now hold enough ${arena.settlementToken?.symbol ?? "tokens"}, tap Join to finish entering arena #${arena.id}.`);
        }
      }
      await refreshArenas(arena.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Swap failed";
      if (isRpcThrottleError(message)) {
        const confirmedJoined = await confirmJoinedAfterRpcError(arena.id, walletAddress);
        if (confirmedJoined) {
          setJoinStep("Joined successfully.");
          upsertArenaFeedItem(arena.id, "swap-flow", {
            title: "Swap and join confirmed",
            detail: `The swap and relay flow for ${arenaLabelFor(arena.id)} completed, but X Layer RPC throttling delayed the post-join refresh. Your entry is confirmed on-chain.`,
            tone: "success",
          });
          setStatusMsg(`Swap complete and joined arena #${arena.id}. RPC refresh was delayed, but your entry is confirmed.`);
          return;
        }

        setJoinStep("Waiting for chain refresh...");
        upsertArenaFeedItem(arena.id, "swap-flow", {
          title: "Swap submitted",
          detail: `Swap execution finished, but X Layer RPC throttling delayed the final join confirmation check for ${arenaLabelFor(arena.id)}. Refresh in a moment to verify the result.`,
          tone: "warning",
        });
        setStatusMsg("Swap completed, but X Layer RPC throttling delayed join confirmation. Refresh in a moment.");
        return;
      }
      setJoinStep(message);
      upsertArenaFeedItem(arena.id, "swap-flow", {
        title: "Swap failed",
        detail: message,
        tone: "warning",
      });
      setStatusMsg(message);
    } finally {
      window.setTimeout(() => {
        setJoinStep("");
        setJoiningArenaId(null);
      }, 1500);
    }
  }

  async function handleSubmitScore(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedArenaId) return;
    try {
      const res = await submitScore(selectedArenaId, { user: scoreForm.user, score: Number(scoreForm.score) });
      setLeaderboard(res.leaderboard);
      appendArenaFeedItem(selectedArenaId, {
        title: "Result recorded",
        detail: `I recorded ${truncate(scoreForm.user)} with ${scoreForm.score} ${metricLabelFor(arenaMetaMap[selectedArenaId] ?? null)} for arena #${selectedArenaId}.`,
        tone: "neutral",
      });
      setStatusMsg("Score recorded for " + truncate(scoreForm.user) + ".");
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : "Failed to submit score");
    }
  }

  async function handleClaim() {
    if (!selectedArenaId) return;
    try {
      await claimReward(DEFAULT_CONTRACT_ADDRESS, selectedArenaId);
      appendArenaFeedItem(selectedArenaId, {
        title: "Fallback claim sent",
        detail: `I submitted the fallback reward claim transaction for arena #${selectedArenaId}.`,
        tone: "success",
      });
      setStatusMsg("Reward claimed for arena #" + selectedArenaId + ".");
      await refreshArenas(selectedArenaId);
    } catch (error) {
      setStatusMsg(error instanceof Error ? error.message : "Failed to claim reward");
    }
  }

  async function handleOperatorSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const userText = operatorPrompt.trim();
    if (!userText) return;
    setChatMessages((prev) => [...prev, { role: "user" as const, text: userText }]);
    setOperatorPrompt("");
    setOperatorLoading(true);
    try {
      const result = await chatWithOperator({ prompt: userText, selectedArenaId, history: chatMessages });
      setOperatorLoading(false);
      setChatMessages((prev) => [...prev, { role: "agent" as const, text: result.reply }]);
      if (result.action === "create_arena" && result.createdArenaId) {
        const { arenas: list, metaMap } = await listArenas();
        setArenas(list);
        if (metaMap) {
          setArenaMetaMap(metaMap);
        }
        const newId = result.createdArenaId;
      } else if (result.arenaId) {
        await refreshArenas(result.arenaId);
      } else {
        const { arenas: list, metaMap } = await listArenas();
        setArenas(list);
        if (metaMap) {
          setArenaMetaMap(metaMap);
        }
      }
      if (result.leaderboard) {
        setLeaderboard(result.leaderboard.map((entry) => ({ ...entry, updatedAt: Date.now() })));
      }
    } catch (error) {
      setOperatorLoading(false);
      setChatMessages((prev) => [...prev, {
        role: "agent" as const,
        text: error instanceof Error ? error.message : "Something went wrong.",
      }]);
    }
  }

  function renderArenaCard(arena: Arena) {
    const isExpanded = selectedArenaId === arena.id;
    const meta = arenaMetaMap[arena.id] ?? null;
    const metricLabel = meta?.metric ? capitalize(meta.metric) : "Score";
    const timeLeft = fmtTimeLeft(arena.endTime);
    const hasJoined = Boolean(walletAddress) && arena.players.some((player) => player.toLowerCase() === walletAddress.toLowerCase());
    const arenaEnded = arena.finalized || arena.closed || arena.endTime <= nowSec;
    const statusClass = arena.finalized
      ? "tag-status tag-status--done"
      : arenaEnded
      ? "tag-status tag-status--closed"
      : "tag-status tag-status--open";
    const statusLabel = arena.finalized ? "Finalized" : arenaEnded ? "Ended" : "Open";
    const tokenSymbol = arena.settlementToken?.symbol ?? "OKB";
    const tokenDecimals = arena.settlementToken?.decimals ?? 18;
    const swapChoices = candidateRoutes.filter((route) => route.routeType === "swap_then_join" && (route.provider === "uniswap-trading-api" || route.provider === "okx-dex-aggregator"));
    const shouldChooseSwapSource = swapChoices.length > 1;
    const activeRoute = shouldChooseSwapSource
      ? (selectedSwapSourceSymbol ? swapChoices.find((route) => route.fromToken.symbol === selectedSwapSourceSymbol) ?? null : null)
      : recommendedRoute;
    const needsApproval = false;
    const hasSwapChoices = swapChoices.length > 0;
    const hasDirectRoute = recommendedRoute?.routeType === "direct_join";
    const needsManualSwapFirst = Boolean(walletAddress)
      && arena.settlementToken?.kind === "erc20"
      && true
      && !hasDirectRoute
      && hasSwapChoices;
    const swapRouteUnavailable = needsManualSwapFirst
      && Boolean(activeRoute)
      && activeRoute?.provider !== "uniswap-trading-api"
      && activeRoute?.provider !== "okx-dex-aggregator";
    const routeBadgeLabel = activeRoute?.routeType === "direct_join"
      ? "Direct"
      : needsManualSwapFirst
        ? "Swap Required"
        : "Auto Swap";
    const purposeText = describeArenaPurpose(meta);

    return (
      <div key={arena.id} className={"arena-accordion" + (isExpanded ? " arena-accordion--open" : "")}>
        <button
          className="arena-accordion-header"
          type="button"
          onClick={() => void selectArena(arena.id)}
        >
          <div className="arena-acc-inner">
            <div className="arena-acc-row1">
              <span className="arena-acc-num">#{arena.id}</span>
              <span className="arena-acc-name">
                {meta?.title ?? (meta?.game ? meta.game + " Arena" : "Arena #" + arena.id)}
              </span>
              <div className="arena-acc-row1-right">
                {!arenaEnded && <span className="arena-acc-time">{timeLeft}</span>}
                <span className={statusClass}>{statusLabel}</span>
                <span className="arena-acc-chevron">{isExpanded ? "▲" : "▼"}</span>
              </div>
            </div>
            <div className="arena-acc-row2">
              <span>{fmtTokenAmount(arena.entryFeeWei, tokenDecimals, tokenSymbol)} entry</span>
              <span className="arena-acc-sep">·</span>
              <span>Pool {fmtTokenAmount(arena.totalPoolWei, tokenDecimals, tokenSymbol)}</span>
              <span className="arena-acc-sep">·</span>
              <span>{arena.players.length} player{arena.players.length !== 1 ? "s" : ""}</span>
              {meta?.metric && (
                <><span className="arena-acc-sep">·</span>
                <span className="arena-acc-metric">{capitalize(meta.metric)} competition</span></>
              )}
              {meta?.game && !meta?.metric && (
                <><span className="arena-acc-sep">·</span>
                <span className="arena-acc-metric">{meta.game}</span></>
              )}
            </div>
            <div className="arena-acc-row3">{purposeText}</div>
          </div>
        </button>

        {isExpanded && (
          <div className="arena-accordion-body">
            <div className="arena-desc">
                  <div className="arena-desc-top">
                    <h3 className="arena-desc-title">
                      {meta?.title ?? (meta?.game ? meta.game + " Arena" : "Arena #" + arena.id)}
                    </h3>
                    <div className="arena-desc-badges">
                      {meta?.game && <span className="tag">{meta.game}</span>}
                      {meta?.metric && <span className="tag">{metricLabel} competition</span>}
                      <span className={statusClass}>{statusLabel}</span>
                    </div>
                  </div>
                  <div className="arena-desc-stats">
                    <div className="arena-desc-stat">
                      <span>Entry fee</span>
                      <strong>{fmtTokenAmount(arena.entryFeeWei, tokenDecimals, tokenSymbol)}</strong>
                    </div>
                    <div className="arena-desc-stat">
                      <span>Prize pool</span>
                      <strong>{fmtTokenAmount(arena.totalPoolWei, tokenDecimals, tokenSymbol)}</strong>
                    </div>
                    <div className="arena-desc-stat">
                      <span>Players</span>
                      <strong>{arena.players.length}</strong>
                    </div>
                    <div className="arena-desc-stat">
                      <span>{arenaEnded ? "Status" : "Time left"}</span>
                      <strong className={arenaEnded ? "stat-muted" : "stat-accent"}>
                        {arenaEnded ? statusLabel : timeLeft}
                      </strong>
                    </div>
                  </div>
                  <p className="arena-desc-footer">
                    {arena.settlementToken ? `Settled in ${arena.settlementToken.symbol} · ` : ""}
                    Winner takes the full prize pool · Agent distributes automatically
                  </p>
            </div>

            {!arenaEnded && (
              <div className="action-card">
                <h3>Join Competition</h3>

                {!walletAddress ? (
                  <>
                    <p className="route-hint-text">
                      Connect your wallet to see payment options and join this arena.
                    </p>
                    <button type="button" className="btn-primary" onClick={connectWallet}>
                      Connect Wallet
                    </button>
                  </>
                ) : hasJoined ? (
                  <>
                    <p className="route-hint-text route-hint-text--success">
                      You already joined this arena. Wait for results and payout.
                    </p>
                    <button type="button" className="btn-primary btn-join" disabled>
                      Already Joined
                    </button>
                  </>
                ) : needsApproval ? (
                  <>
                    <p className="route-hint-text">
                      x402 mode is active. ArenaAgent will request a one-time payment authorization when you join.
                    </p>
                    <button
                      type="button"
                      className="btn-primary btn-join"
                      onClick={() => void handleJoin(arena)}
                      disabled={routeLoading || (joiningArenaId === arena.id && Boolean(joinStep))}
                    >
                      {joiningArenaId === arena.id && joinStep ? joinStep : `Join via x402 · ${fmtTokenAmount(arena.entryFeeWei, tokenDecimals, tokenSymbol)}`}
                    </button>
                  </>
                ) : needsManualSwapFirst ? (
                  <>
                    {shouldChooseSwapSource && (
                      <div className="route-info route-info--swap">
                        <div className="route-info-header">
                          <span className="route-badge">Choose Source</span>
                        </div>
                        <p className="route-explanation">Multiple tokens in your wallet can cover this arena. Choose which token you want ArenaAgent to swap into {tokenSymbol}.</p>
                        <div className="route-steps">
                          {swapChoices.map((route) => {
                            const isSelected = selectedSwapSourceSymbol === route.fromToken.symbol;
                            return (
                              <button
                                key={route.fromToken.symbol}
                                type="button"
                                className={"btn-secondary-action" + (isSelected ? " btn-secondary-action--active" : "")}
                                onClick={() => setSelectedSwapSourceSymbol(route.fromToken.symbol)}
                              >
                                {route.fromToken.symbol} · {route.expectedInputAmount}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {activeRoute && (
                      <div className="route-info route-info--swap">
                        <div className="route-info-header">
                          <span className="route-badge">{routeBadgeLabel}</span>
                          <span className="route-provider">via {providerLabel(activeRoute.provider)}</span>
                          {formatGasUsd(activeRoute.gasFeeUsd) && (
                            <span className="route-gas">est. gas {formatGasUsd(activeRoute.gasFeeUsd)}</span>
                          )}
                        </div>
                        <p className="route-explanation">{activeRoute.explanation}</p>
                        {activeRoute.steps.length > 0 && (
                          <ol className="route-steps">
                            {activeRoute.steps.map((step, si) => (
                              <li key={si}>{step}</li>
                            ))}
                          </ol>
                        )}
                      </div>
                    )}
                    <p className="route-hint-text">
                      {shouldChooseSwapSource && !selectedSwapSourceSymbol
                        ? `Choose which token you want ArenaAgent to swap into ${tokenSymbol}. After the swap, ArenaAgent will request a one-time x402 authorization to finalize the join.`
                        : swapRouteUnavailable
                          ? activeRoute?.provider === "insufficient-balance"
                            ? (activeRoute?.explanation ?? `Your wallet does not hold enough ${activeRoute?.fromToken.symbol ?? "source token"} for this route.`)
                            : `Your wallet approved ${tokenSymbol}, but the current X Layer setup does not currently have a live ${activeRoute?.fromToken.symbol ?? "source token"} to ${tokenSymbol} swap route. This arena will only work if your wallet already holds ${tokenSymbol}.`
                          : `After your swap is confirmed, ArenaAgent will request a one-time x402 authorization and finalize the join automatically.`}
                    </p>
                    <button
                      type="button"
                      className="btn-primary btn-join"
                      onClick={() => void handleSwapToSettlement(arena)}
                      disabled={swapRouteUnavailable || routeLoading || (joiningArenaId === arena.id && Boolean(joinStep)) || (shouldChooseSwapSource && !selectedSwapSourceSymbol)}
                    >
                      {joiningArenaId === arena.id && joinStep
                        ? joinStep
                        : swapRouteUnavailable
                          ? activeRoute?.provider === "insufficient-balance"
                            ? `Not Enough ${activeRoute?.fromToken.symbol ?? tokenSymbol}`
                            : `${tokenSymbol} Swap Unavailable`
                          : shouldChooseSwapSource && !selectedSwapSourceSymbol
                            ? "Choose A Token First"
                          : `Swap To ${tokenSymbol} First`}
                    </button>
                  </>
                ) : (
                  <>
                    {routeLoading && (
                      <div className="route-info route-info--loading">
                        <span className="route-spinner" />
                        <span>Calculating best payment route...</span>
                      </div>
                    )}

                    {!routeLoading && activeRoute && (
                      <div className={
                        "route-info " +
                        (activeRoute.routeType === "swap_then_join"
                          ? "route-info--swap"
                          : "route-info--direct")
                      }>
                        <div className="route-info-header">
                          <span className="route-badge">{routeBadgeLabel}</span>
                          <span className="route-provider">via {providerLabel(activeRoute.provider)}</span>
                          {formatGasUsd(activeRoute.gasFeeUsd) && (
                            <span className="route-gas">est. gas {formatGasUsd(activeRoute.gasFeeUsd)}</span>
                          )}
                        </div>
                        <p className="route-explanation">{activeRoute.explanation}</p>
                        {activeRoute.steps.length > 0 && (
                          <ol className="route-steps">
                            {activeRoute.steps.map((step, si) => (
                              <li key={si}>{step}</li>
                            ))}
                          </ol>
                        )}
                      </div>
                    )}

                    {!routeLoading && !recommendedRoute && (
                      <p className="route-hint-text">
                        No route found yet. Hold one of the supported stablecoins for entry and keep some OKB for gas.
                      </p>
                    )}

                    <button
                      type="button"
                      className="btn-primary btn-join"
                      onClick={() => void handleJoin(arena)}
                      disabled={routeLoading || (joiningArenaId === arena.id && Boolean(joinStep)) || hasJoined}
                    >
                      {joiningArenaId === arena.id && joinStep ? joinStep : ("Join · " + fmtTokenAmount(arena.entryFeeWei, tokenDecimals, tokenSymbol))}
                    </button>
                    {joiningArenaId === arena.id && joinStep && (
                      <p className="route-hint-text">{joinStep}</p>
                    )}
                  </>
                )}
              </div>
            )}

            {arenaEnded && !arena.finalized && (
              <div className="action-card action-card--settling">
                <h3>Payout In Progress</h3>
                <p>This competition has ended. Joining is closed and rewards will unlock after finalization.</p>
              </div>
            )}

            <Leaderboard entries={leaderboard} metric={meta?.metric} game={meta?.game} />

            {!arenaEnded && !arena.finalized && (
              <div className="action-card">
                <h3>Record Result</h3>
                <form className="score-form" onSubmit={handleSubmitScore}>
                  <input
                    placeholder="Player wallet address (0x...)"
                    value={scoreForm.user}
                    onChange={(e) => setScoreForm((c) => ({ ...c, user: e.target.value }))}
                  />
                  <input
                    type="number"
                    placeholder={metricLabel + " scored"}
                    value={scoreForm.score}
                    onChange={(e) => setScoreForm((c) => ({ ...c, score: e.target.value }))}
                  />
                  <button type="submit" className="btn-secondary-action">
                    Record {metricLabel}
                  </button>
                </form>
              </div>
            )}

            {arena.finalized && (
              <div className="action-card action-card--winner">
                <h3>Rewards Processed</h3>
                <p>
                  {walletAddress
                    ? "Arena finalized. Winners are paid automatically during finalization."
                    : "Arena finalized. Winners are paid automatically during finalization."}
                </p>
                {walletAddress && fallbackRewardWei !== "0" && (
                  <>
                    <p>A fallback claim is available for your wallet because the automatic payout did not complete.</p>
                  <button type="button" className="btn-primary" onClick={handleClaim}>
                    Claim Fallback Reward
                  </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const agentThinkingItems = buildAgentThinking();

  return (
    <div className="app-shell">

      {/* Topbar */}
      <header className="topbar">
        <div className="topbar-brand">
          <span className="brand-orb" />
          <img className="brand-logo" src="/arena-agent-logo.png" alt="ArenaAgent logo" />
          <span className="brand-name">ArenaAgent</span>
          <span className="brand-chain">X Layer</span>
        </div>
        <div className="topbar-right">
          {statusMsg && <span className="status-inline">{statusMsg}</span>}
          <span className={operatorStatus?.aiEnabled ? "mode-badge mode-badge--ai" : "mode-badge"}>
            {operatorStatus?.aiEnabled ? ("AI · " + (operatorStatus.model ?? "llm")) : "Rules"}
          </span>
          <div className="wallet-wrap" ref={profileRef}>
            <button
              className={"btn-connect" + (profileOpen ? " btn-connect--active" : "")}
              type="button"
              onClick={() => void openProfile()}
            >
              {walletAddress ? (
                <><span className="wallet-dot" />{truncate(walletAddress)}</>
              ) : "Connect Wallet"}
            </button>

            {profileOpen && walletAddress && (
              <div className="wallet-profile">
                <div className="wallet-profile-head">
                  <span className="wallet-profile-label">Connected on X Layer</span>
                  <button
                    type="button"
                    className="wallet-profile-close"
                    onClick={() => setProfileOpen(false)}
                  >&#x2715;</button>
                </div>
                <div className="wallet-profile-addr">
                  <code>{walletAddress}</code>
                </div>
                <div className="wallet-profile-section-label">Token Balances</div>
                {balancesLoading ? (
                  <div className="wallet-profile-loading">
                    <span className="route-spinner" />
                    <span>Fetching balances...</span>
                  </div>
                ) : balancesError ? (
                  <p className="wallet-profile-error">{balancesError}</p>
                ) : (
                  <div className="wallet-profile-balances">
                    {walletBalances.filter((b) => b.token.kind === "native" || b.token.address !== null).map((b) => (
                      <div key={b.token.symbol} className="wallet-balance-row">
                        <div className="wallet-balance-token">
                          <span className="wallet-balance-symbol">{b.token.symbol}</span>
                          <span className="wallet-balance-name">{b.token.name}</span>
                        </div>
                        <div className="wallet-balance-right">
                          <span className="wallet-balance-amount">{b.formattedBalance}</span>
                          {b.canCoverEntry && <span className="wallet-balance-ok">&#x2714;</span>}
                        </div>
                      </div>
                    ))}
                    {customTokenBalances.map((b) => (
                      <div key={b.address} className="wallet-balance-row">
                        <div className="wallet-balance-token">
                          <span className="wallet-balance-symbol">{b.symbol}</span>
                          <span className="wallet-balance-name">{b.name}</span>
                        </div>
                        <div className="wallet-balance-right">
                          <span className="wallet-balance-amount">{b.formattedBalance}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <form className="wallet-add-token" onSubmit={(e) => void handleAddToken(e)}>
                  <input
                    className="wallet-add-token-input"
                    type="text"
                    placeholder="Add token by contract address…"
                    value={addTokenInput}
                    onChange={(e) => { setAddTokenInput(e.target.value); setAddTokenError(null); }}
                  />
                  <button className="wallet-add-token-btn" type="submit" disabled={addTokenLoading || !addTokenInput.trim()}>
                    {addTokenLoading ? <span className="route-spinner" /> : "+"}
                  </button>
                  {addTokenError && <p className="wallet-add-token-error">{addTokenError}</p>}
                </form>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="hero-section">
        <div className="hero-copy">
          <p className="hero-eyebrow">Autonomous · On-Chain · Trustless</p>
          <h1 className="hero-title">The AI that runs<br />your competition</h1>
          <ul className="hero-features">
            <li><span className="feat-dot" />Creates arenas on-chain from natural language</li>
            <li><span className="feat-dot" />Collects entry fees directly into the smart contract pool</li>
            <li><span className="feat-dot" />Auto-closes arenas and distributes rewards to winners</li>
          </ul>
          {agentWallet && (
            <p className="hero-agent-addr">Operator: <code>{truncate(agentWallet.address)}</code></p>
          )}
        </div>

        <div className="chat-card">
          <div className="chat-card-header">
            <span className="chat-orb" />
            <span>Agent</span>
            <span className="chat-live">&#x25CF; live</span>
          </div>
          <div className="chat-window" ref={chatWindowRef}>
            {chatMessages.map((msg, i) => (
              <div key={i} className={"chat-row chat-row--" + msg.role}>
                <div className="chat-bubble"><p>{msg.text}</p></div>
              </div>
            ))}
            {operatorLoading && (
              <div className="chat-row chat-row--agent">
                <div className="chat-bubble"><p>Thinking...</p></div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-input-row" onSubmit={handleOperatorSubmit}>
            <input
              value={operatorPrompt}
              onChange={(e) => setOperatorPrompt(e.target.value)}
              placeholder="Create a Valorant kills arena, 0.01 OKB, 10 minutes..."
            />
            <button type="submit" disabled={operatorLoading}>{operatorLoading ? "..." : "↑"}</button>
          </form>
        </div>
      </section>

      {/* Arenas — accordion, each self-contained */}
      <section className="arenas-layout">
        <div className="arenas-main">
          <section className="arenas-section">
            <div className="arenas-header">
              <h2>Live Arenas</h2>
              <span className="arenas-count">{liveArenas.length} arena{liveArenas.length !== 1 ? "s" : ""}</span>
            </div>

            {liveArenas.length === 0 && (
              <div className="empty-detail">
                <p>No live arenas right now. Ask the agent to create one above.</p>
              </div>
            )}

            {liveArenas.map(renderArenaCard)}
          </section>

          <section className="arenas-section arenas-section--secondary">
            <div className="arenas-header">
              <h2>Payouts & Results</h2>
              <span className="arenas-count">{payoutArenas.length} arena{payoutArenas.length !== 1 ? "s" : ""}</span>
            </div>

            {payoutArenas.length === 0 && (
              <div className="empty-detail">
                <p>No arenas are settling or finalized yet.</p>
              </div>
            )}

            {payoutArenas.map(renderArenaCard)}
          </section>
        </div>

        <aside className="arena-activity-rail arena-activity-rail--page">
          <div className="arena-activity-card">
            <div className="arena-activity-head">
              <div>
                <span className="arena-activity-kicker">Arena agent activity</span>
                <h4>All arenas</h4>
              </div>
              <span className="arena-activity-live">live</span>
            </div>
            <section className="arena-activity-section arena-activity-section--thinking">
              <div className="arena-activity-section-head">
                <div className="arena-activity-section-copy">
                  <span className="arena-activity-section-hint">I evaluate balances, determine optimal swap routes, execute joins and payouts autonomously, and monitor all arenas in real time to keep you updated on what I&apos;m doing and what&apos;s happening.</span>
                </div>
                <span className="arena-activity-section-note">{walletAddress ? truncate(walletAddress) : "All arenas"}</span>
              </div>
              <div className="arena-activity-list arena-activity-list--stacked arena-activity-list--panel">
                {agentThinkingItems.map((item) => (
                  <article key={item.id} className={`arena-activity-item arena-activity-item--${item.tone}`}>
                    <div className="arena-activity-item-head">
                      <span className="arena-activity-arena-label">{item.arenaId > -1 ? arenaLabelFor(item.arenaId) : "You"}</span>
                      <span className="arena-activity-time">{fmtRelativeTime(item.createdAt)}</span>
                    </div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </aside>
      </section>
    </div>
  );
}
