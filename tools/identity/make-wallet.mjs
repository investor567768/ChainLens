// Creates a NEW wallet. Saves the private key to agent-key.txt. Prints ONLY the public address.
// Never paste the key anywhere. Never commit it. Back it up offline.
import { existsSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const FILE = 'agent-key.txt';
if (existsSync(FILE)) {
  const k = readFileSync(FILE, 'utf8').trim();
  console.log(FILE + ' already exists. Nothing changed.');
  console.log('Address:', privateKeyToAccount(k.startsWith('0x') ? k : '0x' + k).address);
  process.exit(0);
}
const key = generatePrivateKey();
writeFileSync(FILE, key + '\n', { mode: 0o600 });
const gi = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8') : '';
if (!gi.includes(FILE)) appendFileSync('.gitignore', (gi.endsWith('\n') || !gi ? '' : '\n') + FILE + '\n');
console.log('Wallet created. Key saved to ' + FILE + ' (not shown, not shared).');
console.log('Address:', privateKeyToAccount(key).address);
