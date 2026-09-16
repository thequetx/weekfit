## 0.2.3

**A hand-drag now lands exactly where you drop it.** Releasing a block near — but not on — a free gap used to pull it onto that gap's edge instead of the spot the drag preview had just shown you. That's gone: moving a ghost or a scheduled block always lands where you release it, and the conflict marker (⚠) is the only thing that tells you a spot overlaps something — the same way it already worked for resizing.

## 0.2.2

**Two things at the same time now sit side by side.** Before this, a block that overlapped another was drawn in the same rectangle, one on top of the other, and both titles were unreadable — which a calendar feed turned from a rare accident into the normal case. Overlapping blocks now split the column and stay legible, the same way every calendar app does it. Picking one up, resizing it, and dragging it back to the rail all still work on a crowded day.

- **The conflict marker got quieter.** The red tint and ⚠ used to fire on *any* overlap. Now that both blocks are visible, it only marks an overlap you genuinely can't see — a block sitting on top of a recurring commitment drawn behind the week. A *Fit this week* proposal still flags either way, since you haven't accepted it yet.

**The task pane is a to-do list now, not just an inbox.** It used to hide a task the moment you scheduled it, which read as *lost*. It now shows the whole week: unscheduled work as before, scheduled tasks greyed with where they landed (`Tue 2pm`), and completed ones struck through. A small **All / Unscheduled / Scheduled** filter at the top if you want the old view back.

- **Rail names lost their routing noise.** A task tagged `#thisweek` at the front, or a swept line that still carries a `09:00 - 10:30` range, now shows just its name in the list. The line in your note is untouched.

## 0.2.0

**Calendar sync.** Add one read-only iCalendar (.ics) feed URL in Settings and its events show up on the grid, right alongside everything else. By default they block scheduling gaps too — Fit this week won't propose a slot your calendar already has claimed — with a toggle if you'd rather they were shown but not treated as busy. The window is 2 weeks back, 8 forward.

- **Refresh is manual, not a background timer.** Run `Weekfit: Refresh calendar feed` or press "Refresh now" in Settings; it's rate-limited to once an hour so a slow or misbehaving feed can't be hammered.
- **ICS events are read-only.** They can't be dragged, resized, or clicked open. Drag one onto the rail if you want a task you can actually reschedule — that turns it into a plain line with an `[ics-uid::]` marker, and it stops being drawn as a calendar block from then on.
- **A `reviewed` week is never touched by the feed.** Once a week is closed out, there's nothing left for a calendar sync to do.
- **One feed, no OAuth.** A single iCalendar URL — no Google Calendar sign-in, no multiple calendars, no per-calendar colours. It's read-only: nothing is ever written back to the feed itself.

## 0.1.1 — first release

**You have eleven hours of work and a week with holes in it. Press one button and see where it fits.**

Weekfit reads the tasks you already have, the hours you're actually available, and what's already in your week — then proposes where the work goes. You accept what you like, drag what you don't, and it writes plain text back into your notes.

## What it does

- **Fit this week** — schedules unscheduled work into your free slots. Nothing else in the directory does this; the others all make you place the work yourself.
- **Availability windows** — *when could this kind of work happen*, matched against a task's `#tag`.
- **Recurring commitments** drawn behind the week and treated as busy.
- **A capacity line** — `6.5h committed / 14h free`, red when the week doesn't fit.
- **Duration defaults per `#tag`**, so a plain `- [ ] Book dentist` gets a size and the plugin works on a vault that's never heard of it. No annotation, no migration.
- **Deadlines get first pick.** Work is offered slots in due-date order, then by priority — so something due Thursday takes Thursday, whatever order it sits in your note.
- **Balanced or soonest-first** placement, because a plan that puts ten hours on Monday isn't one you'd look at.
- **Splitting** a task across several sittings, **replan** for what didn't happen, a **weekly review** with roll-forward, a **backlog**, and quick **capture**.
- Drag, edge-resize, and drag back onto the rail to take something off the week.
- **Undo** — one command puts back the last thing Weekfit wrote, including a roll-forward spanning two notes.

## It works with the tasks you already have

No new syntax required. A plain checkbox line works on day one. If you do annotate, Weekfit reads the [Obsidian Tasks](https://publish.obsidian.md/tasks/) standard in **both** flavours — emoji and Dataview inline fields — plus a `~90m` duration extension. All of it optional.

And you can set them without leaving the pane. The due date, duration and priority shown on each rail row **are** the controls — click one for a short menu. What gets written is the dialect the line is already in: an emoji line gets `📅`, an inline line gets `[due:: …]`, and a line with neither gets the emoji the Tasks plugin defaults to. Nothing is reordered and nothing else on the line is touched.

## Plan with us, view it wherever you like

Weekfit writes **Day Planner format** — the same `HH:MM - HH:MM` lines the Day Planner plugin already renders. Nothing has to be switched. If you stop using Weekfit tomorrow, your plan is still sitting in your notes in a format other tools understand.

**Your plan is a file, not a service.**

## How your notes are treated

One module writes. It re-reads the target line before changing it and **refuses rather than guesses** if the line moved. Only the target line changes — no reformatting, no whitespace churn, and your line endings survive. Nothing proprietary is written.

## Please know before installing

- **Requires Obsidian 1.7.2 or later**, and is **desktop only for this release.** Everything is pointer-based and should work on touch, but nothing has been tested on a phone or tablet.
- **Undo is one command, not a guarantee.** `Weekfit: Undo last change` puts back the last thing it did, across every file that change touched — but it refuses if you've edited the note since, and it only lasts for the session. Writes still land in your notes immediately, so it's worth a scratch vault for the first hour.
- No Google Calendar, no AI, no account, no telemetry.

905 tests, including an end-to-end pass that runs the real read → fit → write pipeline against real files on disk and asserts the resulting bytes. MIT.
