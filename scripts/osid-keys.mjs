import { ensureKeys } from './keys.mjs';

// Existing V1 identities/private files remain untouched. These wallets isolate V2 rehearsals.
const addresses = ensureKeys(['provider', 'osidbuyer', 'osidattacker']);
console.log(JSON.stringify({ provider: addresses.provider, buyer: addresses.osidbuyer, attacker: addresses.osidattacker }, null, 2));
