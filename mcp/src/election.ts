import {
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Heartbeat cadence and staleness window. The holder refreshes the lock-dir
// mtime every HEARTBEAT_REFRESH_MS; a lock is considered abandoned once its
// mtime is older than STALENESS_MULTIPLE heartbeats — long enough that a single
// missed tick (GC pause, brief suspend) does not trigger a takeover.
export const HEARTBEAT_REFRESH_MS = 60_000;
export const STALENESS_MULTIPLE = 3;

export interface ElectionHandle {
  // Mutable: flips to false if this holder loses its lock (see refresh).
  isHolder: boolean;
  // Holder: bump the lock-dir mtime to `now`. If the dir was removed out from
  // under us by a takeover (ENOENT), we LOST the lock — self-heal by flipping
  // isHolder to false. No-op when not the holder.
  refresh(now?: number): void;
  // Holder: remove the lock dir so a successor can claim it. No-op otherwise.
  release(): void;
}

interface LockMeta {
  pid: number;
  startedAt: number;
}

/**
 * The writer-lock directory, a sibling of memory.db under the data root. The
 * `.d` suffix marks it as a directory lock (mkdir-based mutex), distinct from
 * the memory.db file itself.
 */
export function defaultLockPath(): string {
  return join(homedir(), ".claude-data", "memory.db.writer.lock.d");
}

function metaPathFor(lockPath: string): string {
  return join(lockPath, "meta");
}

function holderHandle(lockPath: string): ElectionHandle {
  return {
    isHolder: true,
    refresh(now: number = Date.now()): void {
      if (!this.isHolder) return;
      const t = now / 1000;
      try {
        utimesSync(lockPath, t, t);
      } catch (err) {
        // ENOENT: the lock dir was removed by a takeover — we no longer hold it.
        // Self-heal so the next heartbeat tick stops running maintenance,
        // bounding the two-holder window to <= one refresh interval.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.isHolder = false;
          return;
        }
        throw err;
      }
    },
    release(): void {
      if (!this.isHolder) return;
      // Remove meta + dir in one shot; force so a partially-removed lock is benign.
      rmSync(lockPath, { recursive: true, force: true });
      this.isHolder = false;
    },
  };
}

function nonHolderHandle(): ElectionHandle {
  return {
    isHolder: false,
    refresh(): void {
      /* not the holder — nothing to refresh */
    },
    release(): void {
      /* not the holder — nothing to release */
    },
  };
}

/**
 * Atomic test-and-set: mkdir the lock dir NON-recursively (recursive:true would
 * return silently instead of throwing EEXIST, destroying the single-winner
 * guarantee this design rests on). On success we own the lock and stamp our
 * identity into the inner meta file; on EEXIST another instance holds it.
 */
export function tryAcquire(lockPath: string, now: number): ElectionHandle {
  try {
    mkdirSync(lockPath); // NON-recursive on purpose — see note above.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return nonHolderHandle();
    }
    throw err;
  }
  const meta: LockMeta = { pid: process.pid, startedAt: now };
  writeFileSync(metaPathFor(lockPath), JSON.stringify(meta));
  return holderHandle(lockPath);
}

/**
 * True when the lock's heartbeat (its dir mtime) is older than
 * STALENESS_MULTIPLE refresh intervals — i.e. the holder has stopped (or never
 * started) refreshing and the lock is abandoned.
 */
export function isStale(lockPath: string, now: number): boolean {
  const mtimeMs = statSync(lockPath).mtimeMs;
  return mtimeMs < now - STALENESS_MULTIPLE * HEARTBEAT_REFRESH_MS;
}

function readMeta(lockPath: string): LockMeta | undefined {
  try {
    return JSON.parse(readFileSync(metaPathFor(lockPath), "utf8")) as LockMeta;
  } catch {
    // Missing/corrupt meta — treat as no known identity.
    return undefined;
  }
}

function sameIdentity(a: LockMeta | undefined, b: LockMeta | undefined): boolean {
  return !!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * Full election: acquire if free; if held-and-stale, take over with an
 * identity-guarded rmdir; otherwise stand down as a non-holder.
 *
 * `beforeRmdir` is a test-injection seam (mirrors the injectable paths in
 * migrate/cutover): it fires in the window between the staleness read and the
 * rmdir so a test can deterministically race the lock to "fresh" and prove the
 * identity guard declines to clobber. Production passes nothing.
 */
export function elect(
  lockPath: string,
  now: number,
  // yagni: single-purpose test seam; a generic hook registry isn't warranted
  // until a second injection point appears.
  beforeRmdir?: () => void,
): ElectionHandle {
  const acquired = tryAcquire(lockPath, now);
  if (acquired.isHolder) return acquired;

  // Held by someone. Take over only if it is demonstrably abandoned.
  let stale: boolean;
  let observed: LockMeta | undefined;
  try {
    observed = readMeta(lockPath);
    stale = isStale(lockPath, now);
  } catch (err) {
    // The lock vanished between the EEXIST and our stat — retry the acquire.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return tryAcquire(lockPath, now);
    }
    throw err;
  }
  if (!stale) return nonHolderHandle();

  beforeRmdir?.();

  // Identity-guarded takeover: re-read meta immediately before the rmdir and
  // only remove the lock if it STILL belongs to the stale identity we observed.
  // If a new holder claimed it in the meantime (different identity), stand down.
  const current = readMeta(lockPath);
  if (!sameIdentity(current, observed)) return nonHolderHandle();

  // Remove the abandoned lock dir (and its inner meta) so the atomic acquire
  // below can re-create it. force:true makes a concurrent reaper's prior
  // removal (ENOENT) benign rather than throwing.
  rmSync(lockPath, { recursive: true, force: true });

  // Re-attempt the atomic acquire. EEXIST → a concurrent reaper won the
  // takeover race; stand down rather than fight it.
  return tryAcquire(lockPath, now);
}
