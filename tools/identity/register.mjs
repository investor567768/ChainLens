// ERC-8004 registration for Celo mainnet.
//   node register.mjs            -> DRY RUN. Sends nothing. Needs only a public address.
//   node register.mjs --send     -> real transaction. Needs a key file. Asks you to type REGISTER.
//
// Env (all optional except the ones noted):
//   AGENT_ADDRESS   public address that will own the identity (needed for dry run)
//   AGENT_URI       link to the agent card JSON (https://, ipfs://)
//   KEY_FILE        path to a text file holding the private key (only for --send)
//   CELO_RPC        default https://forno.celo.org
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { createPublicClient, createWalletClient, http, encodeFunctionData, concat,
         parseEventLogs, formatEther, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { toDataSuffix, verifyTx } from '@celo/attribution-tags';

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const ENTRY_TAG = 'celo_0124372f0dc2';
const ABI = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'register', stateMutability: 'nonpayable',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'event', name: 'Registered',
    inputs: [{ name: 'agentId', type: 'uint256', indexed: true },
             { name: 'agentURI', type: 'string', indexed: false },
             { name: 'owner', type: 'address', indexed: true }] },
];

const send = process.argv.includes('--send');
const uri = process.env.AGENT_URI || '';   // empty = register without a link; add it later with setAgentURI
const rpc = process.env.CELO_RPC || 'https://forno.celo.org';
const client = createPublicClient({ chain: celo, transport: http(rpc) });

let account = null, address = process.env.AGENT_ADDRESS;
if (send) {
  if (!process.env.KEY_FILE) { console.error('Set KEY_FILE to the key file path for --send.'); process.exit(1); }
  const raw = readFileSync(process.env.KEY_FILE, 'utf8').trim();
  account = privateKeyToAccount(raw.startsWith('0x') ? raw : '0x' + raw);
  address = account.address;
}
if (!isAddress(address || '')) { console.error('Set AGENT_ADDRESS to a valid 0x address.'); process.exit(1); }

const tag = toDataSuffix(ENTRY_TAG);
const data = concat([encodeFunctionData({ abi: ABI, functionName: 'register', args: uri ? [uri] : [] }), tag]);

const chainId = await client.getChainId();
if (chainId !== 42220) { console.error('Not Celo mainnet (got ' + chainId + '). Stopping.'); process.exit(1); }
const code = await client.getCode({ address: REGISTRY });
if (!code || code === '0x') { console.error('No contract at the registry address. Stopping.'); process.exit(1); }

const balance = await client.getBalance({ address });
console.log('Owner address :', address);
console.log('CELO balance  :', formatEther(balance));
console.log('Agent card URI:', uri || '(none yet, will be added later)');
console.log('Tag           :', ENTRY_TAG);

// Dry run: ask the node to execute the exact tagged transaction without sending it.
let gas;
try {
  await client.call({ account: address, to: REGISTRY, data });
  gas = await client.estimateGas({ account: address, to: REGISTRY, data });
  const price = await client.getGasPrice();
  console.log('Dry run       : OK (the contract accepts this tagged call)');
  console.log('Estimated gas :', gas.toString());
  console.log('Estimated cost:', formatEther(gas * price), 'CELO');
  if (balance < gas * price) console.log('WARNING       : balance is below the estimated cost. Add a little CELO first.');
} catch (e) {
  console.error('Dry run FAILED:', e.shortMessage || e.message);
  process.exit(1);
}

if (!send) { console.log('\nNothing was sent. This was a dry run.'); process.exit(0); }

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ans = await rl.question('\nThis sends a real transaction from ' + address + '. Type REGISTER to continue: ');
rl.close();
if (ans.trim() !== 'REGISTER') { console.log('Cancelled. Nothing sent.'); process.exit(0); }

const wallet = createWalletClient({ account, chain: celo, transport: http(rpc) });
const hash = await wallet.sendTransaction({ to: REGISTRY, data });
console.log('Sent:', hash, '\nWaiting for confirmation...');
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') { console.error('Transaction failed on chain:', hash); process.exit(1); }
const ev = parseEventLogs({ abi: ABI, eventName: 'Registered', logs: receipt.logs })[0];
console.log('\nRegistered. agentId =', ev ? ev.args.agentId.toString() : '(not found, check the explorer)');
const tagCheck = await verifyTx({ client, hash });
console.log('Tag on chain  :', tagCheck ? JSON.stringify(tagCheck.codes) : 'NOT FOUND');
console.log('Explorer      : https://celoscan.io/tx/' + hash);
