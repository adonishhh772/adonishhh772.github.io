---
title: 'From demo to dependable: what production AI agents actually need'
description: 'Evaluation, tool permissions, observability, failure handling, human approval and cost — the boring, unglamorous work that turns a promising agent demo into a system you can trust in production.'
pubDate: 2026-08-14
issue: 1
tags: [agents, evaluation, observability, governance, cost]
draft: false
---

Demo agents are everywhere now. You prompt one, it grabs a tool, answers well, and everybody in the room nods. Then somebody asks the question that ends the meeting: *“Can we put this in front of customers?”*

That is where most agent projects quietly stall — not because the model is weak, but because the surrounding system was never designed for operation. A demo is a conversation. A production agent is a service with a budget, a permission model, an audit trail and a definition of done. This issue is about the six things that separate the two.

## Evaluation is the first thing you build, not the last

If you cannot measure whether the agent is getting better, you cannot ship changes safely. Every agent release is a regression risk: a new prompt, a tool signature change or a model update can silently degrade a behaviour that took weeks to tune.

Start with a task-level evaluation set, not vibes. Take the fifty to two hundred real questions your users actually ask and write the expected outcome for each. Not a rubric — an outcome: the correct document cited, the right ticket created, the correct field populated. Then add a handful of adversarial cases: ambiguous requests, requests that should be refused, tool calls that should never happen.

Run this set on every prompt change and every model version, and gate releases on it. A score that goes up on average while a specific high-value task goes down is still a regression. Look at per-task deltas, not just the mean.

## Tool permissions: least privilege is a product decision

The most common production incident I see is not a hallucination — it is an agent calling a tool it should never have been given. The model is a participant in your system, not the owner of it. Grant tools like you would grant access to a new employee: the minimum surface needed to do the job, reviewed regularly.

Practical rules that hold up:

- **Scope tools to the task.** A support agent reads tickets it is assigned. It does not need write access to every customer record.
- **Separate read and write surfaces.** Reads can be fast and unguarded; writes should be explicit, narrow and individually auditable.
- **Prefer deny-by-default.** If a tool is not required by the current workflow, it is not on the tool list. Add tools when a measured need appears, not in anticipation of one.
- **Constrain arguments.** Validate tool inputs server-side. The model chooses arguments; your code decides whether they are legal.

## Observability: trace the loop, not just the model call

You will debug this system at 2am eventually. Make that bearable. Log every step of an agent run — the user request, each tool call with its inputs and outputs, token counts, latency, model and prompt version, and the final answer — correlated under a single trace or run ID.

The tool call is where agents earn their keep, but it is also where they fail most inventively. When retrieval returns garbage, when a tool times out, when the model loops on the same failing call — you want to see it in one view, not reconstruct it from three different dashboards. Include cost per run while you are at it; see below.

## Failure handling: design for the loop that doesn't terminate

Agents loop. They retry the same failing tool call, repeat themselves, and sometimes drift far from the original request. Bounded iteration is not a nice-to-have; it is what makes the system safe and the bill predictable.

Three mechanisms that cover most cases:

- **Step caps.** Hard limit on tool calls per run. When a human is in the loop, tell them the run hit its budget rather than silently truncating.
- **Structured retries.** On a tool error, let the model see the error and try once or twice — but only if the request is genuinely recoverable. Do not let it re-run an idempotent-looking write blindly.
- **Escalation paths.** When confidence is low, the agent's job is to ask, not to guess. A good agent knows its own limits; a great system routes uncertainty to a human with the right context attached.

## Human approval at the points that matter

Not every action needs a human, and demanding approval for everything trains people to click through without reading. Reserve checkpoints for what is irreversible, expensive, or externally visible: sending a message to a customer, updating financial data, publishing content, spending money.

Design the checkpoint as a decision, not a formality. Show what the agent intends to do, why, and what the evidence is — then let the human approve or reject with one action. If approval becomes a rubber stamp, the threshold is set too low.

## Cost is an architecture concern, not an accounting one

A demo answers one question. Production answers thousands a day, and each one carries a price tag that compounds with agentic loops: a tool call triggers a retrieval, a re-prompt, another completion. Costs grow roughly with *steps*, not just tokens.

Practical levers: put hard per-run budgets in place from day one; cache and reuse retrieval results and repeated sub-answers; route simple requests to a smaller, cheaper model and escalate only what needs the large one; and alert on cost-per-run outliers the same way you alert on latency. If you cannot explain this month's bill, you do not yet understand your agent's behaviour.

## The takeaway

- Build evaluation first; gate every prompt and model change on it.
- Give agents the smallest permission surface that works, and validate every tool call server-side.
- Trace the whole loop — tool calls, tokens, cost — under one run ID.
- Cap iterations, retry only what is recoverable, and escalate uncertainty to humans.
- Reserve human approval for irreversible or externally visible actions.
- Treat cost as a system property: budget, cache, route, and alert on it.

An agent in production is judged less by its cleverness than by its predictability. The model does the thinking; your system does the trusting.
