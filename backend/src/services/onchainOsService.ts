import { createHmac } from "crypto";
import { env } from "../config/env.js";
import { SwapTransaction } from "../types/arena.js";

type OkxDexQuoteData = {
  toTokenAmount: string;
  estimateGasFee: string;
  routerList?: Array<{ router: string; routerPercent: string }>;
};

type OkxDexSwapData = {
  tx?: {
    data?: string;
    from?: string;
    gas?: string;
    gasPrice?: string;
    to?: string;
    value?: string;
  };
};

type OkxApiResponse<T> = {
  code: string;
  data?: T[];
  msg: string;
};

export class OnchainOsService {
  private readonly baseUrl = "https://www.okx.com";

  isEnabled(): boolean {
    return Boolean(env.onchainOsApiKey && env.onchainOsSecretKey && env.onchainOsPassphrase);
  }

  getStatus() {
    return {
      enabled: this.isEnabled(),
      capabilities: [
        "Agentic Wallet identity and key management",
        "Public wallet portfolio enrichment for player funding analysis",
        "DEX aggregation trade across 400+ protocols",
        "Market data and token pricing",
        "Gateway transaction simulation and broadcast",
        "x402 payment signing compatibility for payment-gated resources",
      ],
      recommendedSkills: [
        "okx-agentic-wallet",
        "okx-wallet-portfolio",
        "okx-dex-swap",
        "okx-onchain-gateway",
        "okx-x402-payment",
      ],
      note: "Onchain OS is the optional OKX-backed execution and portfolio layer alongside ArenaAgent's live Uniswap routing.",
    };
  }

  async getDexQuote(params: {
    chainId: number;
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    slippage?: string;
  }): Promise<OkxApiResponse<OkxDexQuoteData> | null> {
    if (!this.isEnabled()) return null;

    const path = "/api/v6/dex/aggregator/quote";
    const queryParams = new URLSearchParams({
      chainIndex: String(params.chainId),
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      amount: params.amount,
      swapMode: "exactIn",
    });
    const fullPath = `${path}?${queryParams.toString()}`;
    const authHeaders = this.buildAuthHeaders("GET", fullPath);
    const traceHeaders = this.buildTraceHeaders(params.fromTokenAddress);

    try {
      const response = await fetch(`${this.baseUrl}${fullPath}`, {
        headers: {
          ...authHeaders,
          ...traceHeaders,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) return null;
      const payload = (await response.json()) as OkxApiResponse<OkxDexQuoteData>;
      return payload.code === "0" ? payload : null;
    } catch {
      return null;
    }
  }

  async buildSwapTransaction(params: {
    chainId: number;
    fromTokenAddress: string;
    toTokenAddress: string;
    amount: string;
    userWalletAddress: string;
    slippage?: string;
  }): Promise<SwapTransaction | null> {
    if (!this.isEnabled()) return null;

    const path = "/api/v6/dex/aggregator/swap";
    const queryParams = new URLSearchParams({
      chainIndex: String(params.chainId),
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      amount: params.amount,
      userWalletAddress: params.userWalletAddress,
      swapMode: "exactIn",
      gasLevel: "average",
    });
    const normalizedSlippage = this.normalizeSlippagePercent(params.slippage);
    if (normalizedSlippage) {
      queryParams.set("slippagePercent", normalizedSlippage);
    } else {
      queryParams.set("autoSlippage", "true");
      queryParams.set("slippagePercent", "0.5");
    }

    const fullPath = `${path}?${queryParams.toString()}`;
    const authHeaders = this.buildAuthHeaders("GET", fullPath);
    const traceHeaders = this.buildTraceHeaders(params.fromTokenAddress);

    try {
      const response = await fetch(`${this.baseUrl}${fullPath}`, {
        headers: {
          ...authHeaders,
          ...traceHeaders,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) return null;
      const payload = (await response.json()) as OkxApiResponse<OkxDexSwapData>;
      if (payload.code !== "0") return null;

      const txData = payload.data?.[0]?.tx;
      if (!txData?.to || !txData?.data) return null;

      return {
        provider: "okx-dex-aggregator",
        to: txData.to,
        data: txData.data,
        value: txData.value ?? "0",
        gasEstimate: txData.gas,
      };
    } catch {
      return null;
    }
  }

  private sign(timestamp: string, method: string, requestPath: string, body: string): string {
    const message = `${timestamp}${method}${requestPath}${body}`;
    return createHmac("sha256", env.onchainOsSecretKey)
      .update(message)
      .digest("base64");
  }

  private buildAuthHeaders(method: string, requestPath: string, body = ""): Record<string, string> {
    const timestamp = new Date().toISOString();
    return {
      "OK-ACCESS-KEY": env.onchainOsApiKey,
      "OK-ACCESS-SIGN": this.sign(timestamp, method, requestPath, body),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": env.onchainOsPassphrase,
    };
  }

  private buildTraceHeaders(seed: string): Record<string, string> {
    const timestamp = Date.now().toString();
    return {
      "ok-client-tid": `${seed}${timestamp}`,
      "ok-client-timestamp": timestamp,
    };
  }

  private normalizeSlippagePercent(slippage?: string): string | null {
    if (!slippage) return null;

    const numeric = Number(slippage);
    if (!Number.isFinite(numeric) || numeric < 0) return null;
    if (numeric > 0 && numeric < 1) return String(numeric * 100);
    return slippage;
  }
}