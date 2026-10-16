// Download your most recent Chess.com games into one PGN file (public API, no login).
//   node scripts/fetch-pgns.mjs chunkmonkey420 20 > last-20.pgn
//   node scripts/fetch-pgns.mjs chunkmonkey420 20 rapid > last-20-rapid.pgn
// Walks the monthly archives from newest to oldest until it has enough games.
const [user = 'chunkmonkey420', count = '20', timeClass] = process.argv.slice(2);
const n = Number(count);
const headers = { 'user-agent': 'ChessCoach/1.0 (personal chess training app; PGN export script)', accept: 'application/json' };

const get = async (url) => {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
};

const { archives } = await get(`https://api.chess.com/pub/player/${user.toLowerCase()}/games/archives`);
const games = [];
for (const month of [...archives].reverse()) {
  const { games: g } = await get(month);
  const picked = g.filter((x) => x.pgn && x.rules === 'chess' && (!timeClass || x.time_class === timeClass)).sort((a, b) => b.end_time - a.end_time);
  games.push(...picked);
  if (games.length >= n) break;
}
const latest = games.slice(0, n);
process.stdout.write(latest.map((x) => x.pgn.trim()).join('\n\n') + '\n');
console.error(`Wrote ${latest.length} game(s) for ${user}${timeClass ? ` (${timeClass})` : ''}, newest first.`);
