# Shipping Weekfit

Everything below is ready. These are the steps that need your account, in order.

## 0. Before anything

- [ ] **Take a screenshot.** The directory listing is mostly a screenshot, and
      the README has a placeholder waiting for one. Open the week view on a
      populated week, press *Fit this week*, and capture the grid with ghosts
      on it — that image is the pitch.
- [ ] Decide the repo name. `weekfit` matches the plugin id, which is the
      convention and the least confusing option.

## 1. Create the repo and push

```bash
cd C:/Users/tyler/weekfit
gh repo create weekfit --public --source=. --remote=origin \
  --description "Press one button and see where the week's work fits."
git push -u origin master
```

Obsidian's submission checklist wants the repo public, MIT-licensed (it is,
`LICENSE`), with `manifest.json` at the root (it is).

## 2. Tag and release

The release must contain **`main.js`, `manifest.json`, `styles.css` as loose
files** — not a zip, not a folder.

`npm run release` type-checks, builds, and stages those three into `release/`,
which is where the upload command below reads them from. **Always run it**,
even when you think you just built. `release/` once sat four hours behind the
working tree, and nothing about `gh release create` would have looked wrong —
the artifacts are opaque, so a stale upload ships silently and the version
number still says 0.1.0. The script also refuses to stage a `main.js` older
than anything in `src/`, so the "forgot to rebuild" half of that mistake
can't happen either.

```bash
cd C:/Users/tyler/weekfit
npm test
npm run release
git tag -a 0.1.0 -m "Weekfit 0.1.0"
git push origin 0.1.0
gh release create 0.1.0 release/main.js release/manifest.json release/styles.css \
  --title "0.1.0" --notes-file RELEASE-NOTES.md
```

The tag is `0.1.0` — **no `v` prefix**. Obsidian matches the tag against
`manifest.json`'s `version` exactly, and a `v` makes it fail.

## 3. Submit to the directory

Fork `obsidianmd/obsidian-releases`, add one entry to the **end** of
`community-plugins.json`:

```json
{
  "id": "weekfit",
  "name": "Weekfit",
  "author": "Tyler Williams",
  "description": "Press one button and see where the week's work fits. Schedules your unscheduled tasks into the gaps between your commitments.",
  "repo": "<your-github-username>/weekfit"
}
```

Open a PR and fill in their template honestly. Expect review latency measured
in weeks, and expect a reviewer to comment — that is normal, not a rejection.

## 4. Known things a reviewer may raise

Better to have answers ready than to be surprised:

- **Two `as any` casts** in `src/data/periodicNotes.ts`, reaching into the
  Periodic Notes and core Daily Notes plugins to read their settings. There is
  no typed API for that; both are wrapped in optional chaining and try/catch.
- **`src/lib/` is vendored** — a byte-for-byte port of an engine from another
  project of yours, checked against its source on every commit. Say so if
  asked; it is your own code, not a bundled dependency.
- **`isDesktopOnly: true`** because touch is untested, not because anything
  needs Node or Electron. Easy to loosen later.

## 5. After it lands

- The listing is your one shot at the pitch. The first line people read is the
  `description` in `manifest.json` and the directory entry — they must match.
- Watch the repo issues. The first real bug from a stranger is the most
  valuable thing you will get.
