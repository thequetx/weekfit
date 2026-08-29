// Config constants that `src/lib/` actually imports.
//
// Ported from week-dashboard/src/config.ts — deliberately not a verbatim
// copy of that file. Everything else there (ICS_LOCAL_URL, SKELETON_URL,
// AMBIENT_REFRESH_MS, the vault-path comment) is Electron/vault/ICS-URL
// wiring that no file under src/lib actually imports (verified with
// `grep -n "from '\.\./config'" src/lib/*.ts`, which only turns up
// `grid.ts` importing `GRID`). Only GRID is reproduced here.

// Week-grid geometry.
export const GRID = {
  startHour: 5, // first hour row shown
  endHour: 24, // last hour row shown (exclusive-ish)
  pxPerHour: 46,
} as const;
