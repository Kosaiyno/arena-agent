import { ArenaState, TokenInfo } from "../types/arena.js";
import { ContractService } from "./contractService.js";
import { StateStore } from "./stateStore.js";
import { TokenRegistry } from "./tokenRegistry.js";

export class ArenaViewService {
  constructor(
    private readonly contractService: ContractService,
    private readonly stateStore: StateStore,
    private readonly tokenRegistry: TokenRegistry,
  ) {}

  async getArena(arenaId: number): Promise<ArenaState> {
    const arena = await this.contractService.getArena(arenaId);
    const config = this.stateStore.getArenaConfig(arenaId);
    const settlementToken = this.resolveSettlementToken(config?.settlementTokenSymbol);
    return {
      ...arena,
      settlementToken,
    };
  }

  async listArenas(): Promise<ArenaState[]> {
    const arenas = await this.contractService.listArenas();
    return arenas.map((arena) => ({
      ...arena,
      settlementToken: this.resolveSettlementToken(this.stateStore.getArenaConfig(arena.id)?.settlementTokenSymbol),
    }));
  }

  saveArenaSettlementToken(arenaId: number, settlementTokenSymbol: string): void {
    this.stateStore.saveArenaConfig(arenaId, { settlementTokenSymbol });
  }

  private resolveSettlementToken(symbol?: string): TokenInfo {
    return this.tokenRegistry.getBySymbol(symbol ?? "") ?? this.tokenRegistry.getDefaultSettlementToken();
  }
}