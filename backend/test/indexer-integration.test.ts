import { describe, expect, it } from "vitest";
import { handleBetPlaced, type BetPlacedEvent, type BetRow, type MarketTotals } from "../src/indexer/bet-placed";
import { EventRouter } from "../src/indexer/event-router";
import type { RawContractEvent } from "../src/indexer/event-schema";
import { parseScValTopics } from "../src/indexer/scval-parser";

/** In-memory store that behaves like the transactional PostgreSQL store. */
function memoryStore() {
  const bets = new Map<string, BetRow>();
  const totals = new Map<number, MarketTotals>();
  return {
    bets,
    totals,
    transaction: async <T>(work: (tx: any) => Promise<T>): Promise<T> =>
      work({
        findBet: async (txHash: string, eventIndex: number) => bets.get(`${txHash}:${eventIndex}`),
        insertBet: async (row: BetRow) => {
          bets.set(`${row.txHash}:${row.eventIndex}`, row);
        },
        getMarketTotals: async (marketId: number) => totals.get(marketId),
        setMarketTotals: async (t: MarketTotals) => {
          totals.set(t.marketId, t);
        },
      }),
  };
}

const bet = (eventIndex: number, isYes: boolean, net: bigint): BetPlacedEvent => ({
  txHash: "tx-1",
  eventIndex,
  marketId: 7,
  bettor: "GBETTOR",
  isYes,
  grossAmount: net,
  netAmount: net,
  timestamp: new Date(0),
});

/**
 * Display-name sanitization for referral leaderboards.
 *
 * Enforces the whitelist `^[a-zA-Z0-9_-]{3,20}$` after normalizing Unicode
 * confusables (homoglyphs) to their ASCII equivalents, so lookalike names
 * cannot impersonate admins and HTML/script payloads are rejected.
 */
const DISPLAY_NAME_PATTERN = /^[a-zA-Z0-9_-]{3,20}$/;

// Common Unicode confusables mapped to their ASCII lookalikes.
const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic
  "\u0410": "A", "\u0430": "a", "\u0412": "B", "\u0435": "e", "\u0415": "E",
  "\u041A": "K", "\u043A": "k", "\u041C": "M", "\u041D": "H", "\u041E": "O",
  "\u043E": "o", "\u0420": "P", "\u0440": "p", "\u0421": "C", "\u0441": "c",
  "\u0422": "T", "\u0443": "y", "\u0425": "X", "\u0445": "x", "\u0455": "s",
  "\u0456": "i", "\u0406": "I", "\u0458": "j", "\u0501": "d",
  // Greek
  "\u0391": "A", "\u03B1": "a", "\u0392": "B", "\u03B5": "e", "\u0395": "E",
  "\u0396": "Z", "\u0397": "H", "\u0399": "I", "\u03B9": "i", "\u039A": "K",
  "\u03BA": "k", "\u039C": "M", "\u039D": "N", "\u039F": "O", "\u03BF": "o",
  "\u03A1": "P", "\u03C1": "p", "\u03A4": "T", "\u03C5": "u", "\u03A7": "X",
  "\u03C7": "x", "\u03B6": "z",
  // Fullwidth ASCII
  "\uFF21": "A", "\uFF22": "B", "\uFF23": "C", "\uFF41": "a", "\uFF42": "b",
  "\uFF43": "c", "\uFF10": "0", "\uFF11": "1", "\uFF12": "2",
};

function normalizeHomoglyphs(input: string): string {
  let out = "";
  for (const ch of input.normalize("NFKC")) {
    out += HOMOGLYPH_MAP[ch] ?? ch;
  }
  return out;
}

function sanitizeDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Strip any HTML tags before normalization/validation.
  const stripped = raw.replace(/<[^>]*>/g, "");
  const normalized = normalizeHomoglyphs(stripped);
  if (!DISPLAY_NAME_PATTERN.test(normalized)) return null;
  return normalized;
}

describe("indexer lifecycle", () => {
  it("applies a BetPlaced sequence and matches the expected market totals", async () => {
    const store = memoryStore();
    await handleBetPlaced(store, bet(0, true, 100n));
    await handleBetPlaced(store, bet(1, false, 50n));

    expect(store.totals.get(7)).toEqual({ marketId: 7, totalYes: 100n, totalNo: 50n, betCount: 2 });
  });

  it("is idempotent: feeding the same sequence twice changes nothing", async () => {
    const store = memoryStore();
    const sequence = [bet(0, true, 100n), bet(1, false, 50n)];

    for (const e of sequence) await handleBetPlaced(store, e);
    const once = structuredClone(store.totals.get(7));
    for (const e of sequence) await handleBetPlaced(store, e);

    expect(store.totals.get(7)).toEqual(once);
  });

  it("routes each event to exactly one handler through the router", async () => {
    const seen: string[] = [];
    const router = new EventRouter(() => seen.push("unmapped"));
    router.register("bet_placed", async () => {
      seen.push("bet_placed");
    });

    const event = { topic: "bet_placed" } as RawContractEvent;
    await router.dispatchContractEvent(event);
    await router.dispatchContractEvent({ topic: "unknown" } as RawContractEvent);

    expect(seen).toEqual(["bet_placed", "unmapped"]);
  });
});

describe("ScVal topic parsing", () => {
  it("parses Symbol topics into strings", () => {
    const topics = parseScValTopics([{ type: "symbol", value: "bet_placed" }]);
    expect(topics).toEqual(["bet_placed"]);
  });

  it("parses account and contract Address variants without throwing", () => {
    const account = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const contract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    const topics = parseScValTopics([
      { type: "address", value: account },
      { type: "address", value: contract },
    ]);
    expect(topics).toEqual([account, contract]);
  });

  it("parses muxed addresses into their base account id", () => {
    const muxed = "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const topics = parseScValTopics([{ type: "address", value: muxed }]);
    expect(topics[0]).toBe(muxed);
  });

  it("parses I128 and U64 numeric topics into bigints", () => {
    const topics = parseScValTopics([
      { type: "i128", value: 12345678901234567890n },
      { type: "u64", value: 42n },
    ]);
    expect(topics).toEqual([12345678901234567890n, 42n]);
  });

  it("parses nested Vec topics recursively", () => {
    const topics = parseScValTopics([
      { type: "vec", value: [{ type: "symbol", value: "yes" }, { type: "u64", value: 1n }] },
    ]);
    expect(topics).toEqual([["yes", 1n]]);
  });

  it("logs the raw hex payload and returns null for unexpected shapes", () => {
    const errors: unknown[] = [];
    const topics = parseScValTopics([{ type: "mystery", value: "0xdeadbeef" }], (msg, raw) =>
      errors.push({ msg, raw }),
    );
    expect(topics).toEqual([null]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ raw: "0xdeadbeef" });
  });
});
