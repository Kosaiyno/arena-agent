import { formatUnits } from "ethers";
import { env } from "../config/env.js";
import { WalletTokenBalance } from "../types/arena.js";
import { TokenRegistry } from "./tokenRegistry.js";

type OkLinkTokenEntry = {
  token?: string;
  symbol?: string;
  tokenContractAddress?: string;
  holdingAmount?: string;
};

type OkLinkResponse = {
  code: string;
  data?: Array<{
    tokenList?: OkLinkTokenEntry[];
  }>;
};

export type OkxPortfolioSnapshot = {
  enabled: boolean;
  source: "oklink" | "onchain";
  tokenCount: number;
  balances: WalletTokenBalance[];
};

export class OkxPortfolioService {
  constructor(private readonly tokenRegistry: TokenRegistry) {}

  isEnabled(): boolean {
    return Boolean(env.okLinkApiKey);
  }

  async enrichBalances(
    address: string,
    balances: WalletTokenBalance[],
    getNativeBalance?: (user: string) => Promise<bigint>,
  ): Promise<OkxPortfolioSnapshot> {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        source: "onchain",
        tokenCount: balances.length,
        balances,
      };
    }

    const extraBalances = await this.getBalances(address, getNativeBalance);
    const merged = this.mergeBalances(balances, extraBalances);
    return {
      enabled: true,
      source: "oklink",
      tokenCount: merged.length,
      balances: merged,
    };
  }

  async getBalances(address: string, getNativeBalance?: (user: string) => Promise<bigint>): Promise<WalletTokenBalance[]> {
    if (!this.isEnabled()) {
      return [];
    }

    const balances: WalletTokenBalance[] = [];

    if (getNativeBalance) {
      try {
        const rawOkb = (await getNativeBalance(address)).toString();
        const formatted = Number(formatUnits(rawOkb, 18));
        balances.push({
          token: { symbol: "OKB", name: "OKB", address: null, decimals: 18, kind: "native" },
          rawBalance: rawOkb,
          formattedBalance: formatted.toFixed(6),
          estimatedValueInSettlement: formatted,
          canCoverEntry: true,
        });
      } catch {
        // Ignore native balance enrichment failures and keep the core route flow working.
      }
    }

    try {
      const url = `https://www.oklink.com/api/v5/explorer/address/address-balance-token?chainShortName=${env.okLinkChainShortName}&address=${address}&limit=50`;
      const response = await fetch(url, {
        headers: { "OK-ACCESS-KEY": env.okLinkApiKey },
      });
      if (!response.ok) {
        return balances;
      }

      const data = (await response.json()) as OkLinkResponse;
      const tokenList = data.data?.[0]?.tokenList ?? [];
      for (const token of tokenList) {
        balances.push(this.toWalletTokenBalance(token));
      }
    } catch {
      return balances;
    }

    return balances;
  }

  private mergeBalances(baseBalances: WalletTokenBalance[], extraBalances: WalletTokenBalance[]): WalletTokenBalance[] {
    const merged = new Map<string, WalletTokenBalance>();

    for (const balance of baseBalances) {
      merged.set(this.balanceKey(balance), balance);
    }

    for (const balance of extraBalances) {
      const key = this.balanceKey(balance);
      if (!merged.has(key)) {
        merged.set(key, balance);
      }
    }

    return Array.from(merged.values()).sort((left, right) => {
      if (left.estimatedValueInSettlement !== right.estimatedValueInSettlement) {
        return right.estimatedValueInSettlement - left.estimatedValueInSettlement;
      }
      return left.token.symbol.localeCompare(right.token.symbol);
    });
  }

  private toWalletTokenBalance(token: OkLinkTokenEntry): WalletTokenBalance {
    const address = token.tokenContractAddress ?? null;
    const registryToken = address
      ? this.tokenRegistry.list().find((item) => item.address?.toLowerCase() === address.toLowerCase())
      : this.tokenRegistry.getBySymbol(token.symbol ?? token.token ?? "");
    const decimals = registryToken?.decimals ?? 18;
    const holdingAmount = Number(token.holdingAmount ?? "0");

    return {
      token: {
        symbol: registryToken?.symbol ?? token.symbol ?? token.token ?? "UNKNOWN",
        name: registryToken?.name ?? token.token ?? token.symbol ?? "Unknown token",
        address: registryToken?.address ?? address,
        decimals,
        kind: registryToken?.kind ?? "erc20",
      },
      rawBalance: "0",
      formattedBalance: holdingAmount.toFixed(Math.min(6, decimals)),
      estimatedValueInSettlement: 0,
      canCoverEntry: false,
    };
  }

  private balanceKey(balance: WalletTokenBalance): string {
    if (balance.token.address) {
      return balance.token.address.toLowerCase();
    }
    return `native:${balance.token.symbol.toLowerCase()}`;
  }
}