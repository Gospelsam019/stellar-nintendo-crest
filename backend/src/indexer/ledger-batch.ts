import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';

/**
 * PostgreSQL connection pool for the indexer runner.
 *
 * Tuned for high event burst loads (hundreds of concurrent bet events):
 * - min 5 warm connections to absorb sudden bursts without handshake latency
 * - max 30 connections to bound server-side resource usage
 * - 5000ms statement timeout so runaway queries fail fast instead of
 *   holding a connection and starving the pool
 * - 10000ms idle timeout to reclaim connections after bursts subside
 */
export const pool = new Pool({
  min: 5,
  max: 30,
  idleTimeoutMillis: 10000,
  statement_timeout: 5000,
  query_timeout: 5000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle PostgreSQL client', { error: err.message });
});

const MAX_POOL_RETRIES = 3;
const POOL_RETRY_BASE_DELAY_MS = 100;

function isPoolSaturationError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('too many clients already') ||
    message.includes('remaining connection slots are reserved') ||
    message.includes('Connection terminated')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire a client from the pool, retrying with exponential backoff when the
 * pool is transiently saturated. Throws the last error if all retries fail.
 */
async function acquireClient(): Promise<PoolClient> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_POOL_RETRIES; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      lastError = err;
      if (!isPoolSaturationError(err) || attempt === MAX_POOL_RETRIES) {
        break;
      }
      const backoff = POOL_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn('PostgreSQL pool saturated, retrying connection', {
        attempt: attempt + 1,
        backoffMs: backoff,
      });
      await delay(backoff);
    }
  }
  throw lastError;
}
export interface BatchStoreTx {
  /** Multi-row `INSERT ... ON CONFLICT DO UPDATE` for one table. */
  upsertMany(table: string, rows: Record<string, unknown>[]): Promise<void>;
  /** Atomically records the last fully applied ledger sequence in the checkpoints table. */
  saveCheckpoint(sequence: number): Promise<void>;
}

export interface LedgerBatchEntry {
  eventId: string;
  tokenAddress: string;
  amount: string;
  ledger: number;
  timestamp: Date;
}

/**
 * Tables that are declaratively partitioned by a timestamp column (#252). Writes to these tables
 * must target the parent table so PostgreSQL routes each row to its quarterly partition; the
 * application never names a partition directly.
 */
export const PARTITIONED_TABLES: Readonly<Record<string, string>> = {
  bets: 'placed_at',
};

/**
 * Tables whose rows are locked during a batch write. Concurrent transactions that touch the same
 * rows must acquire those locks in the same order, otherwise PostgreSQL aborts one of them with a
 * deadlock (#254). Rows of these tables are therefore sorted by their lock key before writing.
 */
export const LOCK_ORDER_COLUMNS: Readonly<Record<string, string>> = {
  leaderboard: 'user_address',
};

/**
 * Returns the quarterly partition name for a timestamp, e.g. `bets_2026_q1`. Mirrors the
 * `bets_<year>_q<quarter>` naming used by the partition management routine so the indexer and the
 * provisioning routine agree on boundaries.
 */
export function quarterlyPartitionName(table: string, at: Date): string {
  const year = at.getUTCFullYear();
  const quarter = Math.floor(at.getUTCMonth() / 3) + 1;
  return `${table}_${year}_q${quarter}`;
}

/**
 * Sorts rows of a lock-ordered table by their lock key (ascending) so every transaction locks the
 * shared rows in the same deterministic order. This is what prevents the deadlocks described in
 * #254 when concurrent bet settlements update overlapping leaderboard rows.
 */
function orderForLocking(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const column = LOCK_ORDER_COLUMNS[table];
  if (!column) return rows;
  return [...rows].sort((a, b) => {
    const left = String(a[column] ?? '');
    const right = String(b[column] ?? '');
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Fetches and applies a single missed ledger so the sequence gap can be closed (#215). */
export type LedgerFetcher = (sequence: number) => Promise<void>;

/** Number of retry attempts allowed to resolve a sequence gap before alerting (#215). */
export const MAX_GAP_RETRIES = 3;

/** Dedicated registry so the indexer's metrics can be scraped from `/metrics` (#214). */
export const indexerMetrics = new Registry();

const latestLedger = new Gauge({
  name: 'stellar_indexer_latest_ledger',
  help: 'Sequence number of the latest ledger fully applied by the indexer.',
  registers: [indexerMetrics],
});

const chainTipLedger = new Gauge({
  name: 'stellar_indexer_chain_tip_ledger',
  help: 'Sequence number of the latest ledger known on the Stellar chain tip.',
  registers: [indexerMetrics],
});

const lagLedgers = new Gauge({
  name: 'stellar_indexer_lag_ledgers',
  help: 'Number of ledgers the indexer is behind the chain tip.',
  registers: [indexerMetrics],
});

const ledgerApplyDuration = new Histogram({
  name: 'stellar_indexer_ledger_apply_seconds',
  help: 'Time spent applying one ledger batch, in seconds.',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [indexerMetrics],
});

const eventIngestDuration = new Histogram({
  name: 'stellar_indexer_event_ingest_seconds',
  help: 'Time spent ingesting a contract event, in seconds, per event type.',
  labelNames: ['event_type'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [indexerMetrics],
});

const eventsIngested = new Counter({
  name: 'stellar_indexer_events_ingested_total',
  help: 'Total number of contract events ingested, per event type.',
  labelNames: ['event_type'] as const,
  registers: [indexerMetrics],
});

const sequenceGaps = new Counter({
  name: 'stellar_indexer_sequence_gaps_total',
  help: 'Total number of ledger sequence gaps detected during ingestion.',
  registers: [indexerMetrics],
});

/** Records the chain tip so lag can be computed against the latest applied ledger. */
export function observeChainTip(sequence: number): void {
  chainTipLedger.set(sequence);
  const latest = latestLedger.hashMap['']?.value ?? 0;
  lagLedgers.set(Math.max(0, sequence - latest));
}

/** Records the latest fully applied ledger and refreshes the lag gauge. */
export function observeLatestLedger(sequence: number): void {
  latestLedger.set(sequence);
  const tip = chainTipLedger.hashMap['']?.value ?? 0;
  lagLedgers.set(Math.max(0, tip - sequence));
}

/** Times the ingestion of a single contract event, labelled by its event type. */
export async function timeEventIngest<T>(eventType: string, work: () => Promise<T>): Promise<T> {
  const end = eventIngestDuration.startTimer({ event_type: eventType });
  try {
    const result = await work();
    eventsIngested.inc({ event_type: eventType });
    return result;
  } finally {
    end();
  }
}

/**
 * Ensures `sequence` directly follows `previous`. When a gap is detected, every missed sequence
 * is fetched and applied in order before returning, so state never advances past a hole. If the
 * gap cannot be closed within {@link MAX_GAP_RETRIES} attempts, a critical alert is logged and
 * the error is rethrown so the caller does not advance the checkpoint (#215).
 */
export async function ensureSequenceContinuity(
  previous: number | undefined,
  sequence: number,
  fetchLedger: LedgerFetcher,
): Promise<void> {
  if (previous === undefined || sequence === previous + 1) return;

  if (sequence <= previous) {
    // Re-processing an already applied ledger is harmless; nothing to backfill.
    return;
  }

  sequenceGaps.inc();
  const missed: number[] = [];
  for (let s = previous + 1; s < sequence; s++) missed.push(s);

  console.warn(
    `[indexer] ledger sequence gap detected: expected ${previous + 1}, got ${sequence}; ` +
      `fetching missed sequences ${missed[0]}..${missed[missed.length - 1]}`,
  );

  for (const missedSequence of missed) {
    let lastError: unknown;
    let resolved = false;
    for (let attempt = 1; attempt <= MAX_GAP_RETRIES; attempt++) {
      try {
        await fetchLedger(missedSequence);
        resolved = true;
        break;
      } catch (err) {
        lastError = err;
        console.warn(
          `[indexer] failed to fetch missed ledger ${missedSequence} ` +
            `(attempt ${attempt}/${MAX_GAP_RETRIES}): ${String(err)}`,
        );
      }
    }
    if (!resolved) {
      console.error(
        `[indexer] CRITICAL: unresolved ledger sequence gap at ${missedSequence} ` +
          `after ${MAX_GAP_RETRIES} attempts; refusing to advance checkpoint past ${previous}.`,
        lastError,
      );
      throw new Error(
        `Unresolved ledger sequence gap at ${missedSequence} after ${MAX_GAP_RETRIES} attempts`,
      );
    }
  }
}

/**
 * Writes every event of one ledger in a single transaction. Rows are grouped per table, so each
 * table gets one multi-row statement instead of one statement per event.
 *
 * Partitioned tables are written through their parent table, so partitioning stays transparent to
 * callers and no query changes are required. Lock-ordered tables are sorted by their lock key so
 * concurrent transactions acquire row locks deterministically and cannot deadlock (#254).
 */
export async function persistLedgerBatch(entries: LedgerBatchEntry[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  await store.transaction(async (tx) => {
    for (const [table, rows] of byTable) {
      await tx.upsertMany(table, orderForLocking(table, rows));
    }
  });
}

/**
 * One itemized tax-reporting record (#247). Mirrors the columns required by the export:
 * date, tx hash, type, asset, amount, fee, and net payout, plus a USD historical estimate.
 */
export interface TaxLedgerRecord {
  date: string;
  txHash: string;
  type: string;
  asset: string;
  amount: string;
  fee: string;
  netPayout: string;
  usdValue: string;
}

const CSV_COLUMNS: (keyof TaxLedgerRecord)[] = [
  'date',
  'txHash',
  'type',
  'asset',
  'amount',
  'fee',
  'netPayout',
  'usdValue',
];

/** Escapes a single CSV field per RFC 4180 (quotes doubled, wrapped when needed). */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Streams itemized tax records as CSV or JSON without buffering the full history in memory.
 * Records are pulled lazily from `source` and written one at a time to `sink`, so arbitrarily
 * large histories can be exported with constant memory.
 */
export async function streamTaxExport(
  source: AsyncIterable<TaxLedgerRecord>,
  sink: { write(chunk: string): void | Promise<void> },
  format: 'csv' | 'json',
): Promise<void> {
  if (format === 'csv') {
    await sink.write(CSV_COLUMNS.join(',') + '\n');
    for await (const record of source) {
      const line = CSV_COLUMNS.map((col) => csvField(record[col])).join(',');
      await sink.write(line + '\n');
    }
    return;
  }

  await sink.write('[');
  let first = true;
  for await (const record of source) {
    await sink.write((first ? '' : ',') + JSON.stringify(record));
    first = false;
  }
  await sink.write(']');
}
