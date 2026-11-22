// What: replays SAN moves into the FEN before and after each one.
// Why: the engine scores positions, and an illegal move must stop the line instead of inventing a board.
// Removed: a SAN-shaped but illegal move would be sent to Stockfish as a real position.
import { Chess } from 'chess.js';

export interface MovePosition {
  san: string;
  fenBefore: string;
  fenAfter?: string;
  illegal: boolean;
  /** Present when the move ends the game; the position is never sent to the engine. */
  terminalAfter?: 'checkmate' | 'stalemate';
}

export interface IllegalMove {
  moveIndex: number;
  /** Full-move number: the first white move is 1, and each black move shares it. */
  moveNumber: number;
  san: string;
}

export function firstIllegalMove(sans: readonly string[]): IllegalMove | null {
  const positions = positionsFromMoves(sans);
  const moveIndex = positions.findIndex((position) => position.illegal);
  if (moveIndex < 0) return null;
  return {
    moveIndex,
    moveNumber: Math.floor(moveIndex / 2) + 1,
    san: positions[moveIndex]?.san ?? '',
  };
}

export function illegalMoveMessage(gameLabel: number, illegal: IllegalMove): string {
  return `Game ${gameLabel}, move ${illegal.moveNumber} (${illegal.san}) is not legal from this position. Check that the PGN came from chess.com.`;
}

export function terminalAt(fen: string): 'checkmate' | 'stalemate' | null {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return 'checkmate';
  if (chess.isStalemate()) return 'stalemate';
  return null;
}

export function positionsFromMoves(sans: readonly string[]): MovePosition[] {
  const chess = new Chess();
  const positions: MovePosition[] = [];
  for (const san of sans) {
    const fenBefore = chess.fen();
    let played: { after: string } | null = null;
    try {
      played = chess.move(san, { strict: true });
    } catch {
      played = null;
    }
    if (!played) {
      positions.push({ san, fenBefore, illegal: true });
      break;
    }
    let terminalAfter: 'checkmate' | 'stalemate' | undefined;
    if (chess.isCheckmate()) terminalAfter = 'checkmate';
    else if (chess.isStalemate()) terminalAfter = 'stalemate';
    positions.push({
      san,
      fenBefore,
      fenAfter: played.after,
      illegal: false,
      ...(terminalAfter ? { terminalAfter } : {}),
    });
  }
  return positions;
}
