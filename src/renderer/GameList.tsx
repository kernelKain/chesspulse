// What: renders the wrapped session game list with ending annotations and exclusion badges.
// Why: AC-09 and AC-21 require aborted/abandoned exclusions to stay visible and long usernames to wrap without ellipsis.
// Removed: games would appear only as narrow timeline bands and 40-character usernames could overflow or truncate.
import type { Report, ReportGame } from '../shared/contracts';
import { endingMark } from '../shared/timeline';

export function GameList({ report }: { report: Report }) {
  if (report.games.length === 0) return null;

  const included = report.games.filter((game) => game.includeInStats).length;
  const aborted = report.games.filter((game) => game.ending === 'aborted').length;
  const abandoned = report.games.filter((game) => game.ending === 'abandoned').length;

  const summaryParts = [
    `${report.games.length} ${report.games.length === 1 ? 'game' : 'games'}`,
    `${included} in accuracy`,
  ];
  if (aborted > 0) summaryParts.push(`${aborted} aborted`);
  if (abandoned > 0) summaryParts.push(`${abandoned} abandoned`);

  return (
    <section className="game-list-section" aria-label="Session games">
      <div className="game-list-header">
        <span className="timeline-title">Games</span>
        <span className="band-note">{summaryParts.join(' · ')}</span>
      </div>
      <ol className="game-list">
        {report.games.map((game) => (
          <GameRow key={game.index} game={game} />
        ))}
      </ol>
    </section>
  );
}

function GameRow({ game }: { game: ReportGame }) {
  const mark = endingMark(game.ending);
  const players =
    game.white || game.black
      ? `${game.white || 'Unknown'} vs ${game.black || 'Unknown'}`
      : 'Players unnamed';
  const moveWord = game.moveCount === 1 ? 'ply' : 'plies';
  const blunderWord = game.blunders === 1 ? 'blunder' : 'blunders';

  return (
    <li className={game.includeInStats ? 'game-row' : 'game-row game-row-excluded'}>
      <div className="game-row-top">
        <span className="game-index">G{game.index + 1}</span>
        <span className="game-players">{players}</span>
        <span className="game-result">{game.result}</span>
      </div>
      <div className="game-row-bottom">
        <span className="game-ending">
          <span aria-hidden="true">{mark.glyph}</span> {mark.label}
        </span>
        {game.timeControl ? <span className="game-detail">{game.timeControl}</span> : null}
        <span className="game-detail">
          {game.moveCount} {moveWord}
        </span>
        {game.includeInStats ? (
          <span className="game-detail">
            {game.blunders} {blunderWord}
          </span>
        ) : (
          <span className="meta-excluded">Excluded from accuracy</span>
        )}
        {!game.aligned ? <span className="meta-excluded">Not placed on timeline</span> : null}
      </div>
    </li>
  );
}
