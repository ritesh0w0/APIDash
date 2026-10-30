// backend/data/userRepository.js
'use strict';

const { getPool } = require('../db');

class UserRepository {
  constructor(pool = null) {
    this._pool = pool;
  }

  get pool() {
    return this._pool || getPool();
  }

  canonicalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  async create({ email, password_hash, display_name }, connection = null) {
    const executor = connection || this.pool;
    const cleanEmail = this.canonicalizeEmail(email);
    const cleanName = String(display_name || cleanEmail.split('@')[0]).trim();

    const [result] = await executor.execute(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      [cleanEmail, password_hash, cleanName]
    );

    return {
      id: result.insertId,
      email: cleanEmail,
      display_name: cleanName,
    };
  }

  async findByEmail(email) {
    const cleanEmail = this.canonicalizeEmail(email);
    const [rows] = await this.pool.execute(
      'SELECT id, email, password_hash, display_name, created_at, updated_at FROM users WHERE email = ?',
      [cleanEmail]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async findById(id) {
    const [rows] = await this.pool.execute(
      'SELECT id, email, display_name, created_at, updated_at FROM users WHERE id = ?',
      [id]
    );
    return rows.length > 0 ? rows[0] : null;
  }
}

module.exports = {
  UserRepository,
  userRepository: new UserRepository(),
};
