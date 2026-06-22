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

  it("self-heal: a holder whose lock dir is replaced by a takeover detects ENOENT on refresh, flips isHolder false, and does not clobber the new holder", () => {
    const now = Date.now();
    const holder = tryAcquire(lockPath, now);
    expect(holder.isHolder).toBe(true);

    // Simulate another instance taking over: tear down this holder's dir and
    // re-create it under a different pid (the new holder).
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath);
    const newHolderMeta = { pid: 444444, startedAt: now };
    writeFileSync(join(lockPath, "meta"), JSON.stringify(newHolderMeta));

    // The original holder's refresh utimes its (now-replaced) dir. The dir EXISTS
    // again (recreated), so utimesSync succeeds — but it must NOT clobber the new
    // holder's meta. Crucially: when the dir is genuinely gone, refresh self-heals.
    // Remove the dir entirely to exercise the ENOENT self-heal path.
    rmSync(lockPath, { recursive: true, force: true });
    holder.refresh();
    expect(holder.isHolder).toBe(false);

    // Now restore the new holder and confirm the self-healed original does not touch it.
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "meta"), JSON.stringify(newHolderMeta));
    holder.refresh(); // no-op now (not holder)
    expect(readMeta(lockPath)).toEqual(newHolderMeta);
  });
});
