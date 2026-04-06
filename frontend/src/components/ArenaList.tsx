import { formatEther } from "ethers";
import { Arena } from "../lib/api";

type ArenaListProps = {
  arenas: Arena[];
  selectedArenaId: number | null;
  onSelect: (arenaId: number) => void;
};

function fmtEth(wei: string): string {
  return `${parseFloat(formatEther(wei)).toFixed(4)} ${"OKB"}`;
}

export function ArenaList({ arenas, selectedArenaId, onSelect }: ArenaListProps) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Arenas</h2>
        <span>{arenas.length} total</span>
      </div>
      <div className="arena-grid">
        {arenas.length === 0 && <p className="empty-state">No arenas yet. Create one or ask the operator.</p>}
        {arenas.map((arena) => (
          <button
            key={arena.id}
            className={arena.id === selectedArenaId ? "arena-card active" : "arena-card"}
            onClick={() => onSelect(arena.id)}
            type="button"
          >
            <div className="arena-card-head">
              <strong>Arena #{arena.id}</strong>
              <span className={arena.finalized ? "tag-status tag-status--done" : arena.closed ? "tag-status tag-status--closed" : "tag-status tag-status--open"}>
                {arena.finalized ? "Finalized" : arena.closed ? "Closed" : "Open"}
              </span>
            </div>
            <div className="arena-card-body">
              <p>Entry: {fmtEth(arena.entryFeeWei)}</p>
              <p>Pool: {fmtEth(arena.totalPoolWei)}</p>
              <p>{arena.players.length} player{arena.players.length !== 1 ? "s" : ""}</p>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
