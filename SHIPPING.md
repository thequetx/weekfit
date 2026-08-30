# Shipping Weekfit

> **Weekfit is published.** 0.1.1 is live at
> <https://community.obsidian.md/plugins/weekfit>, built from
> <https://github.com/thequetx/weekfit>. Sections 0–3 are the first-time steps
> and are kept as a record of what was actually done, including two places the
> documented process was wrong. **To ship an update, you only need
> "Shipping a new version" directly below.**

## Shipping a new version

```bash
cd C:/Users/tyler/weekfit
npm test
# bump "version" in manifest.json and package.json, and add the new
# version to versions.json mapped to its minimum Obsidian version
npm run release
git add -A && git commit -m "Weekfit 0.1.2"
git push origin master
git tag -a 0.1.2 -m "Weekfit 0.1.2" && git push origin 0.1.2
gh release create 0.1.2 release/main.js release/manifest.json release/styles.css \
  --title "0.1.2" --notes-file RELEASE-NOTES.md
```

Then nothing. The directory reads `manifest.json` at the HEAD of the default
branch and picks the release up on its own — there is no resubmission step.

Three things that will bite:

- **The tag never takes a `v`.** Obsidian matches it against `manifest.json`'s
  `version` character for character.
- **`versions.json` must gain the new version**, mapped to the lowest Obsidian
  it actually runs on. Getting this wrong points people at a build that will
  not load for them.
- **`npm run release` is not optional.** See section 2 for what happened the
  one time the staged artifacts were assumed fresh.

---

Everything below is the first release, kept for the record.

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

**This is a web form now, not a pull request.** An earlier version of this
document said to fork `obsidianmd/obsidian-releases` and add an entry to
`community-plugins.json`. That was the process for years and it is no longer
open: pull requests *and* issues are both disabled on that repository, so the
attempt fails with a permissions error that reads like a problem with your
account. It isn't — an unauthenticated request gets the same 404, while other
`obsidianmd` repos answer normally. That file is still the directory's data
store; it just isn't edited by hand any more.

The current process, per
<https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin>:

1. Go to <https://community.obsidian.md> and sign in with your **Obsidian**
   account.
2. Link your **GitHub** account to your profile. This is how the directory
   proves you own the repo you are submitting.
3. Add the plugin through the directory's own form.

The directory reads `manifest.json` **at the HEAD of the repo's default
branch**, and requires a published release whose tag matches that manifest's
`version` exactly, carrying `main.js`, `manifest.json` and (optionally)
`styles.css`. Steps 1 and 2 above already satisfy all of that — nothing needs
re-doing at submission time.

Expect review latency measured in weeks, and expect a reviewer to comment.
That is normal, not a rejection.

> Check this section against the docs before every submission. The process
> changed once with no redirect and no error message that named the real
> cause; assume it can change again.

## 4. The automated checks

Submitting runs a linter over the source and reports Errors, Warnings and
Recommendations. **Errors fail the submission.** The first attempt failed on a
list of findings that had never been looked for, because this project has no
linter of its own — so read that report carefully; it is currently the only
place these rules get run.

**You cannot reproduce it locally yet, and it is worth knowing why** rather
than rediscovering it: the check is `eslint` + `eslint-plugin-obsidianmd`,
which depends on `typescript-eslint`, which **refuses to load against
TypeScript 7** ("typescript-eslint does not support TS 7.0"). This project is
on TS 7.0.2. Dropping to TS 6 makes `eslint` run but breaks
`@testing-library/react`'s type exports in the test files, so `npm run build`
fails instead — a worse trade. Revisit when typescript-eslint ships TS 7
support (typescript-eslint#10940).

If you do try again: install with plain `npm install`, never
`--legacy-peer-deps`. The latter un-hoists `@testing-library/dom` and every
component test stops type-checking, which looks like a TypeScript problem and
is not one. `git checkout package.json package-lock.json && npm ci` puts it
back.

## 5. Known things a reviewer may raise

Better to have answers ready than to be surprised:

- **`src/lib/` is vendored** — a byte-for-byte port of an engine from another
  project of yours, checked against its source on every commit. Say so if
  asked; it is your own code, not a bundled dependency.
- **`isDesktopOnly: true`** because touch is untested, not because anything
  needs Node or Electron. Easy to loosen later.
- **Settings do not implement `getSettingDefinitions()`**, the declarative
  API added in 1.13.0, so they will not appear in Obsidian's settings search.
  A warning, not an error; adopting it is a full rewrite of `SettingsTab`.

## 6. After it lands

- The listing is your one shot at the pitch. The first line people read is the
  `description` in `manifest.json` and the directory entry — they must match.
- Watch the repo issues. The first real bug from a stranger is the most
  valuable thing you will get.
