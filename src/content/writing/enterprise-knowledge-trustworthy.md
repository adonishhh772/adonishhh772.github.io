---
title: 'RAG is not the hard part: making enterprise knowledge trustworthy'
description: 'Document quality, chunking, metadata, retrieval evaluation, citations, access control and freshness — the unglamorous work that decides whether a RAG system actually helps people or quietly misleads them.'
pubDate: 2026-08-21
issue: 2
tags: [rag, evaluation, retrieval, governance, security]
draft: false
---

Every week there is another post about building a RAG system in an afternoon. The vector store spins up, the embeddings pipeline runs, and the demo answers questions with impressive fluency. Then the first real user asks about a policy that changed last quarter, and the system answers confidently from the version that was retired. RAG is not the hard part. Making enterprise knowledge *trustworthy* is.

The uncomfortable truth: in a RAG system, the model is only as reliable as the corpus you point it at. Garbage documents, ambiguous chunks and stale content do not just produce wrong answers — they produce fluent, confident, well-cited wrong answers. That is worse than silence, because it is harder to detect.

## Document quality decides everything upstream

Retrieval cannot fix a document that was never written well. Before you embed anything, ask what your source documents actually are and who owns them. Are they maintained? Do they contradict each other? Which version is authoritative?

Three upstream questions that save months downstream:

- **Is this the source of truth?** Mark documents as authoritative or reference. If two policies conflict, the system needs to know which one wins — ideally before the conflict reaches a user.
- **Is it human-readable?** PDFs of scanned slides, tables split across pages, and dense legalese all degrade retrieval. OCR quality and layout structure matter more than anyone wants to admit.
- **Is it current?** Stale knowledge quietly poisons results. Knowing *when* a document was last reviewed is a feature, not metadata trivia.

## Chunking is a design decision, not a default

The naive approach — fixed-size chunks with overlap — treats every document like the same kind of text. Real corpora are not uniform: a procedure manual, a legal contract and a support ticket want very different chunking strategies.

Chunk at *semantic boundaries*, not character counts. Respect the document's own structure: sections, headings, tables, lists. Keep each chunk self-contained enough to stand alone — a chunk that begins mid-sentence and ends mid-thought is a chunk that retrieves badly, because the model never sees the beginning or the end.

Structure-aware chunking is worth the effort for anything with real layout: tables are often answerable verbatim if the row and its header stay together, and hopeless if they are split across chunks.

## Metadata is what makes retrieval *selective*

Vector similarity finds text that *sounds* relevant. Metadata is how you tell it what is actually relevant — or what must never be retrieved. The chunks you store should carry their provenance: source document, section, version date, authoring team, access tier.

This matters for three reasons:

- **Filtering.** "Show me the current expense policy for the UK office" is a metadata query wearing a similarity costume. Without structured filters, the embedding has to do work it was never designed to do.
- **Freshness.** A policy updated in July should outrank its January version — but only if the retrieval step knows the dates, and only if the old version is either archived or explicitly excluded.
- **Safety.** If a document is confidential, the *chunk* is confidential. Access control enforced only at generation time is too late; restricted content should never reach the prompt in the first place.

## Evaluate retrieval the way you evaluate the model

Teams obsess over prompt quality and never measure retrieval quality, then wonder why the answers drift. Retrieval has its own evaluation, and it is refreshingly concrete.

Build a set of queries with known good answers, and measure two things: **recall** (did the relevant chunk make it into the retrieved set?) and **precision** (of what was retrieved, how much was actually useful?). Then look at the failure modes — the queries where the right document ranked tenth, or where three chunks of noise crowded out the one correct answer.

Retrieval evaluation is cheaper than end-to-end evaluation and isolates the failure earlier. When answers are wrong, knowing whether retrieval or generation caused it halves your debugging time. Keep a retrieval scorecard next to your answer scorecard, and treat both as release gates.

## Citations are the contract with the user

An answer without a source is an opinion. In an enterprise setting, users need to verify — not because they distrust the system, but because they are accountable for acting on it. Citations are the mechanism that makes verification possible.

Requirements that matter in practice:

- Cite the *specific chunk*, not just the document — a forty-page policy is not a useful citation.
- Show the passage so the user can check the claim without opening the document.
- If the answer synthesises several sources, say so.
- When confidence is low or no source supports the claim, the system should say *"I don't have a source for that"* rather than papering over it. The ability to decline is a feature.

## Access control and freshness are operational, not aspirational

Two systems problems that quietly sink deployments:

**Access control.** If a user can retrieve content they cannot see, you have a data-exposure incident waiting for the first clever prompt. Enforce permissions at the retrieval layer — index chunks with their access tier and filter before ranking — and treat the embedding store as a sensitive data store in its own right. Monitor what gets retrieved and by whom, and log it.

**Freshness.** Knowledge changes; your index must too. Design ingestion as a pipeline with owners and schedules: detect new documents, remove retired ones, re-embed changed content, and record *when each document was last indexed*. Staleness is a retrieval-quality bug, not an operations footnote. A "knowledge last refreshed" note on the interface is honest and cheap.

## The takeaway

- Curate upstream: authoritative sources, readable formats, review dates.
- Chunk by semantic structure, and keep tables and their headers together.
- Store rich metadata and use it to filter, rank by freshness and enforce access — before ranking, not after generation.
- Measure retrieval recall and precision with the same discipline you measure answers.
- Cite the specific chunk with the passage shown, and allow the system to decline when no source supports an answer.
- Treat access control and freshness as first-class system requirements, not deployment details.

The model answers. The corpus decides whether the answer is true. Build the corpus like your reputation depends on it — because in an enterprise, it does.
