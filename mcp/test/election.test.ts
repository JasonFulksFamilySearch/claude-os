import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultLockPath,
  tryAcquire,
  isStale,
  elect,
  HEARTBEAT_REFRESH_MS,
  STALENESS_MULTIPLE,
} from "../src/election.js";

let workDir: string;
let lockPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "claude-os-election-"));
  lockPath = join(workDir, "memory.db.writer.lock.d");
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function readMeta(p: string): { pid: number; startedAt: number } {
  return JSON.parse(readFileSync(join(p, "meta"), "utf8"));
}

describe("defaultLockPath", () => {
  it("is a sibling of memory.db ending in the writer-lock dir name", () => {
    expect(defaultLockPath()).toMatch(/\.claude-data[\\/]memory\.db\.writer\.lock\.d$/);
  });
});

describe("acquire", () => {
  it("first tryAcquire becomes the holder and writes meta with this pid", () => {
    const now = Date.now();
    const handle = tryAcquire(lockPath, now);
    expect(handle.isHolder).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(readMeta(lockPath).pid).toBe(process.pid);
  });

  it("a second tryAcquire returns a non-holder and does not disturb the holder's meta", () => {
    const now = Date.now();
    const first = tryAcquire(lockPath, now);
    expect(first.isHolder).toBe(true);
    const metaBefore = readMeta(lockPath);

    const second = tryAcquire(lockPath, now);
    expect(second.isHolder).toBe(false);
    // The first holder's meta is untouched.
    expect(readMeta(lockPath)).toEqual(metaBefore);
  });
});

describe("one holder (EEXIST contract — pins recursive:false)", () => {
  it("two sequential acquires elect exactly one holder", () => {
    const now = Date.now();
    const a = tryAcquire(lockPath, now);
    const b = tryAcquire(lockPath, now);
    const holders = [a, b].filter((h) => h.isHolder);
    expect(holders.length).toBe(1);
  });

  it("mkdirSync on the same dir twice throws EEXIST (guards against a future recursive:true refactor)", () => {
    mkdirSync(lockPath);
    expect(() => mkdirSync(lockPath)).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
  });
});

describe("takeover", () => {
  it("isStale is true when the lock-dir mtime is older than STALENESS_MULTIPLE refresh intervals, false when fresh", () => {
    const now = Date.now();
    tryAcquire(lockPath, now);

    // Fresh: just acquired.
    expect(isStale(lockPath, now)).toBe(false);

    // Age the lock dir well past the staleness threshold.
    const stale = (now - (STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS + 1000)) / 1000;
    utimesSync(lockPath, stale, stale);
    expect(isStale(lockPath, now)).toBe(true);
  });

  it("elect takes over a stale lock and the new meta carries the current pid", () => {
    const past = Date.now() - 10 * 60 * 1000;
    // Seed a stale lock owned by a foreign pid.
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "meta"), JSON.stringify({ pid: 999999, startedAt: past }));
    const stale = (Date.now() - (STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS + 1000)) / 1000;
    utimesSync(lockPath, stale, stale);

    const handle = elect(lockPath, Date.now());
    expect(handle.isHolder).toBe(true);
    expect(readMeta(lockPath).pid).toBe(process.pid);
  });

  it("identity-guarded: if the lock goes fresh (different pid) between staleness-read and rmdir, elect does not clobber it", () => {
    // Seed a stale lock owned by a foreign pid.
    const past = Date.now() - 10 * 60 * 1000;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "meta"), JSON.stringify({ pid: 111111, startedAt: past }));
    const staleTime = (Date.now() - (STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS + 1000)) / 1000;
    utimesSync(lockPath, staleTime, staleTime);

    // Inject the race: between the staleness observation and the rmdir, a NEW
    // holder claims the lock (different identity + fresh mtime). The identity
    // guard must re-read meta, see it changed, and decline to clobber.
    const freshMeta = { pid: 222222, startedAt: Date.now() };
    const handle = elect(lockPath, Date.now(), () => {
      writeFileSync(join(lockPath, "meta"), JSON.stringify(freshMeta));
      const fresh = Date.now() / 1000;
      utimesSync(lockPath, fresh, fresh);
    });

    expect(handle.isHolder).toBe(false);
    // The new holder's meta is intact — we did not clobber it.
    expect(readMeta(lockPath)).toEqual(freshMeta);
  });

  it("reclaims a stale lock with MISSING/corrupt meta — the identity guard must not deadlock maintenance on an abandoned lock whose meta is unreadable", () => {
    // A stale lock dir with NO readable meta (e.g. a crash mid-write, or a corrupt
    // file). The takeover guard keys on "did the meta CHANGE since I saw it stale?",
    // not "is the meta a valid identity?" — a consistently-absent meta is unchanged,
    // so a stable, stale, abandoned lock stays reclaimable. (The prior sameIdentity
    // guard returned false on undefined and would have left maintenance stuck.)
    mkdirSync(lockPath);
    // No meta file written. (election.ts's INTERNAL readMeta swallows the read error
    // and returns undefined; this test's own readMeta helper below would THROW on a
    // missing file — so it is only called AFTER takeover, when a meta exists.)
    const staleTime = (Date.now() - (STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS + 1000)) / 1000;
    utimesSync(lockPath, staleTime, staleTime);

    const handle = elect(lockPath, Date.now());
    expect(handle.isHolder).toBe(true);            // reclaimed, not deadlocked
    expect(readMeta(lockPath).pid).toBe(process.pid); // meta now exists (we took over)
  });

  it("does NOT reclaim a stale-but-corrupt lock if a fresh holder writes valid meta in the race window (the change is what blocks takeover)", () => {
    // Complement of the above: the meta CHANGED (absent → a fresh valid identity)
    // between the staleness read and the rmdir, so the guard must decline.
    mkdirSync(lockPath);
    const staleTime = (Date.now() - (STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS + 1000)) / 1000;
    utimesSync(lockPath, staleTime, staleTime);

    const freshMeta = { pid: 777777, startedAt: Date.now() };
    const handle = elect(lockPath, Date.now(), () => {
      writeFileSync(join(lockPath, "meta"), JSON.stringify(freshMeta));
      const fresh = Date.now() / 1000;
      utimesSync(lockPath, fresh, fresh);
    });

    expect(handle.isHolder).toBe(false);
    expect(readMeta(lockPath)).toEqual(freshMeta);
  });

  it("concurrent takeover: two elect calls against the same stale lock yield exactly one holder", () => {
    const past = Date.now() - 10 * 60 * 1000;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "meta"), JSON.stringify({ pid: 333333, startedAt: past }));
    const staleTime = (Date.now() - (STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS + 1000)) / 1000;
    utimesSync(lockPath, staleTime, staleTime);

    const a = elect(lockPath, Date.now());
    const b = elect(lockPath, Date.now());
    expect([a, b].filter((h) => h.isHolder).length).toBe(1);
  });

  it("self-heal (ENOENT path): a holder whose lock dir is deleted detects ENOENT on refresh and flips isHolder false", () => {
    const now = Date.now();
    const holder = tryAcquire(lockPath, now);
    expect(holder.isHolder).toBe(true);

    rmSync(lockPath, { recursive: true, force: true });
    holder.refresh();
    expect(holder.isHolder).toBe(false);
  });

  it("self-heal (realistic takeover): a holder whose dir is rmdir+mkdir'd under a NEW identity between heartbeats detects the identity mismatch — even though utimesSync would succeed — and does not become a permanent dual-holder", () => {
    const now = Date.now();
    const holder = tryAcquire(lockPath, now);
    expect(holder.isHolder).toBe(true);

    // Realistic takeover: another instance does rmdir+mkdir QUICKLY, so by the time
    // the original holder's heartbeat runs, the dir EXISTS again (utimesSync would
    // succeed) but carries a DIFFERENT identity. Existence-only detection (the old
    // bug) would leave isHolder=true forever — a permanent two-holder state.
    const newHolderMeta = { pid: 444444, startedAt: now + 1 };
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "meta"), JSON.stringify(newHolderMeta));

    holder.refresh();
    // The fix: refresh reads the meta, sees it is no longer ours, and self-heals.
    expect(holder.isHolder).toBe(false);
    // And it must NOT have clobbered the new holder's meta (utimesSync would have
    // bumped mtime but never touches meta; the identity check short-circuits first).
    expect(readMeta(lockPath)).toEqual(newHolderMeta);
  });

  it("release() does not clobber a successor's lock: a holder that already lost the lock to a takeover must not rmdir the new holder's dir", () => {
    const now = Date.now();
    const holder = tryAcquire(lockPath, now);
    expect(holder.isHolder).toBe(true);

    // A successor takes over (dir re-created under a new identity).
    const newHolderMeta = { pid: 555555, startedAt: now + 1 };
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "meta"), JSON.stringify(newHolderMeta));

    // The stale handle calls release() (e.g. on its own shutdown). It must verify
    // ownership by meta content and decline to remove a lock that is no longer ours.
    holder.release();
    expect(holder.isHolder).toBe(false);
    expect(existsSync(lockPath)).toBe(true);              // successor's dir survives
    expect(readMeta(lockPath)).toEqual(newHolderMeta);    // successor's meta intact
  });
});
