---
title: 'The AI architecture conversation teams should have before choosing a model'
description: 'Business problem definition, data readiness, risk classification, model selection, MVP scope and measurable success criteria — the six questions that prevent model-first projects from becoming expensive regrets.'
pubDate: 2026-08-28
issue: 3
tags: [architecture, model selection, strategy, evaluation]
draft: false
---

Most AI project failures are not model failures. They are *conversation* failures — the team picked a model before anyone agreed on the problem, the data was never examined, and "success" was defined as a demo that impressed leadership. By the time the model is chosen, the project's fate is usually already decided.

The fix is not more benchmarking. It is a structured conversation, held early, with the business and engineering at the same table. Here are the six questions worth asking before anyone writes a prompt or calls an API.

## 1. What is the business problem, really?

"Let's build an AI assistant for our customers" is not a problem statement. It is a solution looking for a justification. Dig until you can describe the problem in terms someone outside the room would understand:

- *What is the task today, and who does it?* (e.g. support agents spend twenty minutes searching manuals per ticket)
- *What is the cost of the current state?* (slow tickets, inconsistent answers, knowledge trapped in heads)
- *What would change if it worked?* (first-response time down, deflection up, on-call time freed)

Notice what is missing: the model. At this stage the model is interchangeable — because if the problem is not well-defined, no model will fix it. A crisp problem statement also tells you whether AI is even the right tool. Sometimes the honest answer is a better search box or a form that captures structured data.

## 2. Is the data actually ready?

This is the question teams skip and regret. Model selection assumes you have the *right data* in a *usable form* — and in most enterprises, that assumption is false. Ask:

- **Where does the knowledge live?** Wiki, tickets, PDFs, people's heads, a CRM that nobody trusts?
- **What condition is it in?** Is it structured, current, deduplicated, permission-tagged?
- **Who owns it?** Knowledge without an owner decays. Someone has to be accountable for keeping it accurate.
- **What is the ground truth for evaluation?** You cannot measure quality without a reference set of real tasks and correct answers.

The uncomfortable rule: if you cannot assemble a hundred realistic test cases with known-good answers, you are not ready to build — you are ready to prepare. Data readiness gates everything else, and it is usually the longest lead time in the project. Start it before you choose a model, not after.

## 3. What is the risk class of this system?

Not every AI system carries the same risk, and treating them alike is how projects either over-engineer or under-protect. A useful rough classification:

- **Low risk — assistive.** Summaries that a human reviews before acting, internal drafts, search aids. Failure is an inconvenience.
- **Medium risk — advisory.** Answers that shape decisions but are verifiable — e.g. a compliance assistant that must cite its sources. Failure is a wrong decision that could have been caught.
- **High risk — autonomous or consequential.** Systems that act without review or touch regulated domains: financial advice, hiring decisions, anything that sends messages or modifies records on its own. Failure is an incident.

The risk class decides the architecture: what guardrails are required, where humans sit in the loop, how much evaluation and monitoring is non-negotiable, and which stakeholders must sign off. Classify early and write it down — it becomes the safety contract for the project.

## 4. Which model, and why?

Only now does model choice become a real question — and it is rarely the frontier model. Selection should weigh:

- **Capability needed for *your* tasks**, measured on your evaluation set, not on leaderboards that optimise for unrelated benchmarks.
- **Latency and cost at your expected volume.** An agentic workload multiplies tokens across tool-call loops; a slightly smarter model that needs half the retries can be the cheaper one.
- **Data and compliance constraints.** Where data must stay, what can be sent to a public API, what must run in your own environment — this filters the candidate list before any technical comparison.
- **The boring operational factors.** Provider reliability, rate limits, versioning policy, how quickly models change under you. A model that improves monthly is a dependency you must re-evaluate, not a one-time choice.

A useful framing: choose the *weakest* model that passes your evaluation thresholds, keep the ability to swap, and treat model choice as a recurring decision rather than a founding commitment.

## 5. What is the smallest thing that proves the value?

The MVP question is not "what can we build?" but "what is the narrowest slice that demonstrates measurable value with acceptable risk?" A focused pilot beats an ambitious platform every time:

- Pick **one workflow**, not "all of customer support".
- Cover the **highest-value, well-understood subset** of that workflow — the cases where data is clean and the answer is knowable.
- Be explicit about what is **out of scope** at first: edge cases, exotic document types, full autonomy.
- Set the pilot's **exit criteria** in advance: what must be true — measurably — for the project to continue, change direction, or stop.

A narrow pilot also de-risks the organisation's learning curve. People need to experience an AI system that is honest about its limits before they will trust one that isn't.

## 6. What does success look like — measured how?

If success cannot be measured, the project will be judged by whoever argues loudest. Define metrics before the build, at two levels:

**Product metrics** tied to the business problem: time-to-answer, resolution rate, deflection, user adoption, time saved. **System metrics** tied to the engineering: answer accuracy on the evaluation set, retrieval recall, hallucination rate, latency, cost per task, human-approval rate.

Then decide the *mechanism* for measuring: the evaluation set, the trace logs, the user feedback loop. And agree what happens at the review: not just "did it work?" but "what did we learn, and what is the next smallest experiment?" Build the habit of shipping *evidence*, not just features.

## The takeaway

- Define the business problem in terms of today's cost and tomorrow's change — before any model talk.
- Audit data readiness early; a hundred realistic test cases with known answers are the price of admission.
- Classify risk (assistive, advisory, autonomous) and let it set the guardrails and human-in-the-loop requirements.
- Choose the weakest model that passes *your* evaluations, and treat the choice as renewable.
- Scope an MVP to one workflow with explicit boundaries and pre-agreed exit criteria.
- Define product and system metrics up front, with a mechanism to measure them.

The model is the smallest decision in an AI project. The problem definition, the data, the risk posture and the measurement are the ones that determine whether the project delivers value — or delivers a very expensive demo.
