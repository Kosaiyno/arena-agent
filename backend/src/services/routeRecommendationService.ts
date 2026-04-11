import { Interface, formatUnits } from "ethers";
import { env } from "../config/env.js";
import { ApprovalTransaction, ArenaState, RoutePlan, SwapAndJoinPlan, SwapTransaction, TokenInfo, WalletTokenBalance } from "../types/arena.js";
import { OnchainOsService } from "./onchainOsService.js";
import { TokenRegistry } from "./tokenRegistry.js";
import { UniswapTradeService } from "./uniswapTradeService.js";

export class RouteRecommendationService {
  constructor(
    private readonly tokenRegistry: TokenRegistry,
    private readonly uniswapTradeService: UniswapTradeService,
    private readonly onchainOsService: OnchainOsService,
  ) {}

  async getRecommendation(arena: ArenaState, walletAddress: string, balances: WalletTokenBalance[]): Promise<{
    recommended: RoutePlan | null;
    candidates: RoutePlan[];
  }> {
    const settlementToken = arena.settlementToken ?? this.tokenRegistry.getDefaultSettlementToken();
    const settlementDecimals = settlementToken.decimals;
    const requiredOutput = Number(formatUnits(arena.entryFeeWei, settlementDecimals));
    const candidates = (await Promise.all(
      balances
        .filter((balance) => balance.estimatedValueInSettlement > 0)
        .map((balance) => this.toRoutePlan(balance, settlementToken, requiredOutput, walletAddress)),
    ))
      .filter((route): route is RoutePlan => route !== null)
      .sort((left, right) => {
        if (left.routeType !== right.routeType) {
          return left.routeType === "direct_join" ? -1 : 1;
        }
        const leftStablePreference = this.getStableSwapPreference(left, settlementToken);
        const rightStablePreference = this.getStableSwapPreference(right, settlementToken);
        if (leftStablePreference !== rightStablePreference) {
          return leftStablePreference - rightStablePreference;
        }
        if (left.provider !== right.provider) {
          return left.provider === "uniswap-trading-api" ? -1 : 1;
        }
        return Number(left.expectedInputAmount) - Number(right.expectedInputAmount);
      });

    return {
      recommended: candidates[0] ?? null,
      candidates,
    };
  }

  private getStableSwapPreference(route: RoutePlan, settlementToken: NonNullable<ArenaState["settlementToken"]>): number {
    if (route.routeType !== "swap_then_join") {
      return 0;
    }

    const settlementIsStable = ["USDC", "USDT", "USDG"].includes(settlementToken.symbol.toUpperCase());
    if (!settlementIsStable) {
      return 0;
    }

    const fromSymbol = route.fromToken.symbol.toUpperCase();
    if (["USDC", "USDT", "USDG"].includes(fromSymbol)) {
      return 0;
    }

    return 1;
  }

  private isStableSymbol(symbol: string): boolean {
    return ["USDC", "USDT", "USDG"].includes(symbol.toUpperCase());
  }

  private isStableSwapSourceSupported(symbol: string): boolean {
    return ["USDC", "USDG"].includes(symbol.toUpperCase());
  }

  private canSwapBetweenTokens(fromToken: TokenInfo, toToken: TokenInfo): boolean {
    const fromSymbol = fromToken.symbol.toUpperCase();
    const toSymbol = toToken.symbol.toUpperCase();

    if ((fromSymbol === "WOKB" || fromSymbol === "OKB") && toSymbol === "USDC") {
      return true;
    }

    return this.isStableSymbol(fromSymbol)
      && this.isStableSymbol(toSymbol)
      && this.isStableSwapSourceSupported(fromSymbol);
  }

  private async toRoutePlan(
    balance: WalletTokenBalance,
    settlementToken: NonNullable<ArenaState["settlementToken"]>,
    requiredOutput: number,
    walletAddress: string,
  ): Promise<RoutePlan | null> {
    if (requiredOutput <= 0) {
      return null;
    }

    const directJoinAmount = requiredOutput.toFixed(Math.min(settlementToken.decimals, 6));

    if (balance.token.symbol === settlementToken.symbol) {
      if (!balance.canCoverEntry) {
        return null;
      }

      return {
        provider: "wallet-direct",
        fromToken: balance.token,
        toToken: settlementToken,
        expectedInputAmount: directJoinAmount,
        expectedOutputAmount: directJoinAmount,
        routeType: "direct_join",
        explanation: `Wallet already holds enough ${settlementToken.symbol} to join directly.`,
        steps: [
          `Use ${requiredOutput.toFixed(6)} ${settlementToken.symbol} from the connected wallet.`,
          "Send the join transaction from the wallet.",
        ],
      };
    }

    if (!this.canSwapBetweenTokens(balance.token, settlementToken)) {
      return null;
    }

    const requiredOutputBaseUnits = this.toBaseUnitsString(directJoinAmount, settlementToken.decimals);
    const liveQuote = await this.uniswapTradeService.getQuoteForExactOutput({
      walletAddress,
      fromToken: balance.token,
      toToken: settlementToken,
      amountOutBaseUnits: requiredOutputBaseUnits,
    });

    if (liveQuote) {
      if (BigInt(liveQuote.amountInBaseUnits) > BigInt(balance.rawBalance)) {
        return this.uniswapTradeService.createInsufficientBalancePlan(
          balance,
          settlementToken,
          liveQuote.expectedInputAmount,
          liveQuote.expectedOutputAmount,
        );
      }

      return {
        provider: liveQuote.provider,
        fromToken: balance.token,
        toToken: settlementToken,
        expectedInputAmount: liveQuote.expectedInputAmount,
        expectedOutputAmount: liveQuote.expectedOutputAmount,
        routeType: "swap_then_join",
        explanation: liveQuote.explanation,
        steps: liveQuote.steps,
        gasFeeUsd: liveQuote.gasFeeUsd,
        routeSummary: liveQuote.routeSummary,
        quoteId: liveQuote.quoteId,
      };
    }

    if (!balance.canCoverEntry) {
      return null;
    }

    const expectedInputAmount = this.getExpectedInputAmount(balance, requiredOutput);
    const amountInBaseUnits = this.toBaseUnitsString(expectedInputAmount, balance.token.decimals);
    const okxRoute = await this.tryOkxDexRoute(balance, settlementToken, expectedInputAmount, amountInBaseUnits, requiredOutput);
    if (okxRoute) return okxRoute;

    return {
      ...this.uniswapTradeService.createFallbackPlan(balance, settlementToken, expectedInputAmount, requiredOutput.toFixed(6)),
    };
  }

  private async tryOkxDexRoute(
    balance: WalletTokenBalance,
    settlementToken: NonNullable<ArenaState["settlementToken"]>,
    expectedInputAmount: string,
    amountInBaseUnits: string,
    requiredOutput: number,
  ): Promise<RoutePlan | null> {
    const fromAddress = this.toOkxTokenAddress(balance.token);
    const toAddress = this.toOkxTokenAddress(settlementToken);
    if (!fromAddress || !toAddress) return null;

    const okxQuote = await this.onchainOsService.getDexQuote({
      chainId: env.appChainId,
      fromTokenAddress: fromAddress,
      toTokenAddress: toAddress,
      amount: amountInBaseUnits,
    });

    if (!okxQuote?.data?.[0]?.toTokenAmount) return null;
    const quoteData = okxQuote.data[0];

    return {
      provider: "okx-dex-aggregator",
      fromToken: balance.token,
      toToken: settlementToken,
      expectedInputAmount,
      expectedOutputAmount: formatUnits(quoteData.toTokenAmount, settlementToken.decimals),
      routeType: "swap_then_join",
      explanation: `OKX DEX aggregator found the best route across 400+ protocols for this swap.`,
      steps: [
        `Approve ${balance.token.symbol} spend for OKX DEX router if required.`,
        "Sign and broadcast the OKX DEX swap transaction.",
        "After the swap settles, send the joinArena transaction from the wallet.",
      ],
      gasFeeUsd: quoteData.estimateGasFee,
    };
  }

  private toOkxTokenAddress(token: TokenInfo): string | null {
    if (token.kind === "native") return "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    return token.address;
  }

  private getExpectedInputAmount(balance: WalletTokenBalance, requiredOutput: number): string {
    const inputNeeded = requiredOutput / Math.max(balance.estimatedValueInSettlement / Number(balance.formattedBalance || "1"), 0.000001);
    return inputNeeded.toFixed(6);
  }

  private toBaseUnitsString(amount: string, decimals: number): string {
    const [whole, fraction = ""] = amount.split(".");
    const paddedFraction = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
    return `${whole}${paddedFraction}`.replace(/^0+/, "") || "0";
  }

  async buildSwapAndJoinPlan(
    arena: ArenaState,
    walletAddress: string,
    fromTokenInput: TokenInfo | string,
    fromAmountBaseUnits: string,
  ): Promise<SwapAndJoinPlan> {
    const settlementToken = arena.settlementToken ?? this.tokenRegistry.getDefaultSettlementToken();
    const fromToken = typeof fromTokenInput === "string"
      ? this.tokenRegistry.getBySymbol(fromTokenInput) ?? settlementToken
      : fromTokenInput;

    // Encode joinArena(arenaId) calldata so the frontend can send it directly
    const joinInterface = new Interface(["function joinArena(uint256 arenaId) payable"]);
    const joinData = joinInterface.encodeFunctionData("joinArena", [arena.id]);
    const joinTx: SwapTransaction = {
      provider: "arena-contract",
      to: env.contractAddress,
      data: joinData,
      value: arena.entryFeeWei,
    };

    // Direct join — user is already in the settlement token
    if (fromToken.symbol === settlementToken.symbol) {
      return { provider: "wallet-direct", isDirect: true, requiresApproval: false, approvalTxs: [], swapTx: null, joinTx };
    }

    if (!this.canSwapBetweenTokens(fromToken, settlementToken)) {
      return { provider: "no-provider", isDirect: true, requiresApproval: false, approvalTxs: [], swapTx: null, joinTx };
    }

    // Try Uniswap first (preferred), OKX will be attempted as a fallback below

    const swapTx = await this.uniswapTradeService.buildSwapTransaction({ walletAddress, fromToken, toToken: settlementToken, amountInBaseUnits: fromAmountBaseUnits });

    if (swapTx) {
      const approvalTxs = (await Promise.all([
        this.uniswapTradeService.checkApproval({ walletAddress, token: fromToken, amountInBaseUnits: fromAmountBaseUnits }),
        this.uniswapTradeService.buildPermit2Approval({ walletAddress, token: fromToken, spender: swapTx.to, amountInBaseUnits: fromAmountBaseUnits }),
      ])).filter((tx): tx is ApprovalTransaction => tx !== null);

      return {
        provider: "uniswap-trading-api",
        isDirect: false,
        requiresApproval: approvalTxs.length > 0,
        approvalTxs,
        swapTx,
        joinTx,
      };
    }

    // Try OKX DEX aggregator
    const fromAddress = this.toOkxTokenAddress(fromToken);
    const toAddress = this.toOkxTokenAddress(settlementToken);
    if (fromAddress && toAddress) {
      const okxSwapTx = await this.onchainOsService.buildSwapTransaction({
        chainId: env.appChainId,
        fromTokenAddress: fromAddress,
        toTokenAddress: toAddress,
        amount: fromAmountBaseUnits,
        userWalletAddress: walletAddress,
      });

      if (okxSwapTx) {
        const okxApproval = fromToken.kind === "erc20" ? this.buildOkxApprovalTx(fromToken, okxSwapTx.to) : null;
        return {
          provider: "okx-dex-aggregator",
          isDirect: false,
          requiresApproval: Boolean(okxApproval),
          approvalTxs: okxApproval ? [okxApproval] : [],
          swapTx: okxSwapTx,
          joinTx,
        };
      }
    }

    // No live provider — return direct plan so caller can fall back gracefully
    return { provider: "no-provider", isDirect: true, requiresApproval: false, approvalTxs: [], swapTx: null, joinTx };
  }

  private buildOkxApprovalTx(token: TokenInfo, spender: string): ApprovalTransaction | null {
    if (!token.address) return null;
    const iface = new Interface(["function approve(address spender, uint256 amount)"]);
    const maxApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    const data = iface.encodeFunctionData("approve", [spender, maxApproval]);
    return { to: token.address, data, value: "0", spender };
  }
}