import { BrowserProvider, Contract, Eip1193Provider, MaxUint256, formatUnits, Interface } from "ethers";

type X402AcceptedOption = {
  scheme: "exact";
  network: string;
  amount: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    arenaId: number;
  };
};

type X402Challenge = {
  x402Version?: number;
  resource?: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepts?: X402AcceptedOption[];
};

type SwapTxData = { to: string; data: string; value: string };

type SwapAndJoinPlan = {
  provider: string;
  isDirect: boolean;
  requiresApproval: boolean;
  approvalTxs: Array<SwapTxData & { label?: string }>;
  swapTx: SwapTxData | null;
  joinTx: SwapTxData;
};

const abi = [
  "function joinArena(uint256 arenaId) payable",
  "function claim(uint256 arenaId)",
  "function rewardAmounts(uint256 arenaId, address player) view returns (uint256)"
] as const;

const TARGET_CHAIN_ID_DEC = Number(import.meta.env.VITE_CHAIN_ID ?? 1952);
const TARGET_CHAIN_ID_HEX = `0x${TARGET_CHAIN_ID_DEC.toString(16)}`;
const TARGET_CHAIN_NAME = import.meta.env.VITE_CHAIN_NAME ?? "X Layer Testnet";
const TARGET_RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://testrpc.xlayer.tech";
const TARGET_EXPLORER_URL = import.meta.env.VITE_EXPLORER_URL ?? "https://www.oklink.com/xlayer-test";
const TARGET_CURRENCY_SYMBOL = import.meta.env.VITE_NATIVE_SYMBOL ?? "OKB";

function getEthereumProvider(): Eip1193Provider {
  const ethereum = window.ethereum;
  if (!ethereum) {
    throw new Error("No wallet found. Install MetaMask or OKX Wallet.");
  }

  return ethereum;
}

async function ensureCorrectNetwork(): Promise<BrowserProvider> {
  const ethereum = getEthereumProvider();
  const provider = new BrowserProvider(ethereum);
  const network = await provider.getNetwork();
  if (Number(network.chainId) === TARGET_CHAIN_ID_DEC) {
    return provider;
  }

  try {
    await ethereum.request?.({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: TARGET_CHAIN_ID_HEX }],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const needsAddChain = message.includes("4902") || message.includes("Unrecognized chain") || message.includes("not been added");
    if (needsAddChain) {
      await ethereum.request?.({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: TARGET_CHAIN_ID_HEX,
          chainName: TARGET_CHAIN_NAME,
          nativeCurrency: {
            name: TARGET_CURRENCY_SYMBOL,
            symbol: TARGET_CURRENCY_SYMBOL,
            decimals: 18,
          },
          rpcUrls: [TARGET_RPC_URL],
          blockExplorerUrls: [TARGET_EXPLORER_URL],
        }],
      });
    } else {
      throw new Error(`Switch your wallet to ${TARGET_CHAIN_NAME} before continuing.`);
    }
  }

  return new BrowserProvider(ethereum);
}

export async function getConnectedAddress(): Promise<string> {
  const provider = await ensureCorrectNetwork();
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  return signer.address;
}

export async function joinArenaWithWallet(
  contractAddress: string,
  arenaId: number,
  entryFeeWei: string,
  onStep?: (step: string) => void,
): Promise<string> {
  const provider = await ensureCorrectNetwork();
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const contract = new Contract(contractAddress, abi, signer);
  onStep?.("Confirm the join in your wallet...");
  const tx = await contract.joinArena(arenaId, { value: entryFeeWei });
  onStep?.("Transaction sent. Waiting for confirmation...");
  const receipt = await tx.wait();
  return (tx as { hash: string }).hash ?? (receipt as { hash: string }).hash;
}

export async function claimReward(contractAddress: string, arenaId: number): Promise<void> {
  const provider = await ensureCorrectNetwork();
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const contract = new Contract(contractAddress, abi, signer);
  const tx = await contract.claim(arenaId);
  await tx.wait();
}

export async function getFallbackReward(contractAddress: string, arenaId: number, user: string): Promise<bigint> {
  const provider = await ensureCorrectNetwork();
  const contract = new Contract(contractAddress, abi, provider);
  return (await contract.rewardAmounts(arenaId, user)) as bigint;
}

export async function executeSwapAndJoin(
  plan: SwapAndJoinPlan,
  onStep?: (step: string) => void,
): Promise<string> {
  const provider = await ensureCorrectNetwork();
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();

  if (plan.requiresApproval && plan.approvalTxs.length > 0) {
    for (const approvalTx of plan.approvalTxs) {
      onStep?.(approvalTx.label ?? "Approving swap step…");
      const approveTx = await signer.sendTransaction({
        to: approvalTx.to,
        data: approvalTx.data,
        value: BigInt(approvalTx.value),
      });
      await approveTx.wait();
    }
  }

  if (!plan.isDirect && plan.swapTx) {
    onStep?.(`Swapping via ${plan.provider}…`);
    const swapTx = await signer.sendTransaction({
      to: plan.swapTx.to,
      data: plan.swapTx.data,
      value: BigInt(plan.swapTx.value),
    });
    await swapTx.wait();
  }

  onStep?.("Joining arena…");
  const joinTx = await signer.sendTransaction({
    to: plan.joinTx.to,
    data: plan.joinTx.data,
    value: BigInt(plan.joinTx.value),
  });
  const receipt = await joinTx.wait();
  return (receipt as { hash: string }).hash;
}

export async function executeSwapOnly(
  plan: SwapAndJoinPlan,
  onStep?: (step: string) => void,
): Promise<string> {
  const provider = await ensureCorrectNetwork();
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();

  if (plan.requiresApproval && plan.approvalTxs.length > 0) {
    for (const approvalTx of plan.approvalTxs) {
      onStep?.(approvalTx.label ?? "Approving swap step…");
      const approveTx = await signer.sendTransaction({
        to: approvalTx.to,
        data: approvalTx.data,
        value: BigInt(approvalTx.value),
      });
      await approveTx.wait();
    }
  }

  if (!plan.swapTx) {
    throw new Error("No swap transaction is available for this route.");
  }

  onStep?.(`Swapping via ${plan.provider}…`);
  const swapTx = await signer.sendTransaction({
    to: plan.swapTx.to,
    data: plan.swapTx.data,
    value: BigInt(plan.swapTx.value),
  });
  const receipt = await swapTx.wait();
  return (receipt as { hash: string }).hash;
}

const erc20Iface = new Interface([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export type CustomTokenBalance = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  formattedBalance: string;
};

const CUSTOM_TOKENS_KEY = "arena_custom_tokens";

export function loadCustomTokenAddresses(): string[] {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_TOKENS_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function saveCustomTokenAddress(address: string): void {
  const existing = loadCustomTokenAddresses();
  const normalized = address.toLowerCase();
  if (!existing.map((a) => a.toLowerCase()).includes(normalized)) {
    localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify([...existing, address]));
  }
}

export async function fetchCustomTokenBalance(tokenAddress: string, userAddress: string): Promise<CustomTokenBalance> {
  const provider = await ensureCorrectNetwork();
  const contract = new Contract(tokenAddress, erc20Iface, provider);
  const [symbol, name, decimals, rawBalance] = await Promise.all([
    contract.symbol() as Promise<string>,
    contract.name() as Promise<string>,
    contract.decimals() as Promise<bigint>,
    contract.balanceOf(userAddress) as Promise<bigint>,
  ]);
  const dec = Number(decimals);
  return {
    address: tokenAddress,
    symbol,
    name,
    decimals: dec,
    formattedBalance: Number(formatUnits(rawBalance, dec)).toFixed(Math.min(6, dec)),
  };
}

export async function getTokenAllowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
  const provider = await ensureCorrectNetwork();
  const contract = new Contract(tokenAddress, erc20Iface, provider);
  return (await contract.allowance(owner, spender)) as bigint;
}

export async function approveToken(tokenAddress: string, spender: string, onStep?: (step: string) => void): Promise<void> {
  const provider = await ensureCorrectNetwork();
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const contract = new Contract(tokenAddress, erc20Iface, signer);
  onStep?.("Approve the token in your wallet...");
  const tx = await contract.approve(spender, MaxUint256);
  onStep?.("Approval submitted. Waiting for confirmation...");
  await tx.wait();
}

export async function signX402ExactPayment(challenge: X402Challenge, onStep?: (step: string) => void): Promise<string> {
  const accepted = challenge.accepts?.find((option) => option.scheme === "exact") ?? challenge.accepts?.[0];
  if (!accepted) {
    throw new Error("No x402 payment option is available for this arena.");
  }

  const provider = await ensureCorrectNetwork();
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const from = await signer.getAddress();
  const chainId = Number(accepted.network.replace(/^eip155:/, ""));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = `0x${Array.from(nonceBytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
  const authorization = {
    from,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: "0",
    validBefore: String(nowSeconds + accepted.maxTimeoutSeconds),
    nonce,
  };

  onStep?.("Sign the x402 authorization in your wallet...");
  const signature = await signer.signTypedData(
    {
      name: accepted.extra?.name ?? "ArenaAgent Entry",
      version: accepted.extra?.version ?? "2",
      chainId,
      verifyingContract: accepted.asset,
    },
    {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    authorization,
  );

  const payload = {
    x402Version: challenge.x402Version ?? 2,
    resource: challenge.resource,
    accepted,
    payload: {
      signature,
      authorization,
    },
  };

  return btoa(JSON.stringify(payload));
}
