# Obsidian Live Syncinator

Real-time collaborative sync plugin for Obsidian. Uses Operational Transformation (OT) over WebSocket for live text editing, with HTTP REST for file CRUD. The server lives at `../obsidian-live-syncinator-server` (Go + SQLite).

## Philosophy

Extreme Programming. Small steps, fast feedback, relentless simplicity.

- **TDD, no exceptions.** Red-Green-Refactor. Every change starts with a failing test.
- **Tests describe behavior, not implementation.** Ask "what should happen when X?" not "does function Y call Z?"
- **Simple design.** Do the simplest thing that could possibly work. No speculative generality.
- **Continuous refactoring.** Improve structure only when tests are green. Never refactor and change behavior in the same step.
- **Pair programming mindset.** Explain decisions, flag risks, challenge assumptions.
- **Collective code ownership.** Any code can be changed by anyone. No sacred cows.
- **YAGNI.** Don't build it until you need it.

## Development Workflow

1. **Red**: Write a failing test that describes the desired behavior
2. **Green**: Write the minimal code to make it pass
3. **Refactor**: Clean up while keeping tests green

When fixing bugs: reproduce with a test first, then fix.

## Architecture

- **Client** (TypeScript, Obsidian plugin): `src/plugin.ts` orchestrates sync. Diffs via `src/diff/diff.ts`. WebSocket in `src/api/ws.ts`, HTTP in `src/api/api.ts`.
- **Server** (Go): OT engine in `pkg/diff/diff.go`. WebSocket handler in `pkg/ws.go`. REST API in `pkg/api.go`. LRU file cache with periodic flush to SQLite + disk.
- **Sync protocol**: Client sends `ChunkMessage` (diff chunks + version) over WS. Server transforms via OT if stale, applies, persists, broadcasts. ACK is the same message echoed back to sender with incremented version.

## Conventions

- Client and server diff/transform logic **must stay in sync**. Any change to OT in one must be mirrored in the other.
- Positions in diffs are **codepoint-based** (Go runes). The client must handle Unicode accordingly.
- Run both client and server tests when touching diff/OT code.

## Commits

One fix per commit. Commit message format:

```
fix: short description of the change
feat: short description of the new feature
refactor: short description of the refactoring
```

## Code Style

- No unnecessary comments. Code should be self-explanatory.
- Only add comments when explaining **why**, never **what**.
- No over-engineering. Solve the problem at hand, nothing more.
- Run `make lint` and `make test` before committing.
