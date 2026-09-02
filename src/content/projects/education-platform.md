---
title: 'Education platform — GraphRAG for complex learning content'
shortTitle: 'Education platform'
summary: 'Led delivery of a GraphRAG and document-intelligence platform that turns complex, unstructured learning content into connected, searchable knowledge.'
context: 'Some knowledge does not live in tidy documents. It lives in long, dense, heavily cross-referenced learning material — where a term is introduced in one module, used in another, qualified by a footnote in a third, and where the meaning only emerges when the connections between documents are visible. Plain retrieval treats each passage in isolation and misses exactly those connections. This project was built to handle that class of content: a GraphRAG and document-intelligence platform that turns complex, unstructured learning content into connected, queryable knowledge with citations back to the original source.'
tag: 'Education platform'
themes:
  - Neo4j
  - GraphRAG
  - Docling and document processing
  - Entity and relationship extraction
  - Azure migration
  - Retrieval quality and citation accuracy
links: []
readingTime: '7 min read'
---

The project started from a frustration with the limits of vector-only search. Embeddings are good at finding passages that *sound* like the question. But for complex, interconnected learning content, the answer often depends on relationships — a definition in one place, an exception in another, an entity that appears under different names across a corpus. The thesis was that by extracting those structures explicitly and storing them in a graph, retrieval could reason across documents instead of just matching within them.

## The problem

The content was large, unstructured and structurally difficult: long documents with dense tables, cross-references, and terminology that was introduced once and then assumed everywhere else. Users needed answers that respected those connections — and they needed to verify every answer against the original text, because the domain was one where a confident but wrong synthesis is not acceptable.

Vector search alone failed in characteristic ways: it retrieved the passage where a term was *used*, not the passage where it was *introduced*; it struggled with tables; and it had no way to say "these three documents all describe the same entity" or "this later clause modifies that earlier one."

## My role

I led AI engineering delivery for the platform. That meant translating product and user needs into scalable, AI-enabled platform features, and owning the architecture end to end — document processing, entity and relationship extraction, graph modelling and storage, the retrieval layer, and the quality loop that made extraction trustworthy — as well as the migration of the workload to Azure and the stakeholder conversations that shaped what "good" meant for the educators and learners who would use it.

The platform is still in development, so I've kept this case study deliberately free of identifying detail.

## The approach

**Document processing first.** Raw documents went through a parsing pipeline (built on Docling) that recovered structure: headings, tables, reading order. Structure-aware processing mattered more than any single algorithm, because extraction quality collapses if the document model is wrong before the LLM ever sees the text.

**Extraction with schemas, not freeform.** We extracted entities and relationships using structured, versioned schemas with validation, rather than letting the model invent its own ontology. Subject-matter experts reviewed samples of the extractions early, and their corrections fed back into the extraction prompts. This loop — extract, validate, review, refine — was where the quality of the whole system was actually decided.

**Graph plus vectors.** Entities and relationships were stored in Neo4j alongside vector indexes over the chunks. Retrieval could then work in both modes: similarity search for the direct passage, and graph traversal for the connected answer — expanding from a found entity to its definition, related entities and the passages that connected them.

**Citations as a first-class output.** Every answer had to be traceable to the specific original passage — including passages inside tables. We treated citation accuracy as a measurable property of the system, evaluated continuously, not as a formatting nicety.

**Azure migration.** The ingestion, inference and serving workloads were migrated to Azure as part of the delivery, which forced the cost, scale and governance conversations earlier than they usually happen — and that turned out to be a feature.

## Architecture and technical themes

- **Docling-based processing:** structure recovery, table handling and layout-aware parsing feeding every downstream step.
- **Knowledge graph (Neo4j):** entities, relationships and provenance, queryable alongside the raw passages.
- **Extraction pipeline:** schema-validated LLM extraction with human-in-the-loop review and prompt versioning.
- **Hybrid retrieval:** vector similarity for direct matches, graph traversal for connected and cross-document answers.
- **Evaluation harness:** retrieval quality and citation accuracy measured on expert-validated test cases, with regressions tracked over time.
- **Azure migration:** containerised ingestion and serving, managed inference endpoints, and observability aligned to the platform's operating model.

## Outcomes

- Content that had been effectively siloed — answerable only by people who had read everything — became queryable as connected knowledge, where the system could surface a definition, its related exceptions and the original passages in one response.
- Answers carried precise citations, including to content inside tables and cross-referenced material, and citation accuracy was measured rather than assumed — giving users a way to verify instead of a reason to distrust.
- The extraction quality loop gave subject-matter experts a concrete role in the platform, which did more for trust than any accuracy dashboard could have.
- The Azure migration left the platform with a cleaner operating model for cost, scale and data governance.

As the platform has not launched publicly, I have kept outcomes qualitative and separated them from implementation detail.

## What I learned

- **Extraction quality is the whole game.** A GraphRAG system is only as good as the entities and relationships it stores. Schema design and the human review loop matter more than the model choice.
- **Structure is retrieval infrastructure.** Recovering document structure properly — tables especially — was worth more than any retrieval algorithm tweak.
- **Graphs earn their keep on cross-document questions.** For simple lookups, a vector index is enough. The graph pays off exactly where retrieval is hardest: answers that require connecting things the question never names together.
- **Migrating to the cloud early forces honest conversations.** Cost, scale and governance surfaced as design inputs rather than late surprises.

The takeaway: GraphRAG is not a magic retrieval mode. It is a way of making the connections that already exist in complex content explicit, measurable and verifiable — and its quality is decided upstream, in the document pipeline and the extraction loop.
