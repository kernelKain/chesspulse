// What: replays SAN moves into the FEN before and after each one.
// Why: the engine scores positions, and an illegal move must stop the line instead of inventing a board.
// Removed: a SAN-shaped but illegal move would be sent to Stockfish as a real position.
import { Chess } from 'chess.js';

export interface MovePosition {
  san: string;
  fenBefore: string;
  fenAfter?: string;
  illegal: boolean;
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
    positions.push({ san, fenBefore, fenAfter: played.after, illegal: false });
  }
  return positions;
}
