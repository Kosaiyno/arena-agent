import { Wallet } from "ethers";
import { env } from "../config/env.js";

export type AgentWalletIdentity = {
  name: string;
  address: string;
  role: string;
  chain: {
    name: string;
    chainId: number;
  };
  capabilities: string[];
  skills: string[];
  integrations: {
    uniswapTradingApi: boolean;
    onchainOs: boolean;
    x402: boolean;
  };
  contractAddress: string;
};

export class AgentWalletService {
  private readonly address: string;

  constructor() {
    this.address = new Wallet(env.privateKey).address;
  }

  getIdentity(): AgentWalletIdentity {
    return {
      name: "ArenaAgent Operator",
      address: this.address,
      role: "arena-operator",
      chain: {
        name: this.getChainName(),
        chainId: env.appChainId,
      },
      capabilities: [
        "Create and manage competitive arenas on-chain",
        "Submit verified player scores via operator key",
        "Automatically close and finalize arenas on a timer",
        "Inspect wallet balances and recommend optimal token entry routes",
        "Fetch live swap quotes via Uniswap Trading API",
        "Execute DEX swaps via OKX / Onchain OS aggregator",
        "Issue x402 payment challenges and verify on-chain proof",
      ],
      skills: [
        "uniswap/swap-integration",
        "okx/agentic-wallet",
        "okx/dex-swap",
        "okx/wallet-portfolio",
        "okx/onchain-gateway",
      ],
      integrations: {
        uniswapTradingApi: Boolean(env.uniswapApiKey),
        onchainOs: Boolean(env.onchainOsApiKey && env.onchainOsSecretKey && env.onchainOsPassphrase),
        x402: env.x402Enabled,
      },
      contractAddress: env.contractAddress,
    };
  }

  getAddress(): string {
    return this.address;
  }

  private getChainName(): string {
    switch (env.appChainId) {
      case 196: return "X Layer Mainnet";
      case 195: return "X Layer Testnet";
      case 31337: return "Hardhat Local";
      case 1: return "Ethereum Mainnet";
      case 11155111: return "Ethereum Sepolia";
      default: return `Chain ${env.appChainId}`;
    }
  }
}
