import { Contract, Interface, JsonRpcProvider, formatUnits } from "ethers";
import { env } from "../config/env.js";
import { ApprovalTransaction, RoutePlan, SwapTransaction, TokenInfo, WalletTokenBalance } from "../types/arena.js";

type UniswapQuoteResponse = {
  requestId?: string;
  routing?: string;
  quote?: {
    output?: {
      amount?: string;
    };
    gasFeeUSD?: string;
    routeString?: string;
  };
};

type UniswapQuotePlan = Pick<RoutePlan, "provider" | "expectedOutputAmount" | "explanation" | "steps" | "gasFeeUsd" | "routeSummary" | "quoteId"> & {
  expectedInputAmount: string;
  amountInBaseUnits: string;
};

const UNISWAP_XLAYER_CHAIN_ID = 196;
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const PERMIT2_MAX_APPROVAL = BigInt("0xffffffffffffffffffffffffffffffffffffffff");
const PERMIT2_APPROVAL_DURATION_SECONDS = 60 * 60 * 24 * 365;
const permit2Abi = [
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
] as const;

export class UniswapTradeService {
  isEnabled(): boolean {
    return Boolean(env.uniswapApiKey);
  }

  async getQuote(params: {
    walletAddress: string;
    fromToken: TokenInfo;
    toToken: TokenInfo;
    amountInBaseUnits: string;
  }): Promise<UniswapQuotePlan | null> {
    if (!this.isEnabled()) {
      return null;
    }

    const tokenIn = this.resolveTokenAddress(params.fromToken);
    const tokenOut = this.resolveTokenAddress(params.toToken);
    if (!tokenIn || !tokenOut) {
      return null;
    }

    const response = await fetch(`${env.uniswapApiUrl}/quote`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": env.uniswapApiKey,
        "x-universal-router-version": "2.0",
      },
      body: JSON.stringify({
        generatePermitAsTransaction: false,
        swapper: params.walletAddress,
        tokenIn,
        tokenOut,
        tokenInChainId: UNISWAP_XLAYER_CHAIN_ID,
        tokenOutChainId: UNISWAP_XLAYER_CHAIN_ID,
        amount: params.amountInBaseUnits,
        type: "EXACT_INPUT",
        autoSlippage: "DEFAULT",
        routingPreference: "BEST_PRICE",
        spreadOptimization: "EXECUTION",
        permitAmount: "FULL",
        urgency: "urgent",
      }),
    });

    const data = (await response.json().catch(() => null)) as UniswapQuoteResponse | null;
    if (!response.ok || !data?.quote?.output?.amount) {
      return null;
    }

    return {
      provider: "uniswap-trading-api",
      expectedInputAmount: formatUnits(params.amountInBaseUnits, params.fromToken.decimals),
      amountInBaseUnits: params.amountInBaseUnits,
      expectedOutputAmount: formatUnits(data.quote.output.amount, params.toToken.decimals),
      explanation: `Uniswap Trading API found a ${data.routing ?? "supported"} route for this swap.`,
      steps: [
        `Check approval for ${params.fromToken.symbol} if needed.`,
        "Request swap transaction data from Uniswap and have the user sign it.",
        "After the swap settles, send the arena join transaction from the wallet.",
      ],
      gasFeeUsd: data.quote.gasFeeUSD,
      routeSummary: data.quote.routeString,
      quoteId: data.requestId,
    };
  }

  async getQuoteForExactOutput(params: {
    walletAddress: string;
    fromToken: TokenInfo;
    toToken: TokenInfo;
    amountOutBaseUnits: string;
  }): Promise<UniswapQuotePlan | null> {
    if (!this.isEnabled()) {
      return null;
    }

    const tokenIn = this.resolveTokenAddress(params.fromToken);
    const tokenOut = this.resolveTokenAddress(params.toToken);
    if (!tokenIn || !tokenOut) {
      return null;
    }

    const response = await fetch(`${env.uniswapApiUrl}/quote`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": env.uniswapApiKey,
        "x-universal-router-version": "2.0",
      },
      body: JSON.stringify({
        generatePermitAsTransaction: false,
        swapper: params.walletAddress,
        tokenIn,
        tokenOut,
        tokenInChainId: UNISWAP_XLAYER_CHAIN_ID,
        tokenOutChainId: UNISWAP_XLAYER_CHAIN_ID,
        amount: params.amountOutBaseUnits,
        type: "EXACT_OUTPUT",
        autoSlippage: "DEFAULT",
        routingPreference: "BEST_PRICE",
        spreadOptimization: "EXECUTION",
        permitAmount: "FULL",
        urgency: "urgent",
      }),
    });

    const data = (await response.json().catch(() => null)) as UniswapQuoteResponse | null;
    const quote = data?.quote as { input?: { amount?: string }; output?: { amount?: string }; gasFeeUSD?: string; routeString?: string } | undefined;
    if (!response.ok || !quote?.input?.amount || !quote?.output?.amount) {
      return null;
    }

    return {
      provider: "uniswap-trading-api",
      expectedInputAmount: formatUnits(quote.input.amount, params.fromToken.decimals),
      amountInBaseUnits: quote.input.amount,
      expectedOutputAmount: formatUnits(quote.output.amount, params.toToken.decimals),
      explanation: `Uniswap Trading API sized this swap to deliver the required ${params.toToken.symbol} amount for the arena.`,
      steps: [
        `Check approval for ${params.fromToken.symbol} if needed.`,
        `Swap only the amount of ${params.fromToken.symbol} needed to reach the arena's ${params.toToken.symbol} entry requirement.`,
        "After the swap settles, send the arena join transaction from the wallet.",
      ],
      gasFeeUsd: quote.gasFeeUSD,
      routeSummary: quote.routeString,
      quoteId: data?.requestId,
    };
  }

  createInsufficientBalancePlan(
    balance: WalletTokenBalance,
    settlementToken: TokenInfo,
    requiredInputAmount: string,
    requiredOutputAmount: string,
  ): RoutePlan {
    return {
      provider: "insufficient-balance",
      fromToken: balance.token,
      toToken: settlementToken,
      expectedInputAmount: requiredInputAmount,
      expectedOutputAmount: requiredOutputAmount,
      routeType: "swap_then_join",
      explanation: `You need about ${requiredInputAmount} ${balance.token.symbol} to receive ${requiredOutputAmount} ${settlementToken.symbol}, but your wallet does not hold enough.`,
      steps: [
        `Current ${balance.token.symbol} balance: ${balance.formattedBalance}.`,
        `Required ${balance.token.symbol}: about ${requiredInputAmount}.`,
        `Top up ${balance.token.symbol}, or join directly with ${settlementToken.symbol}.`,
      ],
    };
  }

  createFallbackPlan(balance: WalletTokenBalance, settlementToken: TokenInfo, expectedInputAmount: string, expectedOutputAmount: string): RoutePlan {
    return {
      provider: "uniswap-skill-ready",
      fromToken: balance.token,
      toToken: settlementToken,
      expectedInputAmount,
      expectedOutputAmount,
      routeType: balance.token.symbol === settlementToken.symbol ? "direct_join" : "swap_then_join",
      explanation: `No live swap route is available for ${balance.token.symbol} to ${settlementToken.symbol} on the current X Layer setup.`,
      steps: [
        `Your wallet currently holds ${balance.token.symbol}, not ${settlementToken.symbol}.`,
        `Neither configured swap provider returned executable calldata for ${balance.token.symbol} to ${settlementToken.symbol}.`,
        `Use a wallet that already holds ${settlementToken.symbol}, or swap between the supported stablecoins first.`,
      ],
    };
  }

  async checkApproval(params: {
    walletAddress: string;
    token: TokenInfo;
    amountInBaseUnits: string;
  }): Promise<ApprovalTransaction | null> {
    if (!this.isEnabled() || params.token.kind === "native" || !params.token.address) return null;

    try {
      const response = await fetch(`${env.uniswapApiUrl}/check_approval`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": env.uniswapApiKey,
        },
        body: JSON.stringify({
          token: params.token.address,
          amount: params.amountInBaseUnits,
          walletAddress: params.walletAddress,
          chainId: UNISWAP_XLAYER_CHAIN_ID,
        }),
      });

      const data = (await response.json().catch(() => null)) as {
        approval?: { to?: string; data?: string; value?: string } | null;
      } | null;
      if (!response.ok || !data?.approval?.to) return null;

      return {
        to: data.approval.to,
        data: data.approval.data ?? "0x",
        value: "0",
        spender: data.approval.to,
        label: `Approve ${params.token.symbol} for Permit2`,
      };
    } catch {
      return null;
    }
  }

  async buildPermit2Approval(params: {
    walletAddress: string;
    token: TokenInfo;
    spender: string;
    amountInBaseUnits: string;
  }): Promise<ApprovalTransaction | null> {
    if (params.token.kind === "native" || !params.token.address) return null;

    const provider = new JsonRpcProvider(env.rpcUrl);
    const permit2 = new Contract(PERMIT2_ADDRESS, permit2Abi, provider);

    try {
      const [allowedAmount, expiration] = await permit2.allowance(
        params.walletAddress,
        params.token.address,
        params.spender,
      ) as [bigint, bigint, bigint];

      const now = BigInt(Math.floor(Date.now() / 1000));
      const requiredAmount = BigInt(params.amountInBaseUnits);
      if (allowedAmount >= requiredAmount && expiration > now) {
        return null;
      }

      const iface = new Interface(permit2Abi);
      const approvalExpiry = now + BigInt(PERMIT2_APPROVAL_DURATION_SECONDS);
      return {
        to: PERMIT2_ADDRESS,
        data: iface.encodeFunctionData("approve", [params.token.address, params.spender, PERMIT2_MAX_APPROVAL, approvalExpiry]),
        value: "0",
        spender: params.spender,
        label: `Approve Permit2 for ${params.token.symbol} swap`,
      };
    } catch {
      return null;
    }
  }

  async buildSwapTransaction(params: {
    walletAddress: string;
    fromToken: TokenInfo;
    toToken: TokenInfo;
    amountInBaseUnits: string;
  }): Promise<SwapTransaction | null> {
    if (!this.isEnabled()) return null;

    const tokenIn = this.resolveTokenAddress(params.fromToken);
    const tokenOut = this.resolveTokenAddress(params.toToken);
    if (!tokenIn || !tokenOut) return null;

    // Fetch a fresh quote, then immediately request executable swap calldata
    const quoteBody = {
      generatePermitAsTransaction: false,
      swapper: params.walletAddress,
      tokenIn,
      tokenOut,
      tokenInChainId: UNISWAP_XLAYER_CHAIN_ID,
      tokenOutChainId: UNISWAP_XLAYER_CHAIN_ID,
      amount: params.amountInBaseUnits,
      type: "EXACT_INPUT",
      autoSlippage: "DEFAULT",
      routingPreference: "BEST_PRICE",
      spreadOptimization: "EXECUTION",
      permitAmount: "FULL",
      urgency: "urgent",
    };

    const quoteResponse = await fetch(`${env.uniswapApiUrl}/quote`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": env.uniswapApiKey,
        "x-universal-router-version": "2.0",
      },
      body: JSON.stringify(quoteBody),
    });

    const fullQuote = (await quoteResponse.json().catch(() => null)) as { quote?: Record<string, unknown> } | null;
    if (!quoteResponse.ok || !fullQuote?.quote) return null;

    const swapResponse = await fetch(`${env.uniswapApiUrl}/swap`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": env.uniswapApiKey,
        "x-universal-router-version": "2.0",
      },
      body: JSON.stringify({ quote: fullQuote.quote }),
    });

    const swapData = (await swapResponse.json().catch(() => null)) as {
      swap?: { to?: string; value?: string; data?: string; gasUseEstimate?: string };
    } | null;
    if (!swapResponse.ok || !swapData?.swap?.to || !swapData?.swap?.data) return null;

    return {
      provider: "uniswap-trading-api",
      to: swapData.swap.to,
      data: swapData.swap.data,
      value: swapData.swap.value ?? "0",
      gasEstimate: swapData.swap.gasUseEstimate,
    };
  }

  private resolveTokenAddress(token: TokenInfo): string | null {
    if (token.kind === "native") {
      return "0x0000000000000000000000000000000000000000";
    }
    return token.address;
  }
}