import { formatUnits, parseEther, parseUnits } from "ethers";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../config/env.js";
import { TokenInfo } from "../types/arena.js";
import { OperatorEvent, OperatorIntent, OperatorResult } from "../types/operator.js";
import { ContractService } from "./contractService.js";
import { OnchainOsService } from "./onchainOsService.js";
import { PayoutService } from "./payoutService.js";
import { ScoreService } from "./scoreService.js";
import { ArenaMeta, StateStore } from "./stateStore.js";
import { UniswapTradeService } from "./uniswapTradeService.js";

type OperatorContext = {
  selectedArenaId?: number | null;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

export class OperatorService {
  constructor(
    private readonly contractService: ContractService,
    private readonly scoreService: ScoreService,
    private readonly stateStore: StateStore,
    private readonly uniswapTradeService: UniswapTradeService,
    private readonly onchainOsService: OnchainOsService,
  ) {}

  // Load repository README to ground AI replies. If unavailable, leave empty.
  private readonly repoReadme: string = (() => {
    try {
      const p = resolve(process.cwd(), "../README.md");
      return String(readFileSync(p, "utf8")).slice(0, 12000);
    } catch {
      try {
        const p2 = resolve(process.cwd(), "README.md");
        return String(readFileSync(p2, "utf8")).slice(0, 12000);
      } catch {
        return "";
      }
    }
  })();

  // Hard-coded deterministic replies for specific user prompts.
  private readonly hardcodedReplies: Array<{ regex: RegExp; reply: string }> = [
    { regex: /\b(who\s+(built|made|developed|created)|who\s+built)\b/i, reply: "Built by Vigo (Kosaiyno)." },
    { regex: /\b(who\s+are\s+you|who\s+is\s+arenaagent|identity|what\s+are\s+you)\b/i, reply: "I am ArenaAgent, an autonomous on-chain competition operator." },
    { regex: /\b(x402|x 402|402 payment|required payment|payment protocol)\b/i, reply: "x402 is supported for join verification. Automated x402 winner-payout execution is planned but not enabled in this demo." },
  ];

  getStatus() {
    const onchainStatus = this.onchainOsService.getStatus();
    return {
      aiEnabled: Boolean(env.openAiApiKey),
      mode: env.openAiApiKey ? "ai" : "rules",
      model: env.openAiApiKey ? env.openAiModel : null,
      capabilities: [
        "Create an arena from natural language",
        "Close or finalize arenas on command",
        "Explain arena state",
        "Summarize leaderboard standings",
        "Explain payout splits and winners",
      ],
      skills: [
        {
          name: "Onchain OS skills",
          status: onchainStatus.enabled ? "configured" : "ready",
          note: "Portfolio enrichment, DEX swap, gateway, and x402-compatible payment flows aligned with X Layer.",
        },
        {
          name: "Uniswap AI skills",
          status: this.uniswapTradeService.isEnabled() ? "configured" : "ready",
          note: "swap-integration via Trading API for live best-route quotes.",
        },
      ],
      integrations: {
        uniswapTradingApi: this.uniswapTradeService.isEnabled(),
        onchainOs: onchainStatus.enabled,
      },
    };
  }

  getHistory(limit = 20): OperatorEvent[] {
    return this.stateStore.getOperatorEvents(limit);
  }

  private getCreateSettlementToken(symbol?: string): TokenInfo {
    const desiredSymbol = symbol ?? "USDC";
    return env.supportedTokens.find((token) => token.symbol.toLowerCase() === desiredSymbol.toLowerCase())
      ?? env.supportedTokens.find((token) => token.symbol === "USDC")
      ?? env.supportedTokens[0];
  }

  private getArenaSettlementToken(arenaId: number, entryTokenAddress?: string | null): TokenInfo {
    const configuredSymbol = this.stateStore.getArenaConfig(arenaId)?.settlementTokenSymbol;
    if (configuredSymbol) {
      return this.getCreateSettlementToken(configuredSymbol);
    }

    if (entryTokenAddress) {
      return env.supportedTokens.find((token) => token.address?.toLowerCase() === entryTokenAddress.toLowerCase())
        ?? this.getCreateSettlementToken();
    }

    return this.getCreateSettlementToken();
  }

  private formatTokenAmount(rawAmount: string, token: TokenInfo): string {
    const formatted = formatUnits(rawAmount, token.decimals);
    if (!formatted.includes(".")) {
      return formatted;
    }

    return formatted.replace(/0+$/, "").replace(/\.$/, "");
  }

  async handlePrompt(prompt: string, context: OperatorContext, history: Array<{ role: "user" | "agent"; text: string }> = []): Promise<OperatorResult> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return {
        mode: env.openAiApiKey ? "ai" : "rules",
        reply: "Ask the operator to create an arena, inspect an arena, or explain a leaderboard.",
        action: "help",
      };
    }

    const intent = await this.resolveIntent(normalizedPrompt, context, history);
    let result: OperatorResult;
    try {
      result = await this.executeIntent(intent, context);
    } catch (err) {
      const friendly = this.friendlyContractError(err);
      return { mode: env.openAiApiKey ? "ai" : "rules", action: "help", reply: friendly };
    }
    const aiReply = (intent as Record<string, unknown>).aiReply as string | undefined;

    // For help/conversational results: use the AI's reply from intent resolution
    if (aiReply && result.action === "help") {
      return { ...result, reply: aiReply };
    }

    return result;
  }

  private friendlyContractError(err: unknown): string {
    const errObj = err as Record<string, unknown>;
    const errorName = (errObj?.errorName as string | undefined) ?? "";
    const data = (errObj?.data as string | undefined) ?? "";
    const msg = err instanceof Error ? err.message : String(err);
    const combined = `${errorName} ${data} ${msg}`;

    if (combined.includes("ArenaClosedAlready") || combined.includes("0xb2f356ad")) return "That arena is already closed. Use 'list arenas' to see which ones are still open.";
    if (combined.includes("ArenaStillOpen") || combined.includes("0x31320cdc")) return "That arena's competition window hasn't expired yet — you can only close it after the end time passes. Check 'summarize arena X' to see when it ends.";
    if (combined.includes("ArenaNotClosed") || combined.includes("0x74716666")) return "That arena hasn't been closed yet. Close it first, then finalize.";
    if (combined.includes("ArenaAlreadyFinalized") || combined.includes("0x531502ff")) return "That arena has already been finalized.";
    if (combined.includes("ArenaMissing") || combined.includes("0xced19ba0")) return "That arena ID doesn't exist on-chain. Use 'list arenas' to see valid IDs.";
    if (combined.includes("OnlyOperator") || combined.includes("0x27e1f1e5")) return "This action requires the operator wallet. Make sure the backend is using the correct private key.";
    if (combined.includes("BigNumberish") || combined.includes("Cannot convert")) return "I can only handle one arena at a time. Please specify a single arena ID, e.g. 'close arena 2'.";
    return `On-chain error: ${msg.slice(0, 120)}`;
  }

  private async naturalizeReply(dataReply: string, originalPrompt: string): Promise<string> {
    const response = await fetch(`${env.openAiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.openAiApiKey}` },
      body: JSON.stringify({
        model: env.openAiModel,
        temperature: 0.6,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content: "You are ArenaAgent, an on-chain competition operator on X Layer. Rephrase the following data report as a natural, confident operator response in 1-3 sentences. Keep all facts exact. IMPORTANT: Always convert wei amounts to OKB (divide by 10^18, e.g. 10000000000000000 wei = 0.01 OKB). Never show raw wei to the user. Never show raw seconds — convert to minutes or hours. Do not add information not in the data. Return only the rephrased sentence(s), no JSON.",
          },
          { role: "user", content: `User asked: "${originalPrompt}"\nData: ${dataReply}` },
        ],
      }),
    });
    if (!response.ok) throw new Error(`naturalizeReply failed: ${response.status}`);
    const data = (await response.json()) as ChatCompletionResponse;
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }

  private async resolveIntent(prompt: string, context: OperatorContext, history: Array<{ role: "user" | "agent"; text: string }> = []): Promise<OperatorIntent> {
    const rulesIntent = this.resolveIntentWithRules(prompt, context, history);
    console.log('[DEBUG] resolveIntent rulesIntent:', JSON.stringify(rulesIntent));
    // If rulesIntent is a special strict help (e.g., factual repo-sourced reply),
    // return it immediately even when AI is enabled.
    if ((rulesIntent as any).strict === true) {
      return rulesIntent;
    }

    if (rulesIntent.type !== "help" || !env.openAiApiKey) {
      return rulesIntent;
    }

    try {
      return await this.resolveIntentWithAi(prompt, context, history);
    } catch (err) {
      console.error("[AI] resolveIntentWithAi failed:", err instanceof Error ? err.message : String(err));
      return rulesIntent;
    }
  }

  private async resolveIntentWithAi(prompt: string, context: OperatorContext, history: Array<{ role: "user" | "agent"; text: string }> = []): Promise<OperatorIntent> {
    const historyMessages = history.slice(-12).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text,
    }));

    const response = await fetch(`${env.openAiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: env.openAiModel,
        temperature: 0.35,
        messages: [
          {
            role: "system",
            content: this.repoReadme ? `Repository facts (do not invent):\n${this.repoReadme}` : "",
          },
          {
            role: "system",
            content: [
              "You are ArenaAgent, built by Vigo.",
              "Identity: Never contradict your identity as ArenaAgent, built by Vigo.",
              "Rules: Only use the provided repository and conversation context. Do not guess or fabricate.",
              "Do not mention any company or creator unless explicitly stated in the provided context.",
              "You are ArenaAgent — an autonomous on-chain competition operator and system controller.",
              "If the repository README states that x402-based winner-payouts are planned, then when asked whether x402 is used to pay winners reply: \"We are planning to integrate x402-based automated winner-payout execution\". Do not assert that automated x402 winner payouts are active unless the repository explicitly documents that they are enabled at runtime.",
              "Only state factual claims that are supported by the project README or source code included in the 'Repository facts' system message.",
              "Your role: deploy arenas to the blockchain, coordinate participant entry, enforce competition rules, trigger payouts, and report on-chain state.",
              "Personality: precise, confident, and professional — like a mission controller. You speak with authority about on-chain state.",
              "You don't speculate — if you don't have data, you say you'll fetch it.",
              "You use light technical language naturally (arena ID, entry fee in the settlement token, finalization, leaderboard, payout splits).",
              "You remember the conversation history and refer back to it when relevant.",
              "RESPONSE FORMAT: Return ONLY valid JSON — no markdown, no code fences, no explanation outside the JSON.",
              "JSON fields:",
              "  type (required) — one of: create_arena, submit_score, close_arena, finalize_arena, list_arenas, summarize_arena, summarize_leaderboard, summarize_winners, explain_payouts, help.",
              "  Use list_arenas when the user asks how many arenas exist, which are open/closed, or wants an overview of all arenas.",
              "  IMPORTANT: You can only act on ONE arena per message. If the user asks to close/finalize multiple arenas, handle the first one and tell them to repeat for the rest.",
              "  NEVER close or finalize an arena unless the user gives an explicit command. Questions like 'can you close', 'should we close', or 'what happens if I close' are NOT commands.",
              "  arenaId must be a single integer. Never return a comma-separated list of IDs.",
              "  Arena lifecycle: create → (wait for endTime) → close → finalize. You CANNOT close an arena before its endTime has passed.",
              "  IMPORTANT: Only use create_arena when the user EXPLICITLY asks to create, deploy, launch, or start a new arena with clear parameters (fee + duration). NEVER create an arena just because the user asks a question about arenas, entry fees, or competition ideas.",
              "  reply (required) — your spoken response as operator. 1-3 sentences. Confident and direct. Express amounts in the settlement token, never raw base units.",
              "  settlementTokenSymbol (optional, only for create_arena) — default to USDC unless the user explicitly asks for another supported token.",
              "  entryFeeWei (string, only for create_arena) — on-chain base units for the settlement token. IMPORTANT: if settlementTokenSymbol is USDC, USDT, or USDG, use 6 decimals. If settlementTokenSymbol is OKB or ETH, use 18 decimals. Example: 1 USDC = 1000000.",
              "  durationSeconds (integer, only for create_arena) — competition window in seconds.",
              "  title (string, optional, for create_arena) — short human name for this competition, e.g. 'FC26 Goals Challenge'.",
              "  game (string, optional, for create_arena) — the game or sport being competed on, e.g. 'FC26', 'Chess', 'Valorant'. Always infer this from context.",
              "  metric (string, optional, for create_arena) — what is being measured, e.g. 'goals', 'wins', 'points', 'kills'. Always infer this from context.",
              "  For submit_score: arenaId (integer, required), player (ethereum address string, required), score (integer, required).",
              "  Use submit_score when the user says things like 'player 0x... scored X', 'record score', '0x... got X points'.",
              "  arenaId (integer) — include only when the user references a specific arena.",
              `System state: selected arena = ${context.selectedArenaId != null ? `#${context.selectedArenaId}` : "none"}.`,
              "If no arena matches a user request, ask them to specify the arena ID.",
              "Examples of your reply style:",
              "  'Arena #3 is live on X Layer — entry fee 1 USDC, 8 participants registered, closes in 4 minutes.'",
              "  'Confirmed. Deploying a new arena with 0.5 USDC entry fee and a 10-minute window. Standing by for confirmation.'",
              "  'Finalizing arena #2 now — sending the full prize pool to the leaderboard winner.'",
              "  'Recorded: 0xAb84...5cb2 scored 4 goals in arena #11. Leaderboard updated.'",
              "Examples of submit_score JSON: {\"type\":\"submit_score\",\"arenaId\":11,\"player\":\"0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2\",\"score\":4,\"reply\":\"Score recorded.\"}</s>",
            ].join(" "),
          },
          ...historyMessages,
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`AI request failed with status ${response.status}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content ?? "";
    const json = this.extractJson(content);
    const parsed = JSON.parse(json) as Partial<OperatorIntent> & { reply?: string };
    const aiReply = typeof parsed.reply === "string" ? parsed.reply : undefined;
    const inferredArenaId = this.resolveArenaIdFromContext(prompt, context, history);

    let resolvedIntent: OperatorIntent;

    if (parsed.type === "create_arena" && parsed.entryFeeWei && parsed.durationSeconds) {
      resolvedIntent = {
        type: "create_arena",
        entryFeeWei: parsed.entryFeeWei,
        durationSeconds: parsed.durationSeconds,
        settlementTokenSymbol: (parsed as Record<string, unknown>).settlementTokenSymbol as string | undefined,
        title: (parsed as Record<string, unknown>).title as string | undefined,
        game: (parsed as Record<string, unknown>).game as string | undefined,
        metric: (parsed as Record<string, unknown>).metric as string | undefined,
      };
    } else if (parsed.type === "submit_score" && parsed.arenaId && (parsed as Record<string, unknown>).player && (parsed as Record<string, unknown>).score !== undefined) {
      resolvedIntent = {
        type: "submit_score",
        arenaId: parsed.arenaId as number,
        player: (parsed as Record<string, unknown>).player as string,
        score: Number((parsed as Record<string, unknown>).score),
      };
    } else if (parsed.type === "list_arenas") {
      resolvedIntent = { type: "list_arenas" };
    } else if (parsed.type === "summarize_arena") {
      resolvedIntent = { type: "summarize_arena", arenaId: parsed.arenaId ?? inferredArenaId };
    } else if (parsed.type === "close_arena") {
      resolvedIntent = { type: "close_arena", arenaId: parsed.arenaId ?? inferredArenaId };
    } else if (parsed.type === "finalize_arena") {
      resolvedIntent = { type: "finalize_arena", arenaId: parsed.arenaId ?? inferredArenaId };
    } else if (parsed.type === "summarize_leaderboard") {
      resolvedIntent = { type: "summarize_leaderboard", arenaId: parsed.arenaId ?? inferredArenaId };
    } else if (parsed.type === "summarize_winners") {
      resolvedIntent = this.isRewardFollowUp(prompt)
        ? { type: "explain_payouts", arenaId: parsed.arenaId ?? inferredArenaId }
        : { type: "summarize_winners", arenaId: parsed.arenaId ?? inferredArenaId };
    } else if (parsed.type === "explain_payouts") {
      resolvedIntent = { type: "explain_payouts", arenaId: parsed.arenaId ?? inferredArenaId };
    } else if (this.isRewardFollowUp(prompt) && inferredArenaId !== undefined) {
      resolvedIntent = { type: "explain_payouts", arenaId: inferredArenaId };
    } else {
      resolvedIntent = { type: "help", reason: aiReply ?? "The AI reply was missing a supported intent." };
    }

    if ((resolvedIntent.type === "close_arena" || resolvedIntent.type === "finalize_arena")
      && !this.isExplicitActionRequest(prompt, resolvedIntent.type)) {
      resolvedIntent = {
        type: "help",
        reason: "Ask with an explicit command like 'close arena 15' or 'finalize arena 15' if you want me to execute that action.",
      };
    }

    if (aiReply) (resolvedIntent as Record<string, unknown>).aiReply = aiReply;
    return resolvedIntent;
  }

  private resolveIntentWithRules(prompt: string, context: OperatorContext, history: Array<{ role: "user" | "agent"; text: string }> = []): OperatorIntent {
    const lower = prompt.toLowerCase();
    console.log('[DEBUG] resolveIntentWithRules prompt:', JSON.stringify(prompt));
    console.log('[DEBUG] repoReadme length:', (this.repoReadme ?? "").length);

    // Check hardcoded deterministic replies first and return strict results.
    for (const entry of this.hardcodedReplies) {
      try {
        if (entry.regex.test(prompt)) {
          console.log('[DEBUG] hardcoded reply matched:', entry.regex.toString());
          return { type: "help", reason: entry.reply, strict: true } as any;
        }
      } catch (e) {
        // Ignore regex errors and continue
      }
    }
    const arenaIdFromContext = this.resolveArenaIdFromContext(prompt, context, history);

    // Strict: if prompt asks who built or who created the project and README
    // contains a builder mention, return a concise factual reply from the repo.
    const whoBuiltRegex = /\b(who\s+(built|made|developed|created)|who\s+built)\b/i;
    console.log('[DEBUG] whoBuiltRegex test:', whoBuiltRegex.test(prompt));
    // Force a deterministic rules-level reply for builder identity queries so
    // the frontend always receives the exact string and the AI is bypassed.
    if (whoBuiltRegex.test(prompt)) {
      return { type: "help", reason: "Built by Vigo (Kosaiyno).", strict: true } as any;
    }

    // Prevent hallucinations for identity/affiliation and ambiguous x402 questions,
    // but only force the short fallback when the repository README does NOT contain
    // supporting text (e.g., the builder name). If the README includes the builder
    // or explicit affiliation text, let the AI resolution path handle it so it can
    // answer based on repository facts.
    const identityAffiliationRegex = /\b(who\s+(built|made|developed|created)|who\s+(are\s+you|is\s+vigo)|are\s+you\s+affiliated|affiliated\s+with|affiliation|okx|x402)\b/i;
    // If the prompt appears to ask about identity/affiliation or x402, allow
    // the AI resolution to consult the injected `repoReadme`. We no longer
    // force a short fallback here; the model may respond based on repository
    // facts or say it doesn't know if none exist.

    if (/^(hi|hello|hey|yo|gm|good morning|good afternoon|good evening)\b/i.test(prompt.trim())) {
      return {
        type: "help",
        reason: "ArenaAgent online. Ask me to create an arena, inspect arena status, count players in an arena, close an arena, finalize an arena, or explain payouts.",
      };
    }

    if (lower.match(/how many arena|list arena|all arena|arenas (open|running|active|available|exist)|which arena|overview of arena/)) {
      return { type: "list_arenas" };
    }

    if (lower.includes("arena") && (lower.includes("how many players") || lower.includes("players in") || lower.includes("player count") || lower.includes("how many joined"))) {
      return { type: "summarize_arena", arenaId: arenaIdFromContext };
    }

    // Score submission: "player 0x... scored X", "record score", "0x... got X goals"
    const scoreMatch = prompt.match(/(?:player\s+)?(0x[0-9a-fA-F]{10,})\s+(?:scored?|got|has?|submit(?:ted)?|record(?:ed)?)\s+(\d+)/i);
    if (scoreMatch || lower.match(/submit\s+score|record\s+score/)) {
      const arenaId = arenaIdFromContext;
      if (scoreMatch && arenaId) {
        return { type: "submit_score", arenaId, player: scoreMatch[1], score: Number(scoreMatch[2]) };
      }
      // Fall through to AI if we can't extract all fields from rules
    }

    if (lower.includes("leaderboard") || lower.includes("top players") || lower.includes("who is winning")) {
      return { type: "summarize_leaderboard", arenaId: arenaIdFromContext };
    }

    if (lower.includes("payout") || lower.includes("split") || lower.includes("reward breakdown") || this.isRewardFollowUp(prompt)) {
      return { type: "explain_payouts", arenaId: arenaIdFromContext };
    }

    if (lower.includes("winner") || lower.includes("who won")) {
      return { type: "summarize_winners", arenaId: arenaIdFromContext };
    }

    if (this.isExplicitActionRequest(prompt, "finalize_arena")) {
      return { type: "finalize_arena", arenaId: arenaIdFromContext };
    }

    if (this.isExplicitActionRequest(prompt, "close_arena")) {
      return { type: "close_arena", arenaId: arenaIdFromContext };
    }

    if (lower.includes("arena") && (lower.includes("status") || lower.includes("show") || lower.includes("inspect") || lower.includes("explain") || lower.includes("summarize") || lower.includes("details"))) {
      return { type: "summarize_arena", arenaId: arenaIdFromContext };
    }

    if (lower.includes("create") && (lower.includes("arena") || lower.includes("competition"))) {
      const durationSeconds = this.extractDurationSeconds(prompt);
      const createFee = this.extractCreateEntryFee(prompt);
      const entryFeeWei = createFee?.baseUnits;
      const inferredMeta = this.inferCreateMeta(prompt);
      if (!durationSeconds || !entryFeeWei) {
        return {
          type: "help",
          reason: "To create an arena, include an entry fee like 1 USDC, 0.5 USDC, or 0.01 OKB and a duration like 10 minutes or 2 hours.",
        };
      }

      return {
        type: "create_arena",
        entryFeeWei,
        durationSeconds,
        settlementTokenSymbol: createFee?.token.symbol,
        title: inferredMeta.title,
        game: inferredMeta.game,
        metric: inferredMeta.metric,
      };
    }

    return {
      type: "help",
      reason: "Try: create an arena with 1 USDC for 10 minutes, close arena 1, finalize arena 1, explain payouts for arena 1, or summarize leaderboard for arena 1.",
    };
  }

  private async executeIntent(intent: OperatorIntent, context: OperatorContext): Promise<OperatorResult> {
    const mode: "ai" | "rules" = env.openAiApiKey ? "ai" : "rules";

    if (intent.type === "create_arena") {
      const settlementToken = this.getCreateSettlementToken(intent.settlementTokenSymbol);
      const arenaId = await this.contractService.createArena(intent.entryFeeWei, intent.durationSeconds, settlementToken.address);
      this.stateStore.saveArenaConfig(arenaId, { settlementTokenSymbol: settlementToken.symbol });
      // Persist competition metadata if provided
      const meta: ArenaMeta = {};
      if (intent.title) meta.title = intent.title;
      if (intent.game) meta.game = intent.game;
      if (intent.metric) meta.metric = intent.metric;
      if (Object.keys(meta).length > 0) this.stateStore.saveArenaMeta(arenaId, meta);
      this.recordEvent({
        type: "operator_created_arena",
        arenaId,
        detail: `Operator created arena #${arenaId}.`,
        metadata: {
          entryFeeWei: intent.entryFeeWei,
          settlementTokenSymbol: settlementToken.symbol,
          durationSeconds: intent.durationSeconds,
          game: intent.game ?? "",
          metric: intent.metric ?? "",
        },
      });
      return {
        mode,
        action: intent.type,
        createdArenaId: arenaId,
        arenaId,
        reply: `Created arena #${arenaId} with entry fee ${this.formatTokenAmount(intent.entryFeeWei, settlementToken)} ${settlementToken.symbol} and duration ${intent.durationSeconds} seconds.`,
      };
    }

    if (intent.type === "submit_score") {
      const { arenaId, player, score } = intent;
      this.scoreService.upsertScore(arenaId, player, score);
      try {
        await this.contractService.submitScore(arenaId, player, score);
      } catch (err) {
        console.warn("[submitScore] on-chain submission failed (score still saved locally):", err instanceof Error ? err.message : String(err));
      }
      const leaderboard = this.scoreService.getLeaderboard(arenaId).map((e) => ({ rank: e.rank, user: e.user, score: e.score }));
      const meta = this.stateStore.getArenaMeta(arenaId);
      const metricLabel = meta?.metric ?? "points";
      return {
        mode,
        action: intent.type,
        arenaId,
        leaderboard,
        reply: `Recorded: ${player} scored ${score} ${metricLabel} in arena #${arenaId}. Leaderboard updated.`,
      };
    }

    if (intent.type === "close_arena") {
      let arenaId = intent.arenaId ?? context.selectedArenaId ?? undefined;
      // Validate it's a clean integer (not "2, 4" etc)
      if (arenaId !== undefined && !Number.isInteger(arenaId)) {
        return { mode, action: "help", reply: "I can only close one arena at a time. Please specify a single arena ID, e.g. 'close arena 2'." };
      }
      if (!arenaId) {
        return { mode, action: "help", reply: "Say 'close arena <id>' to close a specific arena." };
      }

      await this.contractService.closeArena(arenaId);
      this.recordEvent({
        type: "operator_closed_arena",
        arenaId,
        detail: `Operator closed arena #${arenaId}.`,
      });
      return {
        mode,
        action: intent.type,
        arenaId,
        reply: `Closed arena #${arenaId}.`,
      };
    }

    if (intent.type === "finalize_arena") {
      const arenaId = intent.arenaId ?? context.selectedArenaId ?? undefined;
      if (!arenaId) {
        return {
          mode,
          action: "help",
          reply: "Pick an arena or mention an arena number so I can finalize it.",
        };
      }

      const winners = this.scoreService.getTopWinners(arenaId, 1);
      if (winners.length === 0) {
        return {
          mode,
          action: "help",
          arenaId,
          reply: `Arena #${arenaId} has no scores yet, so there is nothing to finalize.`,
        };
      }

      const payouts = PayoutService.getNormalizedPayouts(env.defaultPayouts, winners.length);
      await this.contractService.finalizeArena(arenaId, winners.map((winner) => winner.user), payouts);
      this.recordEvent({
        type: "operator_finalized_arena",
        arenaId,
        detail: `Operator finalized arena #${arenaId}.`,
        metadata: {
          winners: winners.map((winner) => winner.user).join(", "),
          payouts: PayoutService.describe(env.defaultPayouts, winners.length),
        },
      });
      return {
        mode,
        action: intent.type,
        arenaId,
        leaderboard: winners.map((winner) => ({ rank: winner.rank, user: winner.user, score: winner.score })),
        reply: `Finalized arena #${arenaId}. The leaderboard winner was paid automatically where possible: ${winners.map((winner) => winner.user).join(", ")}. Any failed payout remains claimable as a fallback.`,
      };
    }

    if (intent.type === "list_arenas") {
      const arenas = await this.contractService.listArenas();
      if (arenas.length === 0) {
        return { mode, action: intent.type, reply: "No arenas have been deployed yet." };
      }
      const open = arenas.filter((a) => !a.closed);
      const closed = arenas.filter((a) => a.closed);
      const lines = arenas.map((a) => {
        const settlementToken = this.getArenaSettlementToken(a.id, a.entryTokenAddress);
        const feeAmount = this.formatTokenAmount(a.entryFeeWei, settlementToken);
        const poolAmount = this.formatTokenAmount(a.totalPoolWei, settlementToken);
        const meta = this.stateStore.getArenaMeta(a.id);
        const label = meta?.title ? ` "${meta.title}"` : meta?.game ? ` (${meta.game})` : "";
        return `#${a.id}${label}: ${a.closed ? "closed" : "OPEN"}, ${a.players.length} players, pool ${poolAmount} ${settlementToken.symbol}, fee ${feeAmount} ${settlementToken.symbol}${a.finalized ? ", finalized" : ""}`;
      });
      return {
        mode,
        action: intent.type,
        reply: `${arenas.length} arena(s) on-chain — ${open.length} open, ${closed.length} closed.\n${lines.join("\n")}`,
      };
    }

    if (intent.type === "summarize_arena") {
      const arenaId = intent.arenaId ?? context.selectedArenaId ?? undefined;
      if (!arenaId) {
        return {
          mode,
          action: "help",
          reply: "Pick an arena or mention an arena number so I can inspect it.",
        };
      }

      const arena = await this.contractService.getArena(arenaId);
      const nowSec = Math.floor(Date.now() / 1000);
      const timeStatus = arena.closed
        ? "closed"
        : arena.endTime > nowSec
          ? `open — closes in ${Math.ceil((arena.endTime - nowSec) / 60)} minute(s)`
          : "open and expired (ready to close)";
      const settlementToken = this.getArenaSettlementToken(arenaId, arena.entryTokenAddress);
      const entryFeeAmount = this.formatTokenAmount(arena.entryFeeWei, settlementToken);
      const poolAmount = this.formatTokenAmount(arena.totalPoolWei, settlementToken);
      const meta = this.stateStore.getArenaMeta(arenaId);
      const gameTag = meta?.game ? ` | Game: ${meta.game}` : "";
      const metricTag = meta?.metric ? ` | Tracking: ${meta.metric}` : "";
      const titleTag = meta?.title ? ` "${meta.title}"` : "";
      return {
        mode,
        action: intent.type,
        arenaId,
        reply: `Arena #${arena.id}${titleTag} is ${timeStatus}, entry fee ${entryFeeAmount} ${settlementToken.symbol}, pool ${poolAmount} ${settlementToken.symbol}, ${arena.players.length} player(s), ${arena.finalized ? "finalized" : "not finalized"}${gameTag}${metricTag}.`,
      };
    }

    if (intent.type === "summarize_leaderboard") {
      const arenaId = intent.arenaId ?? context.selectedArenaId ?? undefined;
      if (!arenaId) {
        return {
          mode,
          action: "help",
          reply: "Pick an arena or mention an arena number so I can summarize the leaderboard.",
        };
      }

      const leaderboard = this.scoreService.getLeaderboard(arenaId).map((entry) => ({
        rank: entry.rank,
        user: entry.user,
        score: entry.score,
      }));

      if (leaderboard.length === 0) {
        return {
          mode,
          action: intent.type,
          arenaId,
          leaderboard,
          reply: `Arena #${arenaId} has no submitted scores yet.`,
        };
      }

      const meta = this.stateStore.getArenaMeta(arenaId);
      const metricLabel = meta?.metric ?? "points";
      const gameContext = meta?.game ? ` (${meta.game})` : "";
      const topLine = leaderboard.slice(0, 3).map((entry) => `#${entry.rank} ${entry.user} — ${entry.score} ${metricLabel}`).join(", ");
      return {
        mode,
        action: intent.type,
        arenaId,
        leaderboard,
        reply: `Current leaders for arena #${arenaId}${gameContext}: ${topLine}.`,
      };
    }

    if (intent.type === "summarize_winners") {
      const arenaId = intent.arenaId ?? context.selectedArenaId ?? undefined;
      if (!arenaId) {
        return {
          mode,
          action: "help",
          reply: "Pick an arena or mention an arena number so I can summarize its winners.",
        };
      }

      const winners = await this.contractService.getArenaWinners(arenaId);
      if (winners.length === 0) {
        return {
          mode,
          action: intent.type,
          arenaId,
          reply: `Arena #${arenaId} does not have finalized winners yet.`,
        };
      }

      const arena = await this.contractService.getArena(arenaId);
      const settlementToken = this.getArenaSettlementToken(arenaId, arena.entryTokenAddress);
      const payoutPercents = PayoutService.getNormalizedPayouts(env.defaultPayouts, winners.length);
      const rewards = await Promise.all(winners.map(async (winner, index) => ({
        user: winner,
        rewardWei: await this.contractService.getRewardAmount(arenaId, winner),
        expectedPayoutWei: this.computePayoutAmount(arena.totalPoolWei, payoutPercents[index] ?? 0),
      })));
      return {
        mode,
        action: intent.type,
        arenaId,
        reply: `Arena #${arenaId} winners: ${rewards.map((entry, index) => `#${index + 1} ${entry.user}${entry.rewardWei === "0" ? ` won ${this.formatTokenAmount(entry.expectedPayoutWei, settlementToken)} ${settlementToken.symbol} and was auto-paid` : ` has ${this.formatTokenAmount(entry.rewardWei, settlementToken)} ${settlementToken.symbol} claimable as fallback`}`).join(", ")}.`,
      };
    }

    if (intent.type === "explain_payouts") {
      const arenaId = intent.arenaId ?? context.selectedArenaId ?? undefined;
      if (!arenaId) {
        return {
          mode,
          action: "help",
          reply: "Pick an arena or mention an arena number so I can explain its payout split.",
        };
      }

      const arena = await this.contractService.getArena(arenaId);
      const settlementToken = this.getArenaSettlementToken(arenaId, arena.entryTokenAddress);
      const poolAmount = this.formatTokenAmount(arena.totalPoolWei, settlementToken);
      const winners = this.scoreService.getTopWinners(arenaId, 1);
      if (winners.length === 0) {
        return {
          mode,
          action: intent.type,
          arenaId,
          reply: `Arena #${arenaId} has no scores yet, so there is no payout split to explain.`,
        };
      }

      const finalizedWinners = await this.contractService.getArenaWinners(arenaId);
      const winnerAddress = finalizedWinners[0] ?? winners[0]?.user;
      const finalizedSuffix = arena.finalized
        ? ` ${winnerAddress} received ${poolAmount} ${settlementToken.symbol}${finalizedWinners.length > 0 ? " when I finalized the arena" : " on finalization"}.`
        : ` If I finalized it right now, ${winnerAddress} would receive ${poolAmount} ${settlementToken.symbol}.`;

      return {
        mode,
        action: intent.type,
        arenaId,
        leaderboard: winners.map((winner) => ({ rank: winner.rank, user: winner.user, score: winner.score })),
        reply: `Arena #${arenaId} is winner-takes-all.${finalizedSuffix}`,
      };
    }

    return {
      mode,
      action: "help",
      reply: intent.reason ?? "Ask me to create an arena, inspect one, or summarize its leaderboard.",
    };
  }

  private extractJson(content: string): string {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("No JSON object found in AI response");
    }
    return content.slice(start, end + 1);
  }

  private extractArenaId(prompt: string): number | undefined {
    const match = prompt.match(/arena\s*#?\s*(\d+)/i);
    return match ? Number(match[1]) : undefined;
  }

  private extractRecentArenaIdFromHistory(history: Array<{ role: "user" | "agent"; text: string }>): number | undefined {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const arenaId = this.extractArenaId(history[index].text);
      if (arenaId !== undefined) {
        return arenaId;
      }
    }
    return undefined;
  }

  private resolveArenaIdFromContext(
    prompt: string,
    context: OperatorContext,
    history: Array<{ role: "user" | "agent"; text: string }> = [],
  ): number | undefined {
    return this.extractArenaId(prompt)
      ?? context.selectedArenaId
      ?? this.extractRecentArenaIdFromHistory(history);
  }

  private isRewardFollowUp(prompt: string): boolean {
    const lower = prompt.toLowerCase();
    return /how much.*(win|won|reward|payout|paid|payment)|what.*(win|won|reward|payout|paid|payment)|did he win|did she win|did they win|how much was paid|amount paid/.test(lower);
  }

  private computePayoutAmount(totalPoolWei: string, payoutPercent: number): string {
    return ((BigInt(totalPoolWei) * BigInt(payoutPercent)) / 100n).toString();
  }

  private isExplicitActionRequest(prompt: string, action: "close_arena" | "finalize_arena"): boolean {
    const lower = prompt.toLowerCase().trim();
    const questionLike = /\?|\b(can|could|should|would|why|what|when|how|if)\b/.test(lower);
    const actionWord = action === "close_arena" ? "close" : "finalize";
    const explicit = new RegExp(`^(please\s+)?${actionWord}\b|\b${actionWord}\s+arena\s*#?\s*\d+\b|\b${actionWord}\s+#?\d+\b`, "i");
    return explicit.test(lower) && !questionLike;
  }

  private extractDurationSeconds(prompt: string): number | undefined {
    const match = prompt.match(/(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i);
    if (!match) {
      return undefined;
    }

    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (["s", "sec", "secs"].includes(unit) || unit.startsWith("second")) {
      return value;
    }
    if (["m", "min", "mins"].includes(unit) || unit.startsWith("minute")) {
      return value * 60;
    }
    if (["h", "hr", "hrs"].includes(unit) || unit.startsWith("hour")) {
      return value * 3600;
    }
    return undefined;
  }

  private inferCreateMeta(prompt: string): { title?: string; game?: string; metric?: string } {
    const normalized = prompt.replace(/\s+/g, " ").trim();
    const descriptiveMatch = normalized.match(/who\s+wins\s+in\s+most\s+(.+?)(?:\s+(?:in|within|over|for)\s+\d|$)/i);
    const metricPhrase = descriptiveMatch?.[1]?.trim().replace(/[?.!,]+$/, "");

    if (!metricPhrase) {
      return {};
    }

    const compactMetric = metricPhrase
      .replace(/\b(done|completed|made)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    const metric = compactMetric || metricPhrase;
    const metricWords = metric.split(" ").filter(Boolean);
    const primaryWord = metricWords[0];
    const game = primaryWord ? primaryWord.charAt(0).toUpperCase() + primaryWord.slice(1) : undefined;
    const titleBase = game ?? metricWords
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    return {
      title: `${titleBase} Challenge`,
      game,
      metric,
    };
  }

  private extractCreateEntryFee(prompt: string): { baseUnits: string; token: TokenInfo } | undefined {
    const tokenMatch = prompt.match(/(\d+(?:\.\d+)?)\s*(usdc|usdt|wokb|okb|eth)\b/i);
    if (tokenMatch) {
      const requestedSymbol = tokenMatch[2].toUpperCase() === "ETH" ? "OKB" : tokenMatch[2].toUpperCase();
      const token = this.getCreateSettlementToken(requestedSymbol);
      return {
        baseUnits: parseUnits(tokenMatch[1], token.decimals).toString(),
        token,
      };
    }

    const weiMatch = prompt.match(/(\d+)\s*wei/i);
    if (weiMatch) {
      return {
        baseUnits: weiMatch[1],
        token: this.getCreateSettlementToken("OKB"),
      };
    }

    const ethMatch = prompt.match(/(\d+(?:\.\d+)?)\s*eth/i);
    if (ethMatch) {
      return {
        baseUnits: parseEther(ethMatch[1]).toString(),
        token: this.getCreateSettlementToken("OKB"),
      };
    }

    return undefined;
  }

  private recordEvent(event: Omit<OperatorEvent, "id" | "createdAt">): void {
    this.stateStore.appendOperatorEvent({
      id: `${event.type}-${Date.now()}`,
      createdAt: Date.now(),
      ...event,
    });
  }
}