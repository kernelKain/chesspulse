// What: renders the wrapped session game list with ending annotations and exclusion badges.
// Why: AC-09 and AC-21 require aborted/abandoned exclusions to stay visible and long usernames to wrap without ellipsis.
// Removed: games would appear only as narrow timeline bands and 40-character usernames could overflow or truncate.
import type { Report, ReportGame } from '../shared/contracts';
import { endingMark } from '../shared/timeline';
import { COPY } from './copy';

export function GameList({ report }: { report: Report }) {
  if (report.games.length === 0) return null;

  const included = report.games.filter((game) => game.includeInStats).length;
  const aborted = report.games.filter((game) => game.ending === 'aborted').length;
  const abandoned = report.games.filter((game) => game.ending === 'abandoned').length;

  const summaryParts = [
    COPY.gamesList.games(report.games.length),
    COPY.gamesList.inAccuracy(included),
  ];
  if (aborted > 0) summaryParts.push(COPY.gamesList.aborted(aborted));
  if (abandoned > 0) summaryParts.push(COPY.gamesList.abandoned(abandoned));

  return (
    <section className="game-list-section" aria-label={COPY.gamesList.label}>
      <div className="game-list-header">
        <span className="timeline-title">{COPY.gamesList.title}</span>
        <span className="band-note">{COPY.gamesList.summary(summaryParts)}</span>
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
      ? `${game.white || COPY.gamesList.unknown} vs ${game.black || COPY.gamesList.unknown}`
      : COPY.gamesList.unnamed;

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
          {COPY.gamesList.ply(game.moveCount)}
        </span>
        {game.includeInStats ? (
          <span className="game-detail">
            {COPY.gamesList.blunder(game.blunders)}
          </span>
        ) : (
          <span className="meta-excluded">{COPY.gamesList.excluded}</span>
        )}
        {!game.aligned ? <span className="meta-excluded">{COPY.gamesList.notPlaced}</span> : null}
      </div>
    </li>
  );
}
