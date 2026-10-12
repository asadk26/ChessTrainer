// Stockfish in a Node child process — used by tests and scripts/analyze-sample.ts.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UciEngine } from '../src/engine/uci.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function findStockfishScript(): string | null {
  const dir = join(root, 'node_modules', 'stockfish', 'src');
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).find((n) => /lite-single-[0-9a-f]+\.js$/.test(n));
  return f ? join(dir, f) : null;
}

export function createNodeEngine(): UciEngine {
  const script = findStockfishScript();
  if (!script) throw new Error('Stockfish not installed (npm install)');
  const proc = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'ignore'] });
  const engine = new UciEngine('Stockfish 17.1 lite (node)', (cmd) => proc.stdin.write(cmd + '\n'), () => proc.kill());
  let buf = '';
  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    const idx = buf.lastIndexOf('\n');
    if (idx >= 0) {
      engine.receive(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });
  return engine;
}
