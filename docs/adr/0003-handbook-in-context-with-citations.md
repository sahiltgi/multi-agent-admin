# ADR-0003: Handbook in context with citations (vector search deferred)

Status: Accepted · 2026-10-08

## Context

The Policy Q&A Agent must answer only from the handbook, and every answer has to be checkable. The synthetic handbook is small. A retrieval pipeline (embeddings, vector store, chunking) adds moving parts and its own failure mode: the right passage is never retrieved.

## Decision

Pass the whole handbook to the Claude API as a document, with prompt caching and API citations turned on. The Q&A gate returns `AUTO_ANSWER` only when there is at least one citation, every cited passage exists verbatim in the handbook, and the topic isn't on the sensitive list. Otherwise it escalates to HR.

**Vector search is deferred.**

## Consequences

- Nothing can be missed at retrieval time, and citations are checkable with a string match in pure code.
- Every call carries the full handbook. Prompt caching keeps the cost and latency down.
- Revisit this decision when the handbook stops fitting the context window or the per-question cost budget.
