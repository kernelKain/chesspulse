declare module 'stockfish' {
  interface StockfishProcess {
    processCommand(command: string): void;
    terminate?: () => void;
  }

  function stockfish(variant: string, listener: (line: string) => void): StockfishProcess;
  export default stockfish;
}
