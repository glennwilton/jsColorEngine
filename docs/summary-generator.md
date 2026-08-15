# Summary Generator Instructions

## Purpose
This file tells the AI how to create and maintain a compact project overview.

**Output file: `docs/README.md`** (decided 2026-08-16) — it doubles as
the GitHub-rendered docs-folder index for humans and the AI context
entry point. The root `CLAUDE.md` points at it so Claude Code loads the
pointer automatically at session start; keep that pointer intact.

The summary gives a high-level view of the whole project and points the model to the right detailed MD files when needed. Keep it short so it can live at the start of context without wasting tokens.

**Adaptation for this repo** (~30 md files): per-file entries with
"recent changes" bullets would blow the word budget and rot quickly.
Instead: group files by layer (entry points / API / feature notes /
performance & quality / samples) with one-line summaries, replace
per-file recent-changes with a single **Current state** section (dated),
and delegate to-dos to `Roadmap.md` / `deepdive/benchmark_todo.md`
rather than restating them. Update the "Last regenerated" date each run.

## When to run
- After finishing a feature and updating its MD docs
- After a long planning or deep-dive session
- When starting a new chat on an existing project
- Whenever the user says "update the summary" or "refresh the overview"

## How to generate / update the summary

1. Scan the project for all relevant `.md` files (specs, deep-dive logs, architecture notes, feature docs).
2. For each file, produce a short entry with:
    - **Filename**
    - **One-to-two sentence summary** of what the file covers
    - **Most recent changes** (bullet points – only the important ones)
    - **Next to-dos / open items** (if any)
3. At the top of the summary, write a short **Project Overview** paragraph that explains the overall system in plain language.
4. Keep the entire summary under ~400–600 words if possible. Prefer clarity over completeness.
5. Write the result to `project-summary.md` (create it if it doesn’t exist, overwrite if it does).

## Required structure for project-summary.md

```markdown
# Project Summary

## Project Overview
[2–4 sentences describing the whole system and how the main pieces fit together]

## Feature / Document Index

### [Feature or Document Name]
- **File:** `filename.md`
- **Summary:** [1–2 sentences]
- **Recent changes:**
  - …
- **Next to-dos:**
  - …

### [Next Feature…]
…

## Global Notes
- Any cross-cutting decisions, constraints, or patterns that apply to multiple features
- Links back to the most important source-of-truth docs