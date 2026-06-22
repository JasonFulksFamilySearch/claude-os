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

function holderHandle(lockPath: string, own: LockMeta): ElectionHandle {
  // `own` is THIS handle's identity, stamped into the lock dir's meta at acquire.
  // refresh()/release() verify the on-disk meta STILL matches `own` before acting —
  // detecting loss by IDENTITY, not merely by the dir's existence. A takeover that
  // does rmdir+mkdir between two heartbeats leaves a dir that exists but whose meta
  // is a different identity; existence-only checks (utimesSync succeeds) would miss
  // that and leave a permanent dual-holder. Reading the meta closes it.
  const stillOurs = (): boolean => sameIdentity(readMeta(lockPath), own);
  return {
    isHolder: true,
    refresh(now: number = Date.now()): void {
      if (!this.isHolder) return;
      // Lost the lock if the dir is gone (ENOENT) OR if it now carries a different
      // identity (a takeover re-created it). Either way, self-heal: stop being the
      // holder so the next heartbeat tick tears down maintenance.
      if (!stillOurs()) {
        this.isHolder = false;
        return;
      }
      const t = now / 1000;
      try {
        utimesSync(lockPath, t, t);
      } catch (err) {
        // Race: the dir vanished between the meta read and the utimes. Treat as loss.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.isHolder = false;
          return;
        }
        throw err;
      }
    },
    release(): void {
      if (!this.isHolder) return;
      this.isHolder = false;
      // Only remove the lock if it is STILL ours — never rmdir a lock a successor
      // claimed after a takeover. force:true keeps a concurrent removal benign.
      if (stillOurs()) {
        rmSync(lockPath, { recursive: true, force: true });
      }
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
  return holderHandle(lockPath, meta);
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

// True when the meta did NOT change between two reads — either the same valid
// identity, OR consistently absent/corrupt (both undefined). Used by the takeover
// guard: an unchanged-but-stale lock is reclaimable (including a stably-abandoned
// lock with missing meta); a CHANGED meta means a fresh holder claimed it, so we
// must stand down. (Distinct from sameIdentity, which requires BOTH sides valid —
// correct for "is this still MY lock?" but wrong for "is this stale lock reclaimable?".)
function metaUnchanged(a: LockMeta | undefined, b: LockMeta | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  return sameIdentity(a, b);
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

  // Identity-guarded takeover: re-read meta immediately before the rmdir and take
  // over only if it is UNCHANGED since we observed it stale. "Unchanged" includes
  // a consistently absent/corrupt meta (a stably-abandoned lock — still reclaimable)
  // as well as the same valid identity. We stand down only if the meta CHANGED —
  // i.e. a different holder freshly claimed it in the window — which is the case the
  // guard exists to protect. (Using sameIdentity() alone would wrongly refuse to
  // reclaim a stale lock whose meta is missing/corrupt, deadlocking maintenance.)
  const current = readMeta(lockPath);
  if (!metaUnchanged(observed, current)) return nonHolderHandle();

  // Remove the abandoned lock dir (and its inner meta) so the atomic acquire
  // below can re-create it. force:true makes a concurrent reaper's prior
  // removal (ENOENT) benign rather than throwing.
  rmSync(lockPath, { recursive: true, force: true });

  // Re-attempt the atomic acquire. EEXIST → a concurrent reaper won the
  // takeover race; stand down rather than fight it.
  return tryAcquire(lockPath, now);
}
