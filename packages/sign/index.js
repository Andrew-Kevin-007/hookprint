/**
 * index.js — public API of @baton/sign.
 * Zero third-party dependencies; node:crypto only. No network.
 */

export { generateIdentity, keyIdOf } from './keys.js';
export { signBundle } from './sign.js';
export { verifyBundle } from './verify.js';
export { canonicalize } from './canonicalize.js';
