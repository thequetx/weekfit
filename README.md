# Weekfit

**You have eleven hours of work and a week with holes in it. Press one button and see where it fits.**

Weekfit takes the tasks you already have, the hours you're actually available, and the
things already in your week — and proposes where the work goes. You accept what you like,
drag what you don't, and it writes plain text back into your notes.

> ⚠️ **Screenshot goes here.** Not yet taken — see [Status](#status).

---

## It works with the tasks you already have. No new syntax required.

This is the part most planners get wrong. Every comparable plugin needs you to annotate
your tasks *before* it can do anything, which means a migration before you find out
whether you like it.

Weekfit doesn't. A plain line works on day one:

```markdown
- [ ] Book dentist
```

It gets a size from a **duration default for its `#tag`**, or a global fallback if it
hasn't got one. Nothing to migrate, nothing to learn, and the rail tells you the
difference between a size you wrote and a size Weekfit guessed.

If you *do* annotate, Weekfit reads the [Obsidian Tasks](https://publish.obsidian.md/tasks/)
standard in **both** flavours — emoji and Dataview inline fields — plus a `~90m` duration
extension:

```markdown
- [ ] Edit the Tuesday VOD ~90m 📅 2026-09-04 🔼 #content
- [ ] Write newsletter [est:: 45m] [due:: 2026-09-03] [priority:: high]
```

All of it is optional. All of it is read, and almost none of it is written.

## Plan with us. View it wherever you like.

Weekfit writes **Day Planner format** — the same `HH:MM - HH:MM` lines the
[Day Planner](https://github.com/ivan-lednev/obsidian-day-planner) plugin already renders:

```markdown
- [ ] 09:00 - 10:30 Fix badge alpha ⏳ 2026-09-04
```

So there is nothing to switch. If you use Day Planner, keep using it — Weekfit fills in
the timeline you're already looking at. If you use Tasks, keep using it — Weekfit reads
its syntax rather than replacing it. If you stop using Weekfit tomorrow, your plan is
still sitting in your notes in a format three other tools understand.

**Your plan is a file, not a service.**

## What it does that others don't

| | Weekfit |
|---|---|
| **Schedules for you** — into free slots, not just drag-and-drop | ✅ |
| **Availability windows** — *when could this kind of work happen* | ✅ |
| **Recurring commitments** drawn behind the week | ✅ |
| **Capacity line** — `6.5h committed / 14h free`, red when over | ✅ |
| **Duration defaults per `#tag`** — works on an un-annotated vault | ✅ |
| Google Calendar sync | ❌ deliberately — see below |

## How it works

1. **Set your availability windows** in Settings — *when* work could happen (e.g.
   weekdays 09:00–17:00). Without at least one, there's nowhere to fit anything.
2. **Add your recurring commitments** — the gym, a stream, a standing meeting. These are
   drawn behind the week and treated as busy.
3. **Set duration defaults by tag**, so untagged and unestimated tasks still get a size.
4. Open the week view and press **Fit this week**.
5. You get **ghosts** — proposals, not commitments. Accept one, accept all, dismiss, or
   drag one to a different slot first. Nothing is written until you accept.
6. Accepting writes the time range onto the task's own line. **Nothing else is written.**

Tasks come from your weekly note's `## Tasks` section, your daily notes, and any
`- [ ]` line tagged `#thisweek` anywhere in the folders you point it at.

### Where your notes live

Weekfit defers to the **Periodic Notes** plugin when you have it installed, and to core
Daily Notes after that, rather than inventing a second note-location setting for you to
keep in sync. You can override it.

## Commands

| Command | What it does |
|---|---|
| `Open week view` | Opens the week |
| `Fit this week` | Proposes placements for everything unscheduled |
| `Toggle gap candidates` | Shows the free slots the engine can see |
| `Refresh week` | Re-reads the vault |

No hotkeys are claimed — bind your own in Settings → Hotkeys.

## What it deliberately doesn't do

- **No Google Calendar.** A plugin shipping one OAuth client ID to thousands of installs
  is a different legal posture from a personal app, and it's exactly what Google's
  verification exists to police. Dropping it removes the verification burden, the
  "unverified app" screen and the 100-user cap in one decision. A read-only ICS URL is the
  likely first step if calendar support is wanted.
- **No AI.** Not in this version, and everything here works with every model switched off.
- **No account, no server, no telemetry.** It reads and writes files in your vault.
- **No task format of its own.** It reads the Obsidian Tasks standard and writes a time
  range and a scheduled date — both standard, both readable by other plugins and by you.

## Status

**Phases 0–2 of the build are complete**: the planning engine, the vault adapter, the week
view, and "Fit this week" with its write path. 546 tests pass — unit, component, and an
end-to-end pass that runs the real read → fit → write pipeline against real markdown
files on disk and asserts the resulting bytes.

⚠️ **Not yet released, and not yet verified inside a running Obsidian.** A green test
suite is not evidence that a view renders — until someone has loaded this in the app and
looked at it, treat "it works" as unproven. No screenshot exists yet for the same reason.

## Development

```bash
npm install
```

| Script | |
|---|---|
| `npm run dev` | esbuild watch |
| `npm test` | vitest |
| `npm run build` | typecheck + production bundle |
| `npm run deploy` | copy the build into a local test vault |

`npm run deploy` targets a scratch vault and **refuses to write to any path containing
`quetx`**, so it can't be pointed at the author's real vault by accident. Override the
target with `WEEKFIT_VAULT`.

`src/lib/` is a **byte-for-byte port** of a proven planning engine and is checked against
its source on every phase gate. Treat it as vendored: don't edit it in place.

## Licence

MIT — see [LICENSE](LICENSE).
