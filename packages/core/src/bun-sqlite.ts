import { Database, type Statement } from "bun:sqlite";
import { mkdir, open as openFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";

/**
 * Pi Durable's portable SQLite facade on Bun's built-in SQLite. Every Kintsugi SQLite file uses this library, so one
 * process never mixes SQLite builds (and their POSIX locks) on the same file.
 */
export type BunSqliteMode = "read-write" | "read-only";
export type BunSqliteOptions = {
  readonly mode?: BunSqliteMode;
  /** SQLite waits this long for a competing lock. */
  readonly busyTimeoutMs?: number;
  /** WAL pages that trigger an automatic checkpoint. SQLite's default is 1,000. */
  readonly walAutoCheckpointPages?: number;
  /** Periodic PASSIVE checkpoints; zero disables the timer for one-shot import jobs. */
  readonly checkpointIntervalMs?: number;
};

/** Runs operations in call order; an asynchronous one (a transaction) holds the queue until it settles. */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  run<T>(operation: () => T): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    try {return Promise.resolve(operation());} catch (error) {return Promise.reject(error);}
  }
  runAsync<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    this.pending++;
    // Publish the barrier first, so calls the operation makes synchronously wait behind it.
    const barrier = Promise.withResolvers<void>();
    this.tail = barrier.promise;
    let started: Promise<T>;
    try {started = operation();} catch (error) {started = Promise.reject(error);}
    return started.finally(() => {this.pending--;barrier.resolve();});
  }
  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    this.pending++;
    const settled = this.tail.then(operation).finally(() => {this.pending--;});
    this.tail = settled.then(() => {}, () => {});
    return settled;
  }
}

/** Prepared statements per connection, by SQL text; the least recently used are finalised beyond the limit. */
const statementLimit = 256;
abstract class BunSqliteExecutor implements SqliteExecutor {
  constructor(protected readonly database: Database, protected readonly statements: Map<string, Statement>) {}
  exec(sql: string) {return this.operation(() => {this.database.exec(sql);});}
  run(sql: string, ...params: SqliteValue[]) {return this.operation(() => {this.statement(sql).run(...params);});}
  runCounted(sql: string, ...params: SqliteValue[]) {return this.operation(() => this.statement(sql).run(...params).changes);}
  get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.operation(() => {
      // SAFETY: callers supply the SQL row shape; Bun returns plain objects, with null for no row.
      return (this.statement(sql).get(...params) ?? undefined) as T | undefined;
    });
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.operation(() => {
      // SAFETY: callers supply the SQL row shape, as required by the Chord executor contract.
      return this.statement(sql).all(...params) as T[];
    });
  }
  protected abstract operation<T>(operation: () => T): Promise<T>;
  private statement(sql: string) {
    let statement = this.statements.get(sql);
    if (statement) {
      this.statements.delete(sql);this.statements.set(sql, statement);
      return statement;
    }
    statement = this.database.prepare(sql);
    this.statements.set(sql, statement);
    if (this.statements.size > statementLimit) {
      const [oldest, evicted] = this.statements.entries().next().value!;
      this.statements.delete(oldest);evicted.finalize();
    }
    return statement;
  }
}
class BunSqliteTransaction extends BunSqliteExecutor {
  constructor(database: Database, statements: Map<string, Statement>, private readonly scope: { active: boolean }) {super(database, statements);}
  protected async operation<T>(operation: () => T) {
    if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
    return operation();
  }
}
/** Best-effort WAL truncation must not block the event loop waiting for another connection's reader. */
export function truncateBunSqliteWal(database: Database) {
  const statement = database.prepare<{timeout:number},[]>("PRAGMA busy_timeout");
  let timeout:number;
  try {timeout=statement.get()!.timeout;} finally {statement.finalize();}
  database.exec("PRAGMA busy_timeout=0");
  try {database.exec("PRAGMA wal_checkpoint(TRUNCATE)");} finally {database.exec(`PRAGMA busy_timeout=${timeout}`);}
}
export class BunSqliteDatabase extends BunSqliteExecutor implements SqliteDatabase {
  private readonly queue = new SerialQueue();
  private closed = false;
  private failure: AggregateError | undefined;
  private readonly checkpointTimer: ReturnType<typeof setInterval> | undefined;
  constructor(database: Database, private readonly mode: BunSqliteMode = "read-write", checkpointIntervalMs = 30_000) {
    super(database, new Map());
    if (mode === "read-write" && checkpointIntervalMs > 0) {
      let checkpointing = false;
      this.checkpointTimer = setInterval(() => {
        if (checkpointing) return;
        checkpointing = true;
        void this.checkpoint().catch(error => console.warn("Could not checkpoint the Agent database", error)).finally(() => {checkpointing = false;});
      }, checkpointIntervalMs);
      this.checkpointTimer.unref();
    }
  }
  /** Synchronous derived-store work shares the transaction queue. Never retain the connection. An accidental asynchronous callback also holds the queue until it settles. */
  withSync<T>(callback: (database: Database) => T): Promise<T> {
    return this.queue.runAsync(async () => {this.assertOpen();return callback(this.database);});
  }
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.queue.runAsync(async () => {
      this.assertOpen();
      // A writer takes the write lock at once; a read-only connection reads one snapshot.
      this.database.exec(this.mode === "read-only" ? "BEGIN" : "BEGIN IMMEDIATE");
      const scope = { active: true };
      try {
        const result = await callback(new BunSqliteTransaction(this.database, this.statements, scope));
        scope.active = false;
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        scope.active = false;
        try {this.database.exec("ROLLBACK");} catch (rollback) {
          this.failure = new AggregateError([error, rollback], "SQLite transaction failed and rollback failed");
          throw this.failure;
        }
        throw error;
      }
    });
  }
  /** A passive checkpoint never waits for readers or writers; it copies what it can and returns. */
  checkpoint() {return this.queue.run(() => {if (!this.closed && this.mode === "read-write") this.database.exec("PRAGMA wal_checkpoint(PASSIVE)");});}
  close() {
    return this.queue.run(() => {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.checkpointTimer);
      for (const statement of this.statements.values()) statement.finalize();
      this.statements.clear();
      try {if (this.mode === "read-write") truncateBunSqliteWal(this.database);}
      finally {this.database.close();}
    });
  }
  private assertOpen() {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("SQLite database is closed");
  }
  protected operation<T>(operation: () => T) {return this.queue.run(() => {this.assertOpen();return operation();});}
}

/**
 * WAL durability: `synchronous=FULL` syncs the write-ahead log at every commit, so a committed transaction survives
 * power loss or a host crash when the filesystem honours fsync, as the fsynced JSONL journal did. Checkpoints copy the log into the database in the
 * background; `journal_size_limit` truncates the log after them.
 */
export async function openBunSqliteDatabase(path: string, options: BunSqliteOptions = {}) {
  if (options.mode === "read-only") {
    const database = new Database(path, { readonly: true, strict: true });
    database.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5000}`);
    return new BunSqliteDatabase(database, "read-only");
  }
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Set the mode before SQLite creates its WAL and shared-memory files, which inherit it.
    await (await openFile(path, "a", 0o600)).close();await chmod(path, 0o600);
  }
  const database = new Database(path, { create: true, strict: true });
  try {
    database.exec(`PRAGMA busy_timeout=${options.busyTimeoutMs ?? 5000}`);
    if (path !== ":memory:" && database.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get()?.journal_mode !== "wal") throw new Error("SQLite did not enable WAL");
    database.exec(`PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=${options.walAutoCheckpointPages ?? 1000}; PRAGMA journal_size_limit=${64 * 1024 * 1024};`);
    return new BunSqliteDatabase(database, "read-write", options.checkpointIntervalMs);
  } catch (error) {
    database.close();
    throw error;
  }
}
