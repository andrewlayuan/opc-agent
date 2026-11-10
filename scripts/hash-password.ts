import readline from 'node:readline';
import { hashPassword } from '../packages/core/auth.ts';

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    process.stdout.write(prompt);
    out._writeToOutput = () => {};
    rl.question('', (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a);
    });
  });
}

const pw = await readPassword('输入新密码（不回显）：');
if (pw.length < 8) {
  console.error('密码至少 8 位');
  process.exit(1);
}
if (process.stdin.isTTY) {
  const again = await readPassword('再次输入：');
  if (again !== pw) {
    console.error('两次输入不一致');
    process.exit(1);
  }
}
console.log(hashPassword(pw));
