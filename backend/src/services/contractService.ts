import { Contract, JsonRpcProvider, Wallet, formatEther } from "ethers";
import { env } from "../config/env.js";
import { ArenaState } from "../types/arena.js";
import { contractAbi } from "./contractAbi.js";

const DEFAULT_ENTRY_TOKEN_ADDRESS = env.supportedTokens.find((token) => token.symbol === "USDC")?.address ?? null;

export class ContractService {
  private readonly provider = new JsonRpcProvider(env.rpcUrl);
  private readonly signer = new Wallet(env.privateKey, this.provider);
  private readonly contract = new Contract(env.contractAddress, contractAbi, this.signer);

  async createArena(entryFeeWei: string, durationSeconds: number, entryTokenAddress: string | null = DEFAULT_ENTRY_TOKEN_ADDRESS): Promise<number> {
    const tx = await this.contract.createArena(entryFeeWei, durationSeconds, entryTokenAddress ?? "0x0000000000000000000000000000000000000000");
    const receipt = await tx.wait();
    const createdLog = receipt.logs
      .map((log: unknown) => {
        try {
          return this.contract.interface.parseLog(log as { topics: string[]; data: string });
        } catch {
          return null;
        }
      })
      .find((parsed: { name?: string; args?: unknown[] } | null) => parsed?.name === "ArenaCreated");

    if (createdLog) {
      return Number(createdLog.args[0]);
    }

    const arenaCount = await this.contract.arenaCount();
    return Number(arenaCount);
  }

  async joinArenaFor(arenaId: number, user: string): Promise<void> {
    const tx = await this.contract.joinArenaFor(arenaId, user);
    await tx.wait();
  }

  async submitScore(arenaId: number, user: string, score: number): Promise<void> {
    const tx = await this.contract.submitScore(arenaId, user, score);
    await tx.wait();
  }

  async closeArena(arenaId: number): Promise<void> {
    const tx = await this.contract.closeArena(arenaId);
    await tx.wait();
  }

  async finalizeArena(arenaId: number, winners: string[], percentages: number[]): Promise<void> {
    const tx = await this.contract.finalizeArena(arenaId, winners, percentages);
    await tx.wait();
  }

  async getArenaWinners(arenaId: number): Promise<string[]> {
    return (await this.contract.getArenaWinners(arenaId)) as string[];
  }

  async getRewardAmount(arenaId: number, user: string): Promise<string> {
    const reward = await this.contract.rewardAmounts(arenaId, user);
    return reward.toString();
  }

  async getArena(arenaId: number): Promise<ArenaState> {
    const result = await this.contract.getArena(arenaId);
    const players: string[] = await this.contract.getArenaPlayers(arenaId);

    return {
      id: Number(result[0]),
      entryFeeWei: result[1].toString(),
      totalPoolWei: result[2].toString(),
      createdAt: Number(result[3]),
      endTime: Number(result[4]),
      closed: result[5],
      finalized: result[6],
      entryTokenAddress: result[7] === "0x0000000000000000000000000000000000000000" ? null : result[7],
      players,
    };
  }

  async listArenas(): Promise<ArenaState[]> {
    const arenaCount = Number(await this.contract.arenaCount());
    return Promise.all(
      Array.from({ length: arenaCount }, (_, index) => this.getArena(index + 1)),
    );
  }

  getProvider(): JsonRpcProvider {
    return this.provider;
  }

  formatWeiToEth(value: string): string {
    return formatEther(value);
  }
}
