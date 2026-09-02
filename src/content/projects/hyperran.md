---
title: 'HyperRAN — AI optimisation for telecom networks'
shortTitle: 'HyperRAN'
summary: 'An AI-driven approach to reduce RAN energy consumption while maintaining service quality.'
context: 'Radio access networks are the largest energy consumers in a mobile operator’s estate — and most of that energy is spent serving traffic that is not there. Network utilisation swings wildly across the day, yet configuration is largely static. HyperRAN explored whether reinforcement learning could continuously adapt network configuration to live demand — cutting energy use without letting service quality slip below the thresholds that operators and regulators care about. The brief was deliberately conservative: this is a domain where a bad decision has real user impact, so the goal was a decision-support capability that network engineers could trust, evaluate and ultimately choose to delegate to.'
tag: 'Telecom network optimisation'
themes:
  - Reinforcement learning
  - Network optimisation
  - KPI forecasting
  - QoS protection
  - Stakeholder-led technical delivery
readingTime: '6 min read'
---

Telecom operators face an uncomfortable trade-off. Switch capacity down aggressively and you save energy but risk degraded service when demand spikes. Leave everything running and you waste energy through the quiet hours. The interesting middle ground is continuous, demand-aware configuration — but the control loop needs to be fast, safe and explainable enough that engineers will actually let it act.

## The problem

The optimisation problem was deceptively simple to state and hard to make safe: *find the configuration that minimises energy while keeping every quality-of-service (QoS) metric above threshold, at every point in time*. The difficulty was that the environment is non-stationary — demand moves with the day, events and weather — and the penalty for a wrong decision is real user degradation, not a failed test.

A purely reactive policy was not enough; the system needed to anticipate demand to act early, and it needed hard constraints that could never be negotiated away by an exploratory learning algorithm.

## My role

I led the technical delivery and owned the stakeholder relationship throughout. That meant defining the problem with network domain experts in terms they recognised (cells, carriers, sleep modes, KPI thresholds), designing the reinforcement-learning approach around their operational constraints, building the forecasting and simulation layers the policy needed to learn and be evaluated safely, and translating between the research team and the engineering teams who would run it.

## The approach

**Define the problem with the people who own the network.** Before any model existed, we agreed with domain experts on the control actions available (including which were operationally acceptable), the QoS thresholds that were non-negotiable, and what a *useful* recommendation looked like. This sounds like project management; it was actually the architecture. The constraint model that came out of those sessions shaped everything downstream.

**Model demand before optimising against it.** We built KPI forecasting over cell-level time series — traffic, utilisation and load patterns — so the agent could act on predicted demand rather than only reacting to what had already happened.

**Reinforcement learning with hard QoS protection.** The policy chose configuration actions against forecast demand, with QoS protection implemented as constraints and penalties that could not be traded off for energy savings. Reward design was iterative: naive rewards produced policies that looked great on energy and quietly abused the margins, which is exactly what the constraint layer existed to stop.

**Evaluate in simulation and offline before anything real.** Policies were trained and tested against realistic scenarios built with operators, then evaluated offline on historical network traces. Domain experts reviewed the agent's proposed actions cell by cell — not because they distrusted it, but because that review was the mechanism that made the approach defensible to the people accountable for the network.

## Architecture and technical themes

- **Demand forecasting:** cell-level KPI and traffic forecasting feeding the control loop.
- **Reinforcement-learning agent:** continuous configuration decisions against predicted demand, trained in a scenario-based environment.
- **QoS protection:** hard constraints and penalty shaping so energy savings could never come at the cost of service thresholds.
- **Offline evaluation:** historical-trace replay and scenario runs before any live recommendation, with expert review of proposed actions.
- **Decision-support workflow:** recommendations surfaced to engineers with the reasoning (demand, headroom, constraint margin) rather than as unexplained actions.
- **Stakeholder-led delivery:** a delivery rhythm built around operator review cycles, constraint sign-off and explainability.

## Outcomes

- The optimisation, data-processing and decision-support work contributed to an **improvement in network energy efficiency of 28% across 200+ network nodes**, per delivery reporting — analytics and tooling that gave engineers faster operational insight rather than another dashboard to ignore.
- The evaluation method itself was a deliverable: a repeatable way to compare policies against historical traces before anything touches the live network.
- Network engineers gained a decision-support capability that made the trade-offs visible: what energy could be saved, when, and at what headroom cost — instead of treating configuration as a static, once-a-day decision.
- Because actions were explainable and bounded by hard constraints, the path to a live pilot was a governance question, not a leap of faith. The conservative, expert-in-the-loop posture is what made the work credible in a domain where autonomy is earned slowly.

I have kept the outcomes deliberately qualitative: quantified savings belong to the operator's own validation and would mislead without their context.

## What I learned

- **Constraints are the product.** In any domain where failures are costly, the value of an AI system is defined by the hard boundaries around it — and those boundaries must come from the people accountable for the operation, early.
- **Forecasting quality gates everything.** The control policy is only as good as its view of the future. Investment in demand forecasting repaid itself many times over.
- **Offline evaluation is a persuasion tool.** Being able to replay a policy against historical traces — and show where it would have acted and why — was what turned sceptical domain experts into collaborators.
- **Autonomy is a ladder.** Decision support first, reviewable actions second, delegation later. Skipping rungs in domains with real-world consequences is how trust gets burned.

The takeaway: the interesting engineering in HyperRAN was never the reinforcement learning itself — it was making the learning safe, explainable and accountable enough that experts who guard a live network would take its recommendations seriously.
