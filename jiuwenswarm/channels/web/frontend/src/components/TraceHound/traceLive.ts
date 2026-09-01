/**
 * Live-update decision logic for the trajectory panel (pure, tested).
 */

/** How often the trajectory panel checks the session history file's mtime. */
export const POLL_INTERVAL_MS = 5000;

/** Decide whether a new mtime warrants re-fetching turns. */
export function shouldRefetch(prevMtime: number | null, nextMtime: number | null): boolean {
  if (nextMtime === null) return false; // no history file — never poll-fetch
  if (prevMtime === null) return true; // first sight of an existing file
  return nextMtime > prevMtime; // only forward changes
}
