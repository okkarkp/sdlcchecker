# For Business Analysts — step by step

You don't need to be a developer to use this. As a BA your job is the **first stage** of the
pipeline: turn a raw requirement into a clear, traceable, implementation-ready deliverable — and
**stop the team from building the wrong thing**. The `requirements-analyst` agent does that work
with you. You stay in control of every decision.

> The agent is **read-only** — it can't change your repo or your source document. It reads, thinks,
> and hands back a structured deliverable. You decide what to keep.

---

## Step 1 — Open the project in Claude Code

Open the repo that has the agents installed (see [INSTALL.md](../INSTALL.md) if it isn't set up
yet). Confirm by typing `@` — you should see **requirements-analyst** in the list.

## Step 2 — Point the agent at your requirement source

The source can be almost anything: a story file, a ticket, a PRD, pasted text, a PDF, or an
Excel/Word backlog export. **Always name the source** — the agent will not guess.

**If it's a file already in the repo:**
```
Use the requirements-analyst agent to analyse docs/stories/SBX-DEMO-6-api-token-store.md
and return the BA deliverable.
```

**If you want to paste the requirement inline:**
```
Use the requirements-analyst agent to analyse the requirement below and return the BA deliverable:

As a platform we want to issue API tokens and verify them later, without ever
storing the token in plaintext. Store only a hash...
```

**If it's an Excel/Word/PDF backlog:** tell the orchestrator instead — it converts the file
to a clean table first, then runs the analyst:
```
Use the orchestrator agent to intake requirements/backlog.xlsx and run the
requirements-analyst on it.
```

## Step 3 — Read the deliverable (10 sections)

What you get back is a single structured document. Skim it in this order:

1. **Feature Overview** — does the one-paragraph summary match what you meant?
2. **Open Questions** (jump here early) — is it **READY** or **PAUSED**?
   - ✅ *READY for design* → no blocking questions. Move on.
   - ⛔ *PAUSED / NOT COMPLETE* → there are **blocking questions** for you. Go to Step 4.
3. **User Stories** — each has an As-a / I-want / So-that, numbered acceptance criteria, and a
   link back to the source. Check no AC says "TBD" or anything vague.
4. **Roles & Permissions / State Machine / Prerequisites / Out of Scope** — sanity-check the
   actors, any workflow states, seed-data needs, and what's *deliberately excluded*.
5. **Assumptions** + **Decided Questions** — the small calls the agent made *for* you, each with
   the options it considered and a `[AI decided]` / `[Human decided]` tag.

> See a worked example: a clean one ([SBX-DEMO-6](../../delivery-team-demo/artifacts/feature/SBX-DEMO-6/00-stories.md))
> and a paused one (account lockout — the agent asks 5 blocking questions before any design).

## Step 4 — Answer the blocking questions (the important part)

If the deliverable is **PAUSED**, the agent has listed the decisions only *you* (or product/policy)
can make — e.g. *"How many failed attempts trigger a lockout?"*, *"Is the lock permanent or does it
auto-unlock?"*. Answer them in one message:

```
Answers: lock after 5 failed attempts; auto-unlock after 30 minutes;
a successful login resets the count; only a wrong password counts as a failure.
Re-run the requirements-analyst with these decisions.
```

The agent folds your answers in, tags them `[Human decided]`, and returns the completed
deliverable. **Non-blocking** questions it already decided itself — you can override any of them
the same way if you disagree.

## Step 5 — Override or refine anything

It's a draft for *you*. Push back freely:
```
Story DEMO7-US-02 is out of scope for V1 — move it to Out of Scope.
Add an assumption that account IDs are opaque (no PII).
```

## Step 6 — Hand off to design

Once it says **READY for design** and you're happy, the requirement is ready for the rest of the
team. Either:
- Let the developer/lead run `/deliver <story-file> <ticket>` to take it the whole way, **or**
- Continue agent-by-agent: *"Use the solution-architect agent to design this from the deliverable."*

Your deliverable becomes the single source of truth every later stage reads from.

---

## What you do vs what the agent does

| You (the BA) | The agent |
|---|---|
| Provide the source; decide scope, policy, money, and priority calls | Reads the source + the existing codebase |
| Answer **blocking** questions | Flags blocking questions; **never guesses** them |
| Override any decision you disagree with | Decides **non-blocking** questions (with options shown) |
| Confirm it's READY | Produces traceability, stories, ACs, state machine, assumptions |

## Tips

- **Always name the source** — a path, a ticket, or pasted text. No source = the agent stops and
  asks for one (by design).
- **A PAUSED result is a success, not a failure** — it means the agent caught a gap before the
  team spent effort building the wrong thing.
- **You never touch code or git.** The agent is read-only; the deliverable is text you review.
- **Backlog of many stories?** Hand the whole export to the *orchestrator* — it reads every column
  of every row, not just the summary.
