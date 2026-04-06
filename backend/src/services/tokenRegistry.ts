import { env } from "../config/env.js";
import { TokenInfo } from "../types/arena.js";

type SupportedToken = TokenInfo & {
  rateToNative: number;
};

export class TokenRegistry {
  private readonly tokens: SupportedToken[] = env.supportedTokens;

  list(): SupportedToken[] {
    return this.tokens;
  }

  getBySymbol(symbol: string): SupportedToken | null {
    return this.tokens.find((token) => token.symbol.toLowerCase() === symbol.toLowerCase()) ?? null;
  }

  getDefaultSettlementToken(): SupportedToken {
    return this.getBySymbol("USDC") ?? this.getBySymbol("OKB") ?? this.tokens[0];
  }
}