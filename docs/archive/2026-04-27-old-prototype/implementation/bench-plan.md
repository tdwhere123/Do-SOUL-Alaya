# Benchmark And Market Test Plan

The product should be evaluated as an agent memory layer, not as a search tool
or GUI.

## Core Question

Does SOUL Memory make an agent perform better on real tasks after prior context
has accumulated?

## Evaluation Axes

- Fewer repeated context questions.
- Better adherence to project decisions.
- Better review findings grounded in prior constraints.
- Better continuation after interruption or time gap.
- Less hallucinated project state.
- Better recall of prior bug causes and accepted tradeoffs.
- Lower operator effort to correct bad memory.

## Benchmark Types

### Activation Comparison

Compare the same task across:

- installed but unused;
- MCP attached and used;
- Gateway forced.

This proves the product is measuring actual memory usage rather than assuming
installation equals activation.

### Coding Continuation

Agent receives a task after prior decisions and constraints were recorded.
Compare:

- without memory;
- with raw notes;
- with SOUL Memory recall/context pack.

### Review/Fix Loop

Agent reviews a change, records findings, then later fixes or re-reviews.
Measure whether it preserves exact severity, scope, and accepted decisions.

### Project Decision Recall

Agent must answer why a product/architecture decision was made and cite stored
evidence.

### False Recall Handling

Insert stale or rejected memories and verify they are not used blindly.

### User Trust Test

Ask a user to inspect what was stored, reject one memory, and confirm future
recall respects the rejection.

## Minimum Demo

The first public demo should show:

1. Run a task without SOUL Memory.
2. Record decisions and evidence into SOUL Memory.
3. Run a related task later through an MCP-connected or Gateway-launched agent.
4. Show the recalled context and explanation.
5. Open the inspector and display the stored memory, evidence, and audit trail.
6. Reject or retire one memory and prove recall changes.

## Metrics

Use both qualitative and quantitative evidence:

- task success;
- memory usage rate;
- missed required memory steps;
- number of clarification turns;
- number of incorrect assumptions;
- number of accepted review findings;
- time to useful first answer;
- false recall count;
- false recall correction rate;
- global-personal-vs-project recall usefulness;
- user trust rating after inspector review.
