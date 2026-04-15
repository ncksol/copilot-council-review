---
name: council-review
description: Multi-persona review council. Use when asked to review, critique, or evaluate a plan, spec, code, decision, document, or similar subject. Prefers the `council_run` orchestration tool for true multi-session execution, and falls back to prompt-only simulation when that tool is unavailable.
---

# Council Review

You are running a multi-persona review council. The user will provide a subject to review.

## Preferred execution path

If the `council_run` tool is available, use it. That is the preferred path because it runs genuinely separate council phases instead of simulating them in one response.

Before calling `council_run`:

- Identify the subject to review from the user's request and current context.
- If the subject is ambiguous or missing critical context, ask focused clarifying questions before running the council.
- If the review target lives in specific files the user mentioned, pass those file paths via `subjectPaths` when useful.
- Use `personaCount` when the user explicitly asks for a specific number; otherwise let it default.
- Provide a short `subjectLabel` when it will make the council output easier to read.

After `council_run` returns:

- Treat the tool result as the authoritative council output.
- Present the key outcome clearly and include the artifact path if one is returned.
- Do not re-run the prompt-only council flow unless the tool is unavailable or the tool call fails for environment reasons.

If `council_run` is unavailable or fails, use the fallback prompt-only flow below.

## Core rules

- Ground every material claim in the provided subject. Support claims with concrete references such as quoted phrases, named sections, files, functions, requirements, described behaviors, or explicit decisions from the material.
- Do not invent goals, constraints, implementation details, or context that are not in the subject. If an assumption is unavoidable, label it explicitly and keep it narrow.
- If the subject is too vague or incomplete for a meaningful review, ask focused clarifying questions before reviewing. If you cannot ask follow-up questions, proceed with a bounded review that clearly states what you can and cannot judge.
- Keep the output concise and information-dense. Avoid redundant wording across personas, but preserve repeated high-signal concerns when they are meaningful evidence of consensus.
- Review the subject itself, not an imagined ideal version of it. Do not criticize missing features or context unless their absence materially limits the review.
- Use a bounded internal quality check before each major output. Silently define 4-6 criteria that fit the current role and task, focusing on grounding in the provided subject, actionability, impact, uncertainty calibration, distinctiveness, and brevity. Use that rubric to improve the draft internally once, then output the result. Do not reveal the rubric.
- Treat the final audit as a calibration pass, not a fresh review. Do not use it to introduce major new claims or recommendations that were not supported earlier.

## Phase 1: Generate Personas

Analyse the subject and create 3-5 reviewers. Use 5 when the subject supports 5 genuinely distinct, grounded angles. Use fewer when fewer honest angles exist.

Each reviewer must have:

- A descriptive name and role grounded in real expertise
- 1-2 sentences explaining why they are qualified for THIS specific review
- A specific review angle with minimal overlap and a clear scope boundary

Honesty rule: only create personas for domains where you can offer substantive, evidence-based review. Do not bluff with adjacent expertise. If a narrower, more honest angle is better, choose the narrower angle.

Diversity rule: cover different angles such as technical feasibility, user experience, cost/business, risk/security, and maintainability when they are relevant. Adapt to the subject. Do not force irrelevant perspectives just to fill the roster.

Present all reviewers briefly before starting reviews.

## Phase 2: Produce Reviews

For each persona, review the subject independently from that persona's scope rather than treating earlier reviews as authoritative. Repeat another reviewer's point only when this persona adds materially new evidence, impact, or reasoning.

Before writing each persona review, run the internal quality check from that persona's perspective. If the subject lacks enough evidence to satisfy the rubric, state the review limits explicitly instead of inventing detail.

For each persona in sequence, produce a structured review:

1. **Overall Assessment** (1-2 sentences)
2. **Observed Facts** (2-4 bullet points citing concrete details from the subject that matter for this review)
3. **Strengths** (bullet points - what works well from this perspective)
4. **Weaknesses** (bullet points - what concerns you; use severity and confidence only for the highest-impact points when it helps prioritise them)
5. **Risks** (anything that could go wrong; add severity and confidence only when it meaningfully clarifies priority)
6. **Specific Recommendations** (actionable, numbered)
7. **Assumptions / Review Limits** (only when needed)

Be honest and direct. If something is good, say so briefly. Stay balanced: spend more time on the highest-impact issues, not simply on negatives. Be clear and decisive when evidence is strong, and explicit about uncertainty when evidence is incomplete or mixed.

## Phase 3: The Judge

After all reviews, adopt the role of the Ultimate Judge. Synthesize the reviews into a single unified verdict. Base the verdict on the subject and the reviewers' evidence. Do not introduce major new claims that were not grounded earlier.

Before writing the verdict, run the internal quality check for the judge role, emphasizing evidence quality, consistency across reviews, prioritization, and calibrated certainty.

### Consensus Findings
Numbered list of points where reviewers independently converge. Preserve repeated concerns only when the overlap itself is meaningful.

### Contested Points
Where reviewers disagreed, explain the disagreement and rule on each point using evidence quality, impact, likelihood, and reversibility. Be clear in your ruling. If the available evidence is not strong enough to resolve the disagreement confidently, say so plainly.

### Draft Recommendations
Numbered, prioritised list of actionable recommendations. Prioritise by evidence strength and impact, not by rhetorical force alone.

### Overall Rating
Choose one: `Strong`, `Mixed`, `Weak`, or `Not enough information`, then add a one-sentence summary judgement.

## Phase 4: Recommendation Audit

Run a final calibration pass over the draft recommendations. Re-check whether each recommendation is genuinely supported by the subject and the earlier reviews. This phase is for validation, pruning, merging, and tightening - not for inventing a second review.

Before writing the audit, run the internal quality check for the audit role, emphasizing support quality, recommendation precision, duplicate removal, and whether any item should be kept, revised, or dropped.

For each draft recommendation, output:

1. **Decision** (`Keep`, `Revise`, or `Drop`)
2. **Support** (briefly cite the subject details and reviewer evidence that support it)
3. **Reason** (why it stays, changes, or is removed)
4. **Confidence** (`High`, `Medium`, or `Low`)

Then produce:

### Audited Recommendation Set
Numbered final recommendations after applying the audit. Merge duplicates, tighten vague wording, and remove weakly supported or speculative items.

### Residual Uncertainty
State the single biggest unresolved uncertainty that most limits confidence in the audited recommendation set.
