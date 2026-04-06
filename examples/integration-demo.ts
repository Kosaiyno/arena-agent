import { ArenaAgentClient } from "../sdk/src/index.js";

const apiBase = process.env.ARENA_AGENT_API_BASE ?? "http://localhost:4000";

const client = new ArenaAgentClient(apiBase);

async function main() {
  const created = await client.createArena({
    entryFeeWei: "50000",
    durationSeconds: 3600,
    settlementTokenSymbol: "USDC",
    title: "Debug Sprint Challenge",
    game: "Debugging",
    metric: "bugs fixed",
  });

  const arenaId = created.arena.id;
  console.log("Created arena", arenaId, created.meta);

  await client.submitScore(arenaId, "0x849d9293A49004B6f166a413d238bbF15803Ef25", 7);
  await client.submitScore(arenaId, "0x0B6Cbf0129100a613BF07AF93bDEe907D1e907DA", 9);

  const leaderboard = await client.getLeaderboard(arenaId);
  console.log("Leaderboard", leaderboard.leaderboard);

  const activity = await client.getActivityFeed({
    limit: 5,
    leaderboardArenaId: arenaId,
  });
  console.log("Activity", activity);

  const operatorReply = await client.chatWithOperator({
    prompt: `who is leading in arena ${arenaId}`,
  });
  console.log("Agent says:", operatorReply.reply);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});