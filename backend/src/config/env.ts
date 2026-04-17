import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function parsePayouts(value: string): number[] {
  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part) && part > 0);
}

function parseSupportedTokens(value: string): Array<{
  symbol: string;
  name: string;
  address: string | null;
  decimals: number;
  kind: "native" | "erc20";
  rateToNative: number;
}> {
  try {
    const parsed = JSON.parse(value) as Array<{
      symbol: string;
      name: string;
      address?: string | null;
      decimals: number;
      kind: "native" | "erc20";
      rateToNative: number;
    }>;
    return parsed.map((token) => ({
      symbol: token.symbol,
      name: token.name,
      address: token.address ?? null,
      decimals: token.decimals,
      kind: token.kind,
      rateToNative: token.rateToNative,
    }));
  } catch {
    return [
      { symbol: "ETH", name: "Ether", address: null, decimals: 18, kind: "native", rateToNative: 1 },
      { symbol: "WETH", name: "Wrapped Ether", address: null, decimals: 18, kind: "erc20", rateToNative: 1 },
      { symbol: "USDC", name: "USD Coin", address: null, decimals: 6, kind: "erc20", rateToNative: 1 / 1800 },
      { symbol: "USDT", name: "Tether", address: null, decimals: 6, kind: "erc20", rateToNative: 1 / 1800 },
    ];
  }
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  rpcUrl: required("RPC_URL"),
  privateKey: required("PRIVATE_KEY"),
  contractAddress: required("CONTRACT_ADDRESS"),
  appChainId: Number(process.env.APP_CHAIN_ID ?? 31337),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000),
  defaultPayouts: parsePayouts(process.env.DEFAULT_PAYOUTS ?? "100"),
  stateFilePath: process.env.STATE_FILE_PATH ?? "./data/state.json",
  supportedTokens: parseSupportedTokens(process.env.SUPPORTED_TOKENS_JSON ?? ""),
  uniswapApiKey: process.env.UNISWAP_API_KEY ?? "",
  uniswapApiUrl: process.env.UNISWAP_API_URL ?? "https://trade-api.gateway.uniswap.org/v1",
  onchainOsApiKey: process.env.ONCHAIN_OS_API_KEY ?? "",
  onchainOsSecretKey: process.env.ONCHAIN_OS_SECRET_KEY ?? "",
  onchainOsPassphrase: process.env.ONCHAIN_OS_PASSPHRASE ?? "",
  openAiApiKey: process.env.OPENAI_API_KEY ?? "",
  openAiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  openAiModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  x402Enabled: (process.env.X402_ENABLED ?? "true") !== "false",
  preferOkxSwap: (process.env.PREFER_OKX_SWAP ?? "false") === "true",
  okLinkApiKey: process.env.OKLINK_API_KEY ?? "",
  okLinkChainShortName: process.env.OKLINK_CHAIN_SHORT_NAME ?? "XLAYER",
  // sponsorPrivateKey removed as automated sponsor signer was reverted
};
