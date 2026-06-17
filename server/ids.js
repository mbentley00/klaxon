import { randomBytes, randomUUID } from 'node:crypto';
import { CODE_ALPHABET, ROOM_CODE_LEN } from './config.js';

export function roomCode(len = ROOM_CODE_LEN) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// Secret capability token. Whoever holds it may perform reader/director
// actions. Never derived from anything guessable.
export function secretToken() {
  return randomBytes(24).toString('base64url');
}

export function uuid() {
  return randomUUID();
}
