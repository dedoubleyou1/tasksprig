import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import initSqlJs, { type Database } from 'sql.js';

/** SQLite snapshot storage: each committed state is exported through an atomic rename. */
export class StateStore {
  private constructor(private readonly db: Database, private readonly filename?: string) {}

  static async open(filename?: string): Promise<StateStore> {
    const SQL = await initSqlJs();
    const persistentPath = filename && filename !== ':memory:' ? filename : undefined;
    const db = new SQL.Database(persistentPath && existsSync(persistentPath) ? readFileSync(persistentPath) : undefined);
    db.run('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
    return new StateStore(db, persistentPath);
  }

  read<T>(): T | undefined {
    const row = this.db.exec('SELECT data FROM app_state WHERE id = 1')[0]?.values[0]?.[0];
    return typeof row === 'string' ? JSON.parse(row) as T : undefined;
  }

  write(state: unknown): void {
    this.db.run('INSERT OR REPLACE INTO app_state (id, data) VALUES (1, ?)', [JSON.stringify(state)]);
    if (this.filename) {
      mkdirSync(dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.tmp`;
      writeFileSync(temporary, this.db.export(), { mode: 0o600 });
      renameSync(temporary, this.filename);
    }
  }

  close(): void {
    this.db.close();
  }
}
