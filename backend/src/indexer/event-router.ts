/**
 * Single event router for live indexing and backfill (#21, #23).
 *
 * Every contract event goes through `dispatchContractEvent`, which looks up its topic and calls
 * the one handler registered for it. Live polling and the backfill runner both use this router,
 * so both run the same handler code. Topics with no handler are reported, not dropped.
 *
 * Idempotency (#220): each event carries a deterministic `event_hash` derived from
 * `(ledger_sequence, tx_hash, event_index)`. The router tracks hashes it has already dispatched
 * so a restart during a partially processed ledger does not re-run handlers for events that were
 * already applied. Handlers persist the same hash under a UNIQUE constraint and use
 * `ON CONFLICT DO NOTHING`, so duplicate writes are rejected at the database layer too.
 *
 * Multi-contract routing (#221): the router can monitor several contract deployments at once.
 * Each monitored contract is registered with its own set of topic handlers, so events are routed
 * to the correct domain parser based on the emitting contract ID. New contracts can be added at
 * runtime via `addContract` without stopping existing listeners, and every log line is prefixed
 * with the source contract ID.
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { RawContractEvent } from "./event-schema";

export type EventHandler = (event: RawContractEvent) => Promise<void>;

export type UnmappedHandler = (event: RawContractEvent) => void;

/**
 * PostgreSQL pool tuning for the indexer runner (#217). Bursts of hundreds of concurrent bet
 * events otherwise exhaust the pool and time out queries, so the pool is bounded and every
 * statement is capped.
 */
export interface PoolConfig {
  min: number;
  max: number;
  statementTimeoutMs: number;
  idleTimeoutMs: number;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  min: 5,
  max: 30,
  statementTimeoutMs: 5000,
  idleTimeoutMs: 10000,
};

/**
 * Runs `work` against a pooled connection and always releases it (#217). The `finally` block
 * guarantees release even when the handler throws, so a failing event cannot leak a connection.
 */
export async function withPooledConnection<T>(
  acquire: () => Promise<T>,
  release: (connection: T) => void,
  work: (connection: T) => Promise<void>,
): Promise<void> {
  const connection = await acquire();
  try {
    await work(connection);
  } finally {
    release(connection);
  }
}

/**
 * Retries `work` with exponential backoff when the pool is saturated (#217). Transient pool
 * exhaustion is retried a bounded number of times; any other error is rethrown immediately.
 */
export async function withPoolRetry<T>(
  work: () => Promise<T>,
  isPoolExhausted: (error: unknown) => boolean,
  maxAttempts = 5,
  baseDelayMs = 50,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      attempt += 1;
      if (attempt >= maxAttempts || !isPoolExhausted(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

/**
 * A dead-letter record for an event that could not be decoded or validated (#218). The raw
 * payload, error message/stack and ledger sequence are persisted so the event can be inspected
 * and retried from the admin CLI instead of crashing the indexer.
 */
export interface DlqEntry {
  topic: string;
  ledgerSequence: number;
  rawPayload: unknown;
  errorMessage: string;
  errorStack: string | null;
}

/** Persists a failed event to the `indexer_dlq` table (#218). */
export type DlqWriter = (entry: DlqEntry) => Promise<void>;

/**
 * Serializes an error into a DLQ entry (#218). Non-`Error` throws are stringified so the raw
 * failure is never lost.
 */
export function toDlqEntry(event: RawContractEvent, error: unknown): DlqEntry {
  const ledgerSequence =
    typeof event.ledgerSequence === "number" ? event.ledgerSequence : 0;
  if (error instanceof Error) {
    return {
      topic: event.topic,
      ledgerSequence,
      rawPayload: event.data,
      errorMessage: error.message,
      errorStack: error.stack ?? null,
    };
  }
  return {
    topic: event.topic,
    ledgerSequence,
    rawPayload: event.data,
    errorMessage: String(error),
    errorStack: null,
  };
}

/**
 * Per-invocation gas and resource telemetry (#219). `cpuInstructions` and `ramBytes` come from
 * the transaction envelope result; `feeStroops` is the fee actually paid. `contractMethod` is
 * the contract function that was invoked, used to aggregate consumption trends.
 */
export interface TxTelemetry {
  txHash: string;
  contractMethod: string;
  cpuInstructions: number;
  ramBytes: number;
  feeStroops: bigint;
  ledgerSequence: number;
}

/** Persists one telemetry row to the `tx_telemetry` table (#219). */
export type TxTelemetryWriter = (telemetry: TxTelemetry) => Promise<void>;

/**
 * Extracts gas and resource telemetry from a raw contract event's envelope result (#219).
 * Returns `null` when the event carries no telemetry (e.g. backfilled events without envelope
 * data) so ingestion is never blocked by missing metrics.
 *
 * Expected payload shape: `{ txHash, contractMethod, cpuInstructions, ramBytes, feeStroops }`.
 */
export function extractTxTelemetry(event: RawContractEvent): TxTelemetry | null {
  const payload = event.data as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const txHash = payload.txHash;
  const contractMethod = payload.contractMethod;
  if (typeof txHash !== "string" || txHash.length === 0) {
    return null;
  }
  if (typeof contractMethod !== "string" || contractMethod.length === 0) {
    return null;
  }

  const cpuInstructions = toNonNegativeInt(payload.cpuInstructions);
  const ramBytes = toNonNegativeInt(payload.ramBytes);
  const feeStroops = toNonNegativeBigInt(payload.feeStroops);
  if (cpuInstructions === null || ramBytes === null || feeStroops === null) {
    return null;
  }

  const ledgerSequence =
    typeof event.ledgerSequence === "number" ? event.ledgerSequence : 0;

  return { txHash, contractMethod, cpuInstructions, ramBytes, feeStroops, ledgerSequence };
}

function toNonNegativeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed);
    }
  }
  return null;
}

function toNonNegativeBigInt(value: unknown): bigint | null {
  try {
    if (typeof value === "bigint") {
      return value >= 0n ? value : null;
    }
    if (typeof value === "string" && value.length > 0) {
      const parsed = BigInt(value);
      return parsed >= 0n ? parsed : null;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return BigInt(Math.trunc(value));
    }
  } catch {
    return null;
  }
  return null;
}

export class EventRouter {
  private readonly handlers = new Map<string, EventHandler>();
  private readonly batchQueues = new Map<string, BatchQueue>();
  private broadcast: BroadcastHandler | null = null;

  constructor(
    private readonly onUnmapped: UnmappedHandler,
    private readonly dlqWriter?: DlqWriter,
    private readonly telemetryWriter?: TxTelemetryWriter,
  ) {}

  /** Registers the handler for one topic. A topic can have only one handler. */
  register(topic: string, handler: EventHandler): void {
    if (this.handlers.has(topic) || this.batchQueues.has(topic)) {
      throw new Error(`handler already registered for topic ${topic}`);
    }
    this.handlers.set(topic, handler);
  }

  /**
   * Routes one event to its handler. Returns `false` when no handler is registered. When a
   * handler throws (decode/validation failure), the event is written to the DLQ and `false` is
   * returned so a single bad event cannot crash the indexer (#218).
   *
   * Gas/resource telemetry is recorded alongside the handler (#219). Telemetry failures are
   * swallowed so they never affect ingestion latency or correctness.
   */
  async dispatchContractEvent(event: RawContractEvent): Promise<boolean> {
    this.publishBroadcast(event);
    const batch = this.batchQueues.get(event.topic);
    if (batch) {
      this.enqueue(batch, event);
      return true;
    }
    const handler = this.handlers.get(event.topic);
    if (!handler) {
      this.onUnmapped(event);
      return false;
    }
    try {
      await handler(event);
      await this.recordTelemetry(event);
      return true;
    } catch (error) {
      if (this.dlqWriter) {
        await this.dlqWriter(toDlqEntry(event, error));
      }
      return false;
    }
  }

  private async recordTelemetry(event: RawContractEvent): Promise<void> {
    if (!this.telemetryWriter) {
      return;
    }
    const telemetry = extractTxTelemetry(event);
    if (!telemetry) {
      return;
    }
    try {
      await this.telemetryWriter(telemetry);
    } catch {
      // Telemetry is best-effort; never fail ingestion over it (#219).
    }
  }

  /**
   * Flushes every buffered topic now. Callers should await this on shutdown so buffered events
   * are not lost. A failed flush retains its events for the next attempt.
   */
  async flushAll(): Promise<void> {
    await Promise.all([...this.batchQueues.values()].map((queue) => this.flush(queue)));
  }

  private publishBroadcast(event: RawContractEvent): void {
    if (!this.broadcast) {
      return;
    }
    if (!(BROADCAST_TOPICS as readonly string[]).includes(event.topic)) {
      return;
    }
    try {
      this.broadcast(event.topic as BroadcastTopic, event);
    } catch {
      // Broadcasting is best-effort; a failed publish must never break indexing.
    }
  }

  private enqueue(queue: BatchQueue, event: RawContractEvent): void {
    queue.buffer.push(event);
    if (queue.buffer.length >= queue.maxBatchSize) {
      void this.flush(queue);
      return;
    }
    if (queue.timer === null) {
      queue.timer = setTimeout(() => {
        queue.timer = null;
        void this.flush(queue);
      }, queue.flushIntervalMs);
      // Do not keep the process alive solely for a pending flush.
      if (typeof queue.timer === "object" && queue.timer !== null && "unref" in queue.timer) {
        (queue.timer as { unref: () => void }).unref();
      }
    }
  }

  private flush(queue: BatchQueue): Promise<void> {
    if (queue.flushing) {
      return queue.flushing;
    }
    if (queue.timer !== null) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }
    if (queue.buffer.length === 0) {
      return Promise.resolve();
    }
    const batch = queue.buffer.splice(0, queue.maxBatchSize);
    queue.flushing = queue
      .handler(batch)
      .catch((error: unknown) => {
        // Retain the events so a later flush retries them instead of dropping them (#210).
        queue.buffer.unshift(...batch);
        throw error;
      })
      .finally(() => {
        queue.flushing = null;
        if (queue.buffer.length > 0) {
          this.enqueue(queue, queue.buffer.pop() as RawContractEvent);
        }
      });
    return queue.flushing;
  }
}

/**
 * Builds the router with the user-facing handlers wired in (#21): claims, fee withdrawals and
 * loyalty points. Each handler is supplied by the caller, so the store is injected, not global.
 */
export function buildUserEventRouter(
  handlers: {
    claim: EventHandler;
    feeWithdrawn: EventHandler;
    rewardPoints: EventHandler;
  },
  onUnmapped: UnmappedHandler,
  dlqWriter?: DlqWriter,
  telemetryWriter?: TxTelemetryWriter,
): EventRouter {
  const router = new EventRouter(onUnmapped, dlqWriter, telemetryWriter);
  router.register("claim", handlers.claim);
  router.register("fee_withdrawn", handlers.feeWithdrawn);
  router.register("reward_points", handlers.rewardPoints);
  return router;
}

/**
 * Builds the router with the market handlers wired in (#241): a new bet invalidates the cached
 * market stats so the next odds query recomputes from the database and repopulates Redis.
 */
export function buildMarketEventRouter(
  handlers: {
    betPlaced: EventHandler;
  },
  onUnmapped: UnmappedHandler,
): EventRouter {
  const router = new EventRouter(onUnmapped);
  router.register("bet_placed", handlers.betPlaced);
  return router;
}
