import { createHmac } from "crypto";
import { env } from "../config/env.js";
import { SwapTransaction } from "../types/arena.js";

type OkxDexQuoteData = {
  toTokenAmount: string;
  estimateGasFee: string;
  routerList?: Array<{ router: string; routerPercent: string }>;
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
        "DEX aggregation trade across 400+ protocols",
        "Market data and token pricing",
        "Gateway transaction simulation and broadcast",
      ],
      recommendedSkills: [
        "okx-agentic-wallet",
        "okx-wallet-portfolio",
        "okx-dex-swap",
        "okx-onchain-gateway",
      ],
      note: "Onchain OS is the X Layer-native agent execution layer for ArenaAgent.",
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

    const path = "/api/v5/dex/aggregator/quote";
    const queryParams = new URLSearchParams({
      chainId: String(params.chainId),
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      amount: params.amount,
      slippage: params.slippage ?? "0.005",
    });
    const fullPath = `${path}?${queryParams.toString()}`;
    const timestamp = new Date().toISOString();
    const sign = this.sign(timestamp, "GET", fullPath, "");

    try {
      const response = await fetch(`${this.baseUrl}${fullPath}`, {
        headers: {
          "OK-ACCESS-KEY": env.onchainOsApiKey,
          "OK-ACCESS-SIGN": sign,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": env.onchainOsPassphrase,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) return null;
      return (await response.json()) as OkxApiResponse<OkxDexQuoteData>;
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

    const path = "/api/v5/dex/aggregator/swap";
    const queryParams = new URLSearchParams({
      chainId: String(params.chainId),
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      amount: params.amount,
      userWalletAddress: params.userWalletAddress,
      slippage: params.slippage ?? "0.005",
    });
    const fullPath = `${path}?${queryParams.toString()}`;
    const timestamp = new Date().toISOString();
    const sign = this.sign(timestamp, "GET", fullPath, "");

    try {
      const response = await fetch(`${this.baseUrl}${fullPath}`, {
        headers: {
          "OK-ACCESS-KEY": env.onchainOsApiKey,
          "OK-ACCESS-SIGN": sign,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": env.onchainOsPassphrase,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) return null;
      const data = (await response.json()) as {
        code: string;
        data?: Array<{ tx: { data: string; from: string; gas: string; gasPrice: string; to: string; value: string } }>;
      };
      const txData = data.data?.[0]?.tx;
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
}