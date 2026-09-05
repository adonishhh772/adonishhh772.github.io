---
title: 'Cascaded voice AI, ElevenLabs, or direct providers: what latency really costs in the enterprise'
description: 'Voice agents are suddenly ready for the enterprise — which means teams are choosing between cascaded pipelines, all-in-one platforms and direct provider stacks. A practical look at the latency trade-offs, the compliance realities and the business impact that should drive the decision.'
pubDate: 2026-09-02
issue: 4
tags: [voice-ai, architecture, latency, enterprise delivery, evaluation]
draft: false
---

Voice AI crossed an invisible line in the last year. The demos stopped being impressive and started being *useful*: agents that answer support calls after hours, qualify leads, triage inbound queries and hand complex cases to humans with full context. That shift moves the decision from "can we demo this?" to "which architecture should we standardise on?" — and the loudest argument in that conversation is latency.

Latency matters, but it is the wrong thing to argue about first. This issue looks at the three ways teams actually build enterprise voice agents — cascaded pipelines, all-in-one platforms like ElevenLabs, and assembling direct provider components — and what each choice really trades away.

## The latency number that matters

Before comparing vendors, decide which metric you are optimising. Total response latency is the headline, but users feel three separate things:

- **Time to first audio** — how long after the user stops speaking before the agent starts.
- **End-of-turn responsiveness** — whether the agent reacts at natural conversational speed.
- **Interruption handling** — how gracefully the agent yields when the user cuts in.

Speech-to-speech (S2S) models, where audio goes in and audio comes out of a single model, are marketed with dramatically lower latency — vendors cite figures around 200–300 ms, an ~85% reduction over naive 2-second cascaded pipelines. That comparison, though, usually pits S2S against an *unoptimised* pipeline. A well-built cascaded stack — streaming speech-to-text, an LLM that starts generating on early tokens, text-to-speech that begins speaking on the first tokens — comfortably reaches the 300–500 ms range. The *real* gap is a few hundred milliseconds, not a second and a half. ([Coval's 2026 analysis](https://www.coval.ai/blog/cascaded-voice-ai-architecture-why-enterprise-teams-choose-traditional-pipelines-over-s2s) and [Deepgram's pipeline guide](https://deepgram.com/learn/voice-agent-architecture-stt-llm-tts-pipeline-design) both walk through this in detail.)

A few hundred milliseconds decides some products and is irrelevant to others. Know which one you are before choosing an architecture for it.

## Route 1 — the all-in-one platform (ElevenLabs)

A managed conversational-AI platform gives you the whole loop: speech-to-text, the dialogue model, text-to-speech, telephony and tool calling, maintained for you. [ElevenLabs publishes detailed guidance](https://elevenlabs.io/blog/voice-agent-latency-optimization) on tuning their stack, and the pitch is honest: you trade engineering effort for a platform that is fast out of the box and produces remarkably natural voice.

**Where it wins:** speed to launch, voice quality that carries brand feel, low-latency by default, and a team that owns the hard parts of streaming audio. For a first voice deployment inside a business that needs proof before investment, it is usually the fastest credible option.

**What you give up:** control points. If the platform's output is audio-first, you have no reliable text layer where compliance checks, disclaimers and audit logging can run *before* the customer hears something. Debugging is black-box: when a call goes badly, you cannot isolate whether understanding, reasoning or synthesis failed. And the pricing model is per-minute, which becomes a real cost question at scale — more on that below.

## Route 2 — the cascaded pipeline with direct providers

The "build it yourself with the best component per stage" route: one speech-to-text provider, your own LLM orchestration, one or more text-to-speech voices. It is more engineering, and it buys the things enterprises actually get audited on.

**The text layer is the compliance feature.** Because the LLM produces text before anything is spoken, you can run PII detection and redaction, prohibited-content filtering, regulatory disclaimer injection and full audit logging *in between* — and only let approved content reach the speech engine. Regulated industries do not have a good answer for "the customer already heard it" from an audio-only model.

**Every stage is observable and replaceable.** Transcription errors, wrong answers and robotic audio each have their own logs, metrics and fix paths. You can A/B test a new voice on 10% of traffic, fail over to a secondary speech provider, or swap the language model without rebuilding the product. For 99.9%-uptime commitments, component-level redundancy is the difference between "one degraded vendor" and "one degraded call."

**The cost:** your team owns the latency budget, the streaming plumbing, the interruption logic and the evaluation harness. Getting to 300–500 ms is achievable but is real work — and poorly built cascades regress to the slow, robotic calls that gave the architecture a bad name.

## Route 3 — direct speech-to-speech providers

If your use case is genuinely latency- or emotion-critical — simultaneous interpretation, or experiences where emotional prosody *is* the product — a direct speech-to-speech model may justify the loss of control. The honest guidance is to scope it narrowly: consumer-style, low-risk, unregulated interactions, where naturalness beats auditability, and to keep the option of routing specific conversation types to a cascaded path. Treating "one fused model" as the enterprise standard today means accepting black-box debugging and immature tooling at the exact moment your compliance team asks for evidence.

## What the enterprise actually buys with each route

The decision matrix is shorter than the marketing suggests:

- **Regulated, high-stakes, or audited interactions** (financial services, healthcare, anything that records and reviews calls): cascaded pipeline, because the text intermediary is the only place you can prove what would have been said.
- **Speed to market, unregulated, brand-led experiences**: all-in-one platform, accepting the per-minute economics and the platform lock-in.
- **Very high volume, cost-sensitive**: build cascaded, because per-minute platform pricing compounds faster than your engineering time does once calls reach meaningful scale — and you can route cheap models to easy calls and escalate only what needs them.

Which brings us to the part nobody wants to talk about: **latency is rarely the expensive decision; cost per resolved call and escalation quality are.** A voice agent that answers in 250 ms but hands every third call to a human has negative business impact. One that takes 450 ms, resolves routine calls and arrives at escalations with full context pays for itself.

## Measure before you choose

Whatever route you take, instrument before launch: per-component latency (p50 *and* p95 — averages hide the calls that feel broken), transcription accuracy on *your* vocabulary, containment rate, cost per resolved interaction, and the quality of handoffs to humans. Then run the S2S-versus-cascaded comparison on a slice of real traffic rather than vendor benchmarks — because the architecture decision should be made on your calls, your accents, your compliance constraints and your cost model.

## The takeaway

- The real latency gap between a well-optimised cascaded pipeline and speech-to-speech is a few hundred milliseconds — often less important than containment, cost and compliance.
- All-in-one platforms like ElevenLabs launch fastest with excellent voice, but trade away the text-layer control that audited environments depend on.
- Cascaded, direct-provider stacks are more engineering for more control: compliance checkpoints, per-component debugging and redundancy — the reasons regulated enterprises keep choosing them.
- Reserve speech-to-speech for low-risk, latency- or emotion-critical use cases, and keep the option of routing between architectures.
- Decide on the business metrics first: time-to-resolution, cost per resolved call and escalation quality matter more than the latency benchmark in the sales deck.
