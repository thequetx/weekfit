First release.

**You have eleven hours of work and a week with holes in it. Press one button and see where it fits.**

Weekfit reads the tasks you already have, the hours you're actually available, and what's already in your week — then proposes where the work goes. You accept what you like, drag what you don't, and it writes plain text back into your notes.

## What it does

- **Fit this week** — schedules unscheduled work into your free slots. Nothing else in the directory does this; the others all make you place the work yourself.
- **Availability windows** — *when could this kind of work happen*, matched against a task's `#tag`.
- **Recurring commitments** drawn behind the week and treated as busy.
- **A capacity line** — `6.5h committed / 14h free`, red when the week doesn't fit.
- **Duration defaults per `#tag`**, so a plain `- [ ] Book dentist` gets a size and the plugin works on a vault that's never heard of it. No annotation, no migration.
- **Balanced or soonest-first** placement, because a plan that puts ten hours on Monday isn't one you'd look at.
- **Splitting** a task across several sittings, **replan** for what didn't happen, a **weekly review** with roll-forward, a **backlog**, and quick **capture**.
- Drag, edge-resize, and drag back onto the rail to take something off the week.
- **Undo** — one command puts back the last thing Weekfit wrote, including a roll-forward spanning two notes.

## It works with the tasks you already have

No new syntax required. A plain checkbox line works on day one. If you do annotate, Weekfit reads the [Obsidian Tasks](https://publish.obsidian.md/tasks/) standard in **both** flavours — emoji and Dataview inline fields — plus a `~90m` duration extension. All of it optional.

## Plan with us, view it wherever you like

Weekfit writes **Day Planner format** — the same `HH:MM - HH:MM` lines the Day Planner plugin already renders. Nothing has to be switched. If you stop using Weekfit tomorrow, your plan is still sitting in your notes in a format other tools understand.

**Your plan is a file, not a service.**

## How your notes are treated

One module writes. It re-reads the target line before changing it and **refuses rather than guesses** if the line moved. Only the target line changes — no reformatting, no whitespace churn, and your line endings survive. Nothing proprietary is written.

## Please know before installing

- **Desktop only for this release.** Everything is pointer-based and should work on touch, but nothing has been tested on a phone or tablet, so the manifest says so rather than claiming support that hasn't been earned.
- **Undo is one command, not a guarantee.** `Weekfit: Undo last Weekfit change` puts back the last thing it did, across every file that change touched — but it refuses if you've edited the note since, and it only lasts for the session. Writes still land in your notes immediately, so it's worth a scratch vault for the first hour.
- No Google Calendar, no AI, no account, no telemetry.

815 tests, including an end-to-end pass that runs the real read → fit → write pipeline against real files on disk and asserts the resulting bytes. MIT.
