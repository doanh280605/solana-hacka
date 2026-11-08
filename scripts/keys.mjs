import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes) {
  let value = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let result = '';
  while (value > 0n) { result = alphabet[Number(value % 58n)] + result; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return result;
}
export function ensureKeys(roles = ['deployer', 'program', 'mint', 'merchant', 'buyer', 'attacker', 'provider', 'osidbuyer', 'osidattacker']) {
  const directory = resolve(root, '.local/keys');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const addressFile = resolve(root, '.local/addresses.json');
  const addresses = existsSync(addressFile) ? JSON.parse(readFileSync(addressFile, 'utf8')) : {};
  for (const role of roles) {
    if (!/^[a-z]+$/.test(role)) throw new Error('Invalid disposable key role');
    const path = resolve(directory, `${role}.json`);
    if (!existsSync(path)) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
      const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
      writeFileSync(path, JSON.stringify([...seed, ...pub]) + '\n', { mode: 0o600, flag: 'wx' });
    }
    const secret = Buffer.from(JSON.parse(readFileSync(path, 'utf8')));
    if (secret.length !== 64) throw new Error(`Invalid disposable key file: ${role}`);
    const privateKey = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), secret.subarray(0, 32)]),
      type: 'pkcs8', format: 'der',
    });
    const publicBytes = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
    if (!publicBytes.equals(secret.subarray(32))) throw new Error(`Mismatched disposable key: ${role}`);
    addresses[role] = base58(publicBytes);
  }
  writeFileSync(resolve(root, '.local/addresses.json'), JSON.stringify(addresses, null, 2) + '\n');
  return addresses;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(ensureKeys(), null, 2));
  console.log('Disposable keys created/reused in ignored .local/keys. Public addresses only above.');
}
