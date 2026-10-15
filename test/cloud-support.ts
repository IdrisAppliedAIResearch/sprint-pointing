import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Database, Environment, Statement } from '../hosting/site/worker/types.ts';

export function testDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../hosting/site/drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));

  class Query implements Statement {
    sql: string;
    values: SQLInputValue[];
    constructor(sql: string, values: SQLInputValue[] = []) {
      this.sql = sql;
      this.values = values;
    }
    bind(...values: SQLInputValue[]) { return new Query(this.sql, values); }
    async first<T>() { return (sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null; }
    async all<T>() { return { results: sqlite.prepare(this.sql).all(...this.values) as T[] }; }
    async run() { return { meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) } }; }
  }

  const binding: Database = {
    prepare: (sql) => new Query(sql),
    withSession: () => binding,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => {
          const query = statement as Query;
          return { meta: { changes: Number(sqlite.prepare(query.sql).run(...query.values).changes) } };
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { binding, sqlite, close: () => sqlite.close() };
}

export function testEnvironment(db: Database): Environment {
  return { DB: db, JIRA_URL: 'https://jira.example.test', JIRA_BOARD_ID: '9001', JIRA_POINTS_FIELD: 'customfield_10106', JIRA_PROJECT_KEY: 'FAKE', SPRINT_SESSION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
}
