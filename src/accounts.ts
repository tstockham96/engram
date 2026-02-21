import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';

// ============================================================
// Account Management for Engram Hosted
// ============================================================

export type Plan = 'free' | 'growth' | 'pro' | 'enterprise';

export interface Account {
  id: string;
  email: string;
  apiKey: string;
  plan: Plan;
  createdAt: string;
  memoriesStored: number;
  recallsThisMonth: number;
  consolidationsThisMonth: number;
  usageResetAt: string;
}

export const PLAN_LIMITS: Record<Plan, { memories: number; recalls: number; consolidations: number; agents: number }> = {
  free:       { memories: 1000,  recalls: 500,    consolidations: 5,   agents: 1 },
  growth:     { memories: 25000, recalls: 10000,  consolidations: 30,  agents: 5 },
  pro:        { memories: -1,    recalls: -1,     consolidations: -1,  agents: -1 },
  enterprise: { memories: -1,    recalls: -1,     consolidations: -1,  agents: -1 },
};

export type UsageType = 'memory' | 'recall' | 'consolidation';

export class AccountStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        api_key TEXT UNIQUE NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        created_at TEXT NOT NULL,
        memories_stored INTEGER NOT NULL DEFAULT 0,
        recalls_this_month INTEGER NOT NULL DEFAULT 0,
        consolidations_this_month INTEGER NOT NULL DEFAULT 0,
        usage_reset_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_accounts_api_key ON accounts(api_key);
    `);
  }

  generateApiKey(): string {
    return 'eng_live_' + randomBytes(16).toString('hex');
  }

  private nextResetDate(): string {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return next.toISOString();
  }

  createAccount(email: string, plan: Plan = 'free'): Account {
    const id = randomUUID();
    const apiKey = this.generateApiKey();
    const now = new Date().toISOString();
    const usageResetAt = this.nextResetDate();

    this.db.prepare(`
      INSERT INTO accounts (id, email, api_key, plan, created_at, memories_stored, recalls_this_month, consolidations_this_month, usage_reset_at)
      VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)
    `).run(id, email, apiKey, plan, now, usageResetAt);

    return { id, email, apiKey, plan, createdAt: now, memoriesStored: 0, recallsThisMonth: 0, consolidationsThisMonth: 0, usageResetAt };
  }

  getAccountByKey(apiKey: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE api_key = ?').get(apiKey) as any;
    if (!row) return null;

    // Auto-reset monthly counters if past reset date
    if (new Date(row.usage_reset_at) <= new Date()) {
      const newReset = this.nextResetDate();
      this.db.prepare('UPDATE accounts SET recalls_this_month = 0, consolidations_this_month = 0, usage_reset_at = ? WHERE id = ?')
        .run(newReset, row.id);
      row.recalls_this_month = 0;
      row.consolidations_this_month = 0;
      row.usage_reset_at = newReset;
    }

    return this.rowToAccount(row);
  }

  getAccountById(id: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToAccount(row);
  }

  listAccounts(): Account[] {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all() as any[];
    return rows.map(r => this.rowToAccount(r));
  }

  trackUsage(accountId: string, type: UsageType): void {
    switch (type) {
      case 'memory':
        this.db.prepare('UPDATE accounts SET memories_stored = memories_stored + 1 WHERE id = ?').run(accountId);
        break;
      case 'recall':
        this.db.prepare('UPDATE accounts SET recalls_this_month = recalls_this_month + 1 WHERE id = ?').run(accountId);
        break;
      case 'consolidation':
        this.db.prepare('UPDATE accounts SET consolidations_this_month = consolidations_this_month + 1 WHERE id = ?').run(accountId);
        break;
    }
  }

  decrementMemories(accountId: string): void {
    this.db.prepare('UPDATE accounts SET memories_stored = MAX(0, memories_stored - 1) WHERE id = ?').run(accountId);
  }

  checkLimit(account: Account, type: UsageType): { allowed: boolean; limit: number; used: number; resetAt: string } {
    const limits = PLAN_LIMITS[account.plan];
    switch (type) {
      case 'memory': {
        const limit = limits.memories;
        return { allowed: limit === -1 || account.memoriesStored < limit, limit, used: account.memoriesStored, resetAt: account.usageResetAt };
      }
      case 'recall': {
        const limit = limits.recalls;
        return { allowed: limit === -1 || account.recallsThisMonth < limit, limit, used: account.recallsThisMonth, resetAt: account.usageResetAt };
      }
      case 'consolidation': {
        const limit = limits.consolidations;
        return { allowed: limit === -1 || account.consolidationsThisMonth < limit, limit, used: account.consolidationsThisMonth, resetAt: account.usageResetAt };
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private rowToAccount(row: any): Account {
    return {
      id: row.id,
      email: row.email,
      apiKey: row.api_key,
      plan: row.plan,
      createdAt: row.created_at,
      memoriesStored: row.memories_stored,
      recallsThisMonth: row.recalls_this_month,
      consolidationsThisMonth: row.consolidations_this_month,
      usageResetAt: row.usage_reset_at,
    };
  }
}
