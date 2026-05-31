import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A minimal D1Database-compatible shim over better-sqlite3.
 * Implements only the subset of the D1 API surface used by src/db.ts.
 */
export interface FakeD1 {
  prepare(sql: string): FakeD1Statement;
  exec(sql: string): { count: number; duration: number };
}

interface FakeD1Statement {
  bind(...params: unknown[]): FakeD1Statement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: object }>;
  run(): Promise<{ success: boolean; meta: object }>;
}

class StatementWrapper implements FakeD1Statement {
  constructor(
    private db: Database.Database,
    private sql: string,
    private boundParams: unknown[] = [],
  ) {}

  bind(...params: unknown[]): FakeD1Statement {
    return new StatementWrapper(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.boundParams as any[]));
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: boolean; meta: object }> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...(this.boundParams as any[])) as T[];
    return { results: rows, success: true, meta: {} };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...(this.boundParams as any[]));
    // Mirror D1's result.meta.changes (rows affected) — used by prunePosts.
    return { success: true, meta: { changes: info.changes } };
  }
}

export function createFakeD1(): FakeD1 {
  const db = new Database(":memory:");
  // Cloudflare D1 enforces foreign key constraints; better-sqlite3 defaults them
  // OFF. Match D1 so the harness catches FK violations (e.g. deleting a
  // watch_target that still has posts referencing it) instead of hiding them.
  db.pragma("foreign_keys = ON");
  const schemaPath = resolve(__dirname, "../../schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  return {
    prepare(sql: string): FakeD1Statement {
      return new StatementWrapper(db, sql);
    },
    exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}
