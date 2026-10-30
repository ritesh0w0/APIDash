// backend/services/passwordService.js
'use strict';

const argon2 = require('argon2');
const { ValidationError } = require('../middleware/errors');

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB recommended by OWASP
  timeCost: 2,
  parallelism: 1,
};

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Hashes a plaintext password using Argon2id.
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
async function hashPassword(password) {
  if (typeof password !== 'string') {
    throw new ValidationError('Password must be a string');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must not exceed ${MAX_PASSWORD_LENGTH} characters`);
  }

  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verifies a plaintext password against an Argon2id hash.
 *
 * @param {string} hash
 * @param {string} plainPassword
 * @returns {Promise<boolean>}
 */
async function verifyPassword(hash, plainPassword) {
  if (!hash || !plainPassword || typeof hash !== 'string' || typeof plainPassword !== 'string') {
    return false;
  }
  try {
    return await argon2.verify(hash, plainPassword);
  } catch (_err) {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
};
