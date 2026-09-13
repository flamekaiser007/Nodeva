// Password hashing. Nothing clever here on purpose -- bcrypt with a modern
// cost factor is the boring, correct choice, and boring is what a credential
// store should be.

import bcrypt from 'bcrypt';

// 12 rounds is bcrypt's current recommended floor for new systems (2024+
// guidance) -- enough to keep offline cracking expensive without making
// login noticeably slow. Revisit upward as hardware improves; this constant
// existing in one place is the point.
const SALT_ROUNDS = 12;

export function hashPassword(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length < 8) {
    throw new Error('password must be a string of at least 8 characters');
  }
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}
