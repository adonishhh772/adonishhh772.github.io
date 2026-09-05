---
title: 'Cybersecurity for AI systems: how architects should think about the new attack surface'
description: 'Prompt injection, data leakage, tool abuse, model supply chains and token-burning denial of service. A practical mental model for thinking about AI security the way you already think about the rest of your architecture.'
pubDate: 2026-09-05
tags: [cybersecurity, architecture, agents, rag, security]
draft: false
---

Most security teams already know how to think about a web application: trust boundaries, input validation, least privilege, logging, and a threat model that names the bad things that could happen. Then an AI system arrives — an agent with tools, a RAG endpoint, an LLM gateway — and the instinct is to treat it as one more application. It is not. An AI system inverts several assumptions you have been relying on for years, and the teams that adapt fastest are the ones that update their mental model first, not their vendor list.

This post is not an audit checklist. It is a way of thinking — the questions an architect should ask before the first model call goes to production.

## The core inversion: you cannot fully trust the model, and you cannot fully distrust it either

Start here, because everything else follows. A language model executes no code and holds no secrets — but it generates *text that other parts of your system will act on*. Prompt injection means that text can carry instructions from an attacker who never touched your network: they put them in a document your RAG system retrieves, in an email your agent reads, or in a field your summariser processes.

So the rule that worked for applications — "validate untrusted input at the boundary" — has to be applied *after* the model, not just before it. The model's output is untrusted input to every tool, database and workflow it touches. Architect for that: nothing the model says should be able to act until it has passed through your permission system, the same way nothing a user types should be able to act until it has passed through yours.

## Draw the trust boundaries around the model, not through it

A useful mental model: the model sits inside a boundary that *you* own, and everything it can touch is on the other side of a gate you control.

- **Retrieval is a trust boundary.** Documents are attacker-influenceable input. Treat fetched content as untrusted: filter by access tier before ranking, keep restricted documents out of the prompt entirely, and never let retrieved instructions override your system prompt's authority.
- **Tools are the highest-stakes boundary.** An agent is only as dangerous as its tool list. Least privilege here is not a slogan — grant each agent only the tools its workflow needs, validate arguments server-side, and put irreversible actions behind human approval. A prompt injection that reaches a "read file" tool is a leak; one that reaches a "send email" tool is an incident.
- **Output is a boundary too.** Where the model's text reaches users, add a guardrail layer: content filtering, refusal of unsafe requests, and — for regulated contexts — verification against retrieved sources before display.

## Map the AI-specific risks onto things you already manage

Three attack classes are new enough that teams misjudge them:

1. **Prompt injection** — the attacker's instructions travel inside legitimate-looking data. Your controls are content-sandboxing (separate untrusted content from instructions), tool permissioning, and adversarial testing of exactly these flows.
2. **Data leakage through the model** — secrets, PII or IP that end up in prompts, logs, training or transcripts. Controls: redaction before logging, retention limits, and never logging full prompts by default. Remember that *monitoring* is also a data store: your traces contain everything the model saw.
3. **Cost and availability attacks** — an attacker can burn your budget or saturate your endpoint by sending expensive queries, or by tricking an agent into long tool-call loops. Per-run caps, rate limits and step limits are denial-of-service controls, not accounting trivia.

## The supply chain is now model-shaped

You can no longer reason about your dependency tree as a list of packages. Your models, embeddings and agents are dependencies with their own provenance questions: which model version is pinned, who trained it, what data went into it, when it changes, and who decides. Treat model updates like library updates — pinned, tested, reviewed and rolled back on regression — because a frontier model that improves monthly is a dependency that changes *under* you.

## Test like an adversary, because that is who you are defending against

AI security testing cannot be an afterthought, because the attack surface includes things normal pentests never see. Build an adversarial evaluation set alongside your functional one:

- prompt-injection attempts hidden in retrieved documents;
- attempts to make the model reveal system instructions or other users' data;
- requests that push tools to act on crafted arguments;
- and inputs designed to trigger expensive loops.

Run these on every prompt, model and tool change — the same regression discipline you already use for functional quality, pointed at security. If you have the budget, a red team exercises the whole flow; if you do not, a well-built adversarial eval set catches most of the embarrassing cases.

## Decide what the model may never see, do, or say

Before production, write three lists with the business: **never-see** (data classes that must not reach any model or its logs), **never-do** (actions no agent may take, regardless of what the prompt or context says), and **never-say** (content the model must not produce). These three lists become the boundaries your architecture enforces — and they force the governance conversation that security reviews always circle around but rarely finish.

## Build the incident response before the incident

When an AI system misbehaves, you need answers fast: which model, which prompt version, which tool calls, which retrieved documents, which user. That requires the trace discipline from earlier in this newsletter — per-run IDs, tool-call logging and audit trails — to exist *before* the alert. Also plan the human fallback: the ability to switch off agentic behaviour and route to people without rebuilding anything is the most underrated control in the whole system.

## The takeaway

- The model's output is untrusted input to everything downstream — enforce permissions after generation, not just before it.
- Retrieval, tools and output each deserve their own trust boundary and access-control story.
- Treat cost caps, rate limits and step limits as security controls against denial of service.
- Models are dependencies with provenance: pin, test and review them like libraries.
- Add adversarial evaluation (prompt injection, leakage, tool abuse) to your regression suite.
- Write the never-see / never-do / never-say lists with the business before launch.
- Invest in traces and a human fallback before you need them.

The framing that helps most: do not ask "is the model secure?" Ask "if this model is fully controlled by an attacker tomorrow, what is the worst thing that happens — and is that acceptable?" Architecture the answer to that question before the model ever reaches production.
