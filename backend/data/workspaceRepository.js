// backend/data/workspaceRepository.js
'use strict';

const { getPool } = require('../db');

class WorkspaceRepository {
  constructor(pool = null) {
    this._pool = pool;
  }

  get pool() {
    return this._pool || getPool();
  }

  async create({ name, created_by }, connection = null) {
    const executor = connection || this.pool;
    const cleanName = String(name || 'Default Workspace').trim();

    const [result] = await executor.execute(
      'INSERT INTO workspaces (name, created_by) VALUES (?, ?)',
      [cleanName, created_by || null]
    );

    return {
      id: result.insertId,
      name: cleanName,
      created_by: created_by || null,
    };
  }

  async findById(id) {
    const [rows] = await this.pool.execute(
      'SELECT id, name, created_by, created_at, updated_at FROM workspaces WHERE id = ?',
      [id]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async update(id, { name }) {
    const cleanName = String(name).trim();
    const [result] = await this.pool.execute(
      'UPDATE workspaces SET name = ? WHERE id = ?',
      [cleanName, id]
    );
    return result.affectedRows > 0;
  }

  async deleteById(id) {
    const [result] = await this.pool.execute(
      'DELETE FROM workspaces WHERE id = ?',
      [id]
    );
    return result.affectedRows > 0;
  }

  async createMember({ workspace_id, user_id, role = 'member' }, connection = null) {
    const executor = connection || this.pool;
    const validRole = role === 'owner' ? 'owner' : 'member';

    const [result] = await executor.execute(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
      [workspace_id, user_id, validRole]
    );

    return {
      id: result.insertId,
      workspace_id,
      user_id,
      role: validRole,
    };
  }

  async findMembership(workspaceId, userId) {
    const [rows] = await this.pool.execute(
      'SELECT id, workspace_id, user_id, role, created_at FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [workspaceId, userId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async findMembers(workspaceId) {
    const [rows] = await this.pool.execute(
      `SELECT wm.id AS membership_id, wm.workspace_id, wm.user_id, u.id AS id, wm.role, wm.created_at,
              u.email, u.display_name
       FROM workspace_members wm
       INNER JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ?
       ORDER BY wm.role DESC, wm.created_at ASC`,
      [workspaceId]
    );
    return rows;
  }

  async findUserWorkspaces(userId) {
    const [rows] = await this.pool.execute(
      `SELECT w.id, w.name, w.created_by, w.created_at, wm.role
       FROM workspaces w
       INNER JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = ?
       ORDER BY w.created_at ASC`,
      [userId]
    );
    return rows;
  }

  async removeMember(workspaceId, userId) {
    const [result] = await this.pool.execute(
      'DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [workspaceId, userId]
    );
    return result.affectedRows > 0;
  }

  async countOwners(workspaceId) {
    const [rows] = await this.pool.execute(
      "SELECT COUNT(*) AS total FROM workspace_members WHERE workspace_id = ? AND role = 'owner'",
      [workspaceId]
    );
    return rows.length > 0 ? Number(rows[0].total) : 0;
  }

  /**
   * Transactionally creates a user, their initial workspace, and assigns owner membership.
   */
  async registerUserWithWorkspace({ email, password_hash, display_name, workspace_name = 'My Workspace' }, userRepo = null) {
    const uRepo = userRepo || require('./userRepository').userRepository;
    const pool = this.pool;

    // Check if connection pooling transaction is supported
    if (typeof pool.getConnection === 'function') {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        const user = await uRepo.create({ email, password_hash, display_name }, conn);
        const workspace = await this.create({ name: workspace_name, created_by: user.id }, conn);
        await this.createMember({ workspace_id: workspace.id, user_id: user.id, role: 'owner' }, conn);

        await conn.commit();
        return {
          user,
          workspace,
        };
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    } else {
      // Direct mock/test executor
      const user = await uRepo.create({ email, password_hash, display_name });
      const workspace = await this.create({ name: workspace_name, created_by: user.id });
      await this.createMember({ workspace_id: workspace.id, user_id: user.id, role: 'owner' });
      return {
        user,
        workspace,
      };
    }
  }
}

module.exports = {
  WorkspaceRepository,
  workspaceRepository: new WorkspaceRepository(),
};
