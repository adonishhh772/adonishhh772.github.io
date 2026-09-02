---
title: 'KAI — Enterprise knowledge assistant'
shortTitle: 'KAI'
summary: 'An enterprise AI assistant that helps teams find, understand and use trusted organisational knowledge.'
context: 'KAI is a multi-agent RAG assistant built for enterprise teams that were drowning in internal knowledge: policies scattered across wikis, shared drives and expert inboxes, answers that depended on knowing who to ask, and no reliable way to know which version of a document was current. The goal was not a chatbot. It was a system people could trust enough to act on — one that surfaced the right document, cited it, and knew when to ask a human instead of guessing.'
tag: 'Enterprise delivery'
themes:
  - Multi-agent RAG
  - Knowledge ingestion and retrieval
  - Evaluation and guardrails
  - Observability and operational reporting
  - Enterprise adoption
readingTime: '7 min read'
---

KAI began with a simple observation: the knowledge was there, but it was not *usable*. Teams spent visible time every week hunting for answers that someone else had already written down, and the most experienced people were the ones being interrupted most. A knowledge assistant only earns its place if it makes that search dramatically faster — and if people trust the answer enough not to verify it by hand anyway.

## The problem

The core problem was trust layered on chaos. Documents contradicted each other, versions went stale, ownership was unclear, and no amount of search-box improvement fixed that. Any assistant built on that corpus would inherit its problems — and an assistant that answers fluently from outdated or conflicting sources is worse than no assistant, because it produces confident wrong answers.

So the real problem had three parts: get the *right* knowledge in front of users, make it *verifiable*, and make sure the system *knew its limits*. Everything else was detail.

## My role

As a Lead AI Engineer at AWTG, I contributed to the KAI AI platform — building production-grade LLM workflows, Python/FastAPI services, backend systems, data pipelines and reusable AI capabilities for major organisational users. I led technical design and delivery across the full stack: document ingestion and structuring, retrieval, the agent orchestration layer, the evaluation harness, and the guardrails that sat around it. I also worked closely with stakeholders on adoption — defining the rollout with real user groups, training champions, and turning operational reporting into a steering mechanism rather than a dashboard afterthought.

## The approach

**Start from real questions, not from documents.** Before designing retrieval, we collected the questions people actually asked and grouped them. That told us which corpora mattered, which document types were the pain points, and what "a good answer" looked like for each task. Those questions became the seed of the evaluation set.

**Evaluation first.** We built a task-level evaluation set with expected outcomes and ran it continuously — on every ingestion change, prompt change and model change. Quality gates were set *before* features, which sounds bureaucratic and saves exactly the kind of expensive rework it sounds like it creates.

**Multi-agent RAG with bounded autonomy.** Rather than one prompt doing everything, we split the work: a router that understood the request, retrieval agents scoped to specific corpora, a synthesis agent that wrote the answer, and a verification step that checked the answer against the cited passages before anything was shown. Agents had real tools but narrow permissions, and every tool call was traced.

**Guardrails and human checkpoints.** The assistant could answer, summarise and draft — but actions with real consequences required explicit human approval, and the system was allowed to decline when it had no good source. Guardrails ran on both sides of the model: on the inputs (what was allowed into the prompt) and on the outputs (what the answer could claim).

## Architecture and technical themes

- **Ingestion:** structured document pipeline with parsing, chunking at semantic boundaries and rich metadata — source, version date, owner, access tier.
- **Retrieval:** hybrid search with metadata filtering, so freshness and access control were enforced at retrieval time rather than patched on afterwards.
- **Orchestration:** LangGraph-based multi-agent loop with bounded steps, structured retries and escalation paths to humans.
- **Evaluation:** a versioned task-level harness covering answer quality, retrieval recall and refusal behaviour; run in CI on every change.
- **Guardrails:** input and output filtering, tool permission scoping, approval checkpoints on consequential actions.
- **Observability:** end-to-end traces of every run — retrieval results, tool calls, tokens, cost — plus operational reporting for the programme team.

## Outcomes

- Delivered as part of AWTG's KAI AI platform, which supports **65,000+ active users** across major organisations, including the British Council — enterprise AI adoption at real scale rather than a lab pilot.
- Teams could ask questions in natural language and get answers with citations pointing to the specific passages in trusted documents — including the version date, so "is this current?" stopped being a guess.
- Knowledge that had lived in expert inboxes became findable by the whole team, reducing the interrupt-driven burden on the most experienced people.
- The governance posture was demonstrable rather than aspirational: approval checkpoints, audit trails and refusal behaviour were designed in from the start, which made security and risk conversations materially easier.
- Adoption was staged: pilot groups, champions, feedback loops — and the operational reporting became the mechanism the programme team used to decide what to improve next.

The scale and client context above come from the programme's own reporting. Beyond those figures I have kept outcomes qualitative: I would rather describe what the system demonstrably did than quote metrics that depend on context I cannot share.

## What I learned

- **Evaluation is the product.** Almost every improvement that mattered — better chunking, a stricter router, a safer refusal policy — was discovered through the evaluation harness, not through intuition.
- **Knowledge operations are the hard part.** Document ownership, freshness and quality are organisational problems that no retrieval technique can bypass. The technical work is the easy 20%.
- **Agents need bounded trust.** The best design decision was deciding, in advance, which actions the system could take alone and which required a human. That boundary is a product decision, not a security footnote.
- **Adoption is an engineering activity.** Champions, training and honest communication about limits built more trust than any accuracy metric did.

The takeaway: a trustworthy enterprise assistant is less about the model and more about the corpus, the evaluation and the boundaries around the agent — in roughly that order.
