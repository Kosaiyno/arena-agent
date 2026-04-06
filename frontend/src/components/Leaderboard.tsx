import { LeaderboardEntry } from "../lib/api";

type LeaderboardProps = {
  entries: LeaderboardEntry[];
  metric?: string;
  game?: string;
};

export function Leaderboard({ entries, metric, game }: LeaderboardProps) {
  const scoreLabel = metric ? metric.charAt(0).toUpperCase() + metric.slice(1) : "Score";
  const subtitle = game ? `${game} — highest ${metric ?? "score"} wins` : "Highest score wins";
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Leaderboard</h2>
        <span>{subtitle}</span>
      </div>
      <div className="leaderboard-table">
        <div className="leaderboard-row leaderboard-head">
          <span>Rank</span>
          <span>Player</span>
          <span>{scoreLabel}</span>
        </div>
        {entries.length === 0 ? <p className="empty-state">No scores yet.</p> : null}
        {entries.map((entry) => (
          <div className="leaderboard-row" key={entry.user}>
            <span>#{entry.rank}</span>
            <span>{entry.user}</span>
            <span>{entry.score}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
