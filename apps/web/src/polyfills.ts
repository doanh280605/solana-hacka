import { Buffer } from 'buffer';

// Some legacy Solana dependencies still reference the global in browser builds.
const scope = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
scope.Buffer ??= Buffer;
