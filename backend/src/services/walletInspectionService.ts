import { Contract, formatUnits } from "ethers";
import { ArenaState, TokenInfo, WalletTokenBalance } from "../types/arena.js";
import { ContractService } from "./contractService.js";
import { TokenRegistry } from "./tokenRegistry.js";

const erc20Abi = ["function balanceOf(address account) view returns (uint256)"] as const;
type InspectableToken = TokenInfo & { rateToNative: number };

export class WalletInspectionService {
  constructor(
    private readonly contractService: ContractService,
    private readonly tokenRegistry: TokenRegistry,
  ) {}

  async inspectWallet(user: string, arena: ArenaState, extraTokens: TokenInfo[] = []): Promise<WalletTokenBalance[]> {
    const provider = this.contractService.getProvider();
    const tokens = this.mergeTokens(extraTokens);
    const settlementToken = arena.settlementToken ?? this.tokenRegistry.getDefaultSettlementToken();
    const settlementRate = this.getNativeRate(settlementToken.symbol);

    const balances = await Promise.all(tokens.map(async (token) => {
      let rawBalance = "0";
      if (token.kind === "native") {
        rawBalance = (await provider.getBalance(user)).toString();
      } else if (token.address) {
        const contract = new Contract(token.address, erc20Abi, provider);
        rawBalance = (await contract.balanceOf(user)).toString();
      }

      const formatted = Number(formatUnits(rawBalance, token.decimals));
      const estimatedValueInSettlement = token.rateToNative === 0 || settlementRate === 0
        ? 0
        : (formatted * token.rateToNative) / settlementRate;
      const requiredSettlementAmount = Number(formatUnits(arena.entryFeeWei, settlementToken.decimals));

      return {
        token: {
          symbol: token.symbol,
          name: token.name,
          address: token.address,
          decimals: token.decimals,
          kind: token.kind,
        },
        rawBalance,
        formattedBalance: formatted.toFixed(Math.min(6, token.decimals)),
        estimatedValueInSettlement,
        canCoverEntry: estimatedValueInSettlement >= requiredSettlementAmount,
      };
    }));

    return balances.sort((left, right) => right.estimatedValueInSettlement - left.estimatedValueInSettlement);
  }

  private getNativeRate(symbol: string): number {
    return this.tokenRegistry.getBySymbol(symbol)?.rateToNative ?? 1;
  }

  private mergeTokens(extraTokens: TokenInfo[]): InspectableToken[] {
    const merged = new Map<string, InspectableToken>();

    for (const token of this.tokenRegistry.list()) {
      merged.set(this.tokenKey(token), token);
    }

    for (const token of extraTokens) {
      const registryMatch = this.tokenRegistry.getBySymbol(token.symbol);
      const normalized: InspectableToken = {
        ...token,
        rateToNative: registryMatch?.rateToNative ?? this.inferRate(token.symbol, token.kind),
      };
      merged.set(this.tokenKey(normalized), normalized);
    }

    return Array.from(merged.values());
  }

  private tokenKey(token: TokenInfo): string {
    return token.address ? token.address.toLowerCase() : `native:${token.symbol.toLowerCase()}`;
  }

  private inferRate(symbol: string, kind: TokenInfo["kind"]): number {
    if (kind === "native") return 1;
    const normalized = symbol.toLowerCase();
    if (normalized === "okb" || normalized === "wokb") return 1;
    if (normalized === "usdc" || normalized === "usdt" || normalized === "usdg") return 1 / 1800;
    return 0;
  }
}