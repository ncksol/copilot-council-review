import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CopilotClient, approveAll } from "@github/copilot-sdk";

const DEFAULT_PERSONA_COUNT = 5;
const MIN_PERSONA_COUNT = 2;
const MAX_PERSONA_COUNT = 8;
const DEFAULT_MAX_FILE_CHARS = 16000;
const DEFAULT_MAX_TOTAL_CHARS = 64000;
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

const runtimeState = {
    cwd: process.cwd(),
};

const extensionSessionId = process.env.SESSION_ID;
if (!extensionSessionId) {
    throw new Error(
        "council-orchestrator must run as a Copilot CLI extension child process.",
    );
}

const childClient = new CopilotClient({ isChildProcess: true });
const defaultExtensionPermissionHandler = () => ({ kind: "no-result" });

const session = await childClient.resumeSession(extensionSessionId, {
    onPermissionRequest: defaultExtensionPermissionHandler,
    disableResume: true,
    hooks: {
        onSessionStart: async (input) => {
            runtimeState.cwd = input.cwd;
        },
        onUserPromptSubmitted: async (input) => {
            runtimeState.cwd = input.cwd;
        },
    },
    commands: [
        {
            name: "council",
            description: "Run a true multi-session council review: /council [personaCount] <subject>",
            handler: async (context) => {
                const parsed = parseCouncilCommand(context.args);
                if (!parsed) {
                    await session.log(
                        "Usage: /council [personaCount] <subject>",
                        { level: "warning" },
                    );
                    return;
                }

                const result = await runCouncil(parsed, { source: "command" });
                await session.log(result.textResultForLlm, {
                    level: result.resultType === "success" ? "info" : "error",
                });
            },
        },
    ],
    tools: [
        {
            name: "council_run",
            description:
                "Run a true multi-session council review using separate Copilot sessions for persona generation, parallel reviewers, judge synthesis, and recommendation audit.",
            parameters: {
                type: "object",
                properties: {
                    subject: {
                        type: "string",
                        description: "Direct subject text to review.",
                    },
                    subjectPaths: {
                        type: "array",
                        description:
                            "Optional file paths to include in the review packet, relative to the current working directory unless workingDirectory is provided.",
                        items: {
                            type: "string",
                        },
                    },
                    subjectLabel: {
                        type: "string",
                        description:
                            "Short label used in the council run title and artifact file.",
                    },
                    personaCount: {
                        type: "integer",
                        description: "Requested reviewer count.",
                        minimum: MIN_PERSONA_COUNT,
                        maximum: MAX_PERSONA_COUNT,
                        default: DEFAULT_PERSONA_COUNT,
                    },
                    reviewLimits: {
                        type: "array",
                        description:
                            "Optional known limitations or missing context to pass to every phase.",
                        items: {
                            type: "string",
                        },
                    },
                    model: {
                        type: "string",
                        description:
                            "Optional model identifier. Defaults to the current model in the foreground session.",
                    },
                    reasoningEffort: {
                        type: "string",
                        description: "Optional reasoning effort for spawned sessions.",
                        enum: ["low", "medium", "high", "xhigh"],
                    },
                    workingDirectory: {
                        type: "string",
                        description:
                            "Optional working directory for resolving subjectPaths and for spawned sessions.",
                    },
                    artifactPath: {
                        type: "string",
                        description:
                            "Optional markdown artifact file path. If omitted, the extension writes into the session workspace.",
                    },
                },
            },
            handler: async (args) => runCouncil(args, { source: "tool" }),
        },
    ],
});

function parseCouncilCommand(rawArgs) {
    const trimmed = String(rawArgs || "").trim();
    if (!trimmed) {
        return null;
    }

    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) {
        return {
            subject: trimmed,
            personaCount: DEFAULT_PERSONA_COUNT,
        };
    }

    return {
        subject: match[2].trim(),
        personaCount: clampNumber(
            Number.parseInt(match[1], 10),
            MIN_PERSONA_COUNT,
            MAX_PERSONA_COUNT,
            DEFAULT_PERSONA_COUNT,
        ),
    };
}

async function runCouncil(rawArgs, { source }) {
    const args = normalizeArgs(rawArgs);
    const cwd = resolveWorkingDirectory(args.workingDirectory);
    const currentModel = args.model || await getCurrentModel();
    const startedAt = new Date().toISOString();

    try {
        const subjectBundle = await buildSubjectBundle(args, cwd);
        await session.log(
            `Council: preparing ${args.personaCount} reviewer slots for "${subjectBundle.label}"`,
            { ephemeral: true },
        );

        const councilRunId = shortId();
        const personaEnvelope = await generatePersonas(childClient, {
            councilRunId,
            cwd,
            model: currentModel,
            reasoningEffort: args.reasoningEffort,
            personaCount: args.personaCount,
            subjectBundle,
        });

        const personas = personaEnvelope.personas;
        const inheritedLimits = dedupeStrings([
            ...subjectBundle.reviewLimits,
            ...personaEnvelope.globalReviewLimits,
        ]);

        if (personas.length < MIN_PERSONA_COUNT) {
            throw new Error(
                `Persona generation produced only ${personas.length} grounded reviewers; need at least ${MIN_PERSONA_COUNT}.`,
            );
        }

        await session.log(
            `Council: spawned ${personas.length} grounded reviewers`,
            { ephemeral: true },
        );

        const reviewerResults = await Promise.all(
            personas.map((persona, index) =>
                runReviewer(childClient, {
                    councilRunId,
                    cwd,
                    model: currentModel,
                    reasoningEffort: args.reasoningEffort,
                    persona,
                    subjectBundle,
                    inheritedLimits,
                    index,
                    total: personas.length,
                }),
            ),
        );

        const successfulReviews = reviewerResults.filter((result) => result.ok);
        if (successfulReviews.length < MIN_PERSONA_COUNT) {
            const artifactPath = await writeArtifact(
                args,
                cwd,
                buildArtifact({
                    startedAt,
                    source,
                    subjectBundle,
                    currentModel,
                    requestedPersonaCount: args.personaCount,
                    personas,
                    reviewerResults,
                    judgeVerdict: null,
                    judgeError:
                        "Judge phase skipped because fewer than two reviewer sessions succeeded.",
                    auditVerdict: null,
                    auditError:
                        "Recommendation audit skipped because the judge phase did not run.",
                    finalReviewLimits: inheritedLimits,
                }),
            );

            return failureResult(
                [
                    `Council orchestration failed for "${subjectBundle.label}".`,
                    `Reviewer sessions succeeded: ${successfulReviews.length}/${personas.length}.`,
                    `Need at least ${MIN_PERSONA_COUNT} successful reviewers to continue.`,
                    `Artifact: ${artifactPath}`,
                ].join("\n"),
            );
        }

        let judgeVerdict = null;
        let judgeError = null;

        try {
            judgeVerdict = await runJudge(childClient, {
                councilRunId,
                cwd,
                model: currentModel,
                reasoningEffort: args.reasoningEffort,
                subjectBundle,
                inheritedLimits,
                successfulReviews,
            });
            await session.log("Council: judge synthesis complete", {
                ephemeral: true,
            });
        } catch (error) {
            judgeError = toErrorMessage(error);
            const artifactPath = await writeArtifact(
                args,
                cwd,
                buildArtifact({
                    startedAt,
                    source,
                    subjectBundle,
                    currentModel,
                    requestedPersonaCount: args.personaCount,
                    personas,
                    reviewerResults,
                    judgeVerdict: null,
                    judgeError,
                    auditVerdict: null,
                    auditError:
                        "Recommendation audit skipped because the judge phase failed.",
                    finalReviewLimits: inheritedLimits,
                }),
            );

            return failureResult(
                [
                    `Council orchestration stopped during the judge phase for "${subjectBundle.label}".`,
                    `Judge error: ${judgeError}`,
                    `Artifact: ${artifactPath}`,
                ].join("\n"),
            );
        }

        let auditVerdict = null;
        let auditError = null;

        try {
            auditVerdict = await runAudit(childClient, {
                councilRunId,
                cwd,
                model: currentModel,
                reasoningEffort: args.reasoningEffort,
                subjectBundle,
                inheritedLimits,
                successfulReviews,
                judgeVerdict,
            });
            await session.log("Council: recommendation audit complete", {
                ephemeral: true,
            });
        } catch (error) {
            auditError = toErrorMessage(error);
        }

        const artifactPath = await writeArtifact(
            args,
            cwd,
            buildArtifact({
                startedAt,
                source,
                subjectBundle,
                currentModel,
                requestedPersonaCount: args.personaCount,
                personas,
                reviewerResults,
                judgeVerdict,
                judgeError,
                auditVerdict,
                auditError,
                finalReviewLimits: inheritedLimits,
            }),
        );

        if (auditError) {
            return failureResult(
                [
                    `Council orchestration reached the recommendation-audit phase but failed to finish for "${subjectBundle.label}".`,
                    `Judge status: completed.`,
                    `Audit error: ${auditError}`,
                    `Artifact: ${artifactPath}`,
                ].join("\n"),
            );
        }

        return successResult(
            buildSummary({
                artifactPath,
                subjectBundle,
                requestedPersonaCount: args.personaCount,
                personas,
                reviewerResults,
                judgeVerdict,
                judgeError,
                auditVerdict,
            }),
        );
    } catch (error) {
        return failureResult(
            `Council orchestration failed: ${toErrorMessage(error)}`,
        );
    }
}

function normalizeArgs(rawArgs) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    return {
        subject: normalizeOptionalString(args.subject),
        subjectPaths: normalizeStringArray(args.subjectPaths),
        subjectLabel: normalizeOptionalString(args.subjectLabel),
        personaCount: clampNumber(
            Number(args.personaCount),
            MIN_PERSONA_COUNT,
            MAX_PERSONA_COUNT,
            DEFAULT_PERSONA_COUNT,
        ),
        reviewLimits: normalizeStringArray(args.reviewLimits),
        model: normalizeOptionalString(args.model),
        reasoningEffort: normalizeReasoningEffort(args.reasoningEffort),
        workingDirectory: normalizeOptionalString(args.workingDirectory),
        artifactPath: normalizeOptionalString(args.artifactPath),
    };
}

function normalizeOptionalString(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}

function normalizeStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) => String(item || "").trim())
        .filter(Boolean);
}

function normalizeReasoningEffort(value) {
    const candidate = String(value || "").trim();
    return ["low", "medium", "high", "xhigh"].includes(candidate)
        ? candidate
        : undefined;
}

function resolveWorkingDirectory(override) {
    const base = runtimeState.cwd || process.cwd();
    if (!override) {
        return base;
    }
    return path.resolve(base, override);
}

async function getCurrentModel() {
    try {
        const result = await session.rpc.model.getCurrent();
        return result?.modelId || undefined;
    } catch {
        return undefined;
    }
}

async function buildSubjectBundle(args, cwd) {
    const reviewLimits = dedupeStrings([...args.reviewLimits]);
    const sections = [];
    let remainingBudget = DEFAULT_MAX_TOTAL_CHARS;

    if (args.subject) {
        const trimmed = trimToLimit(args.subject, Math.min(remainingBudget, DEFAULT_MAX_TOTAL_CHARS));
        sections.push(["## Direct Subject", trimmed.text].join("\n\n"));
        remainingBudget -= trimmed.text.length;
        if (trimmed.truncated) {
            reviewLimits.push(
                `The direct subject text was truncated to ${trimmed.text.length} characters to stay within the council packet budget.`,
            );
        }
    }

    const fileEntries = [];
    for (const rawPath of args.subjectPaths) {
        const resolvedPath = path.resolve(cwd, rawPath);
        const stat = await fs.stat(resolvedPath);
        if (!stat.isFile()) {
            throw new Error(`Subject path is not a file: ${rawPath}`);
        }

        const fileText = await fs.readFile(resolvedPath, "utf8");
        const budgetForFile = Math.max(
            Math.min(DEFAULT_MAX_FILE_CHARS, remainingBudget),
            0,
        );

        if (budgetForFile === 0) {
            reviewLimits.push(
                `File omitted from the council packet due to prompt budget limits: ${rawPath}`,
            );
            continue;
        }

        const trimmed = trimToLimit(fileText, budgetForFile);
        if (trimmed.truncated) {
            reviewLimits.push(
                `File content was truncated for council review: ${rawPath}`,
            );
        }

        remainingBudget -= trimmed.text.length;
        fileEntries.push({
            path: rawPath,
            resolvedPath,
            content: trimmed.text,
        });
        sections.push(
            [
                `## File: ${rawPath}`,
                "```text",
                trimmed.text,
                "```",
            ].join("\n"),
        );
    }

    if (sections.length === 0) {
        throw new Error(
            "Council run requires either direct subject text or at least one subject file path.",
        );
    }

    const label = args.subjectLabel
        || deriveLabel(args.subject, args.subjectPaths)
        || "Council subject";

    return {
        label,
        packet: sections.join("\n\n"),
        reviewLimits,
        fileEntries,
        hasDirectSubject: Boolean(args.subject),
    };
}

async function generatePersonas(client, options) {
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const raw = await runDynamicAgent(client, {
            cwd: options.cwd,
            model: options.model,
            reasoningEffort: options.reasoningEffort,
            agentName: `council-persona-generator-${options.councilRunId}-${attempt}`,
            agentPrompt: personaGeneratorPrompt(),
            userPrompt: personaGeneratorUserPrompt(options),
        });

        try {
            return parsePersonaEnvelope(raw, options.personaCount);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("Persona generation failed");
}

async function runReviewer(client, options) {
    const persona = options.persona;
    try {
        const content = await runDynamicAgent(client, {
            cwd: options.cwd,
            model: options.model,
            reasoningEffort: options.reasoningEffort,
            agentName: `council-reviewer-${options.councilRunId}-${slugify(persona.name)}-${options.index + 1}`,
            agentPrompt: reviewerPrompt(persona),
            userPrompt: reviewerUserPrompt(options.subjectBundle, options.inheritedLimits),
        });

        await session.log(
            `Council reviewer ${options.index + 1}/${options.total} complete: ${persona.name}`,
            { ephemeral: true },
        );

        return {
            ok: true,
            persona,
            content,
        };
    } catch (error) {
        const message = toErrorMessage(error);
        await session.log(
            `Council reviewer failed: ${persona.name} — ${message}`,
            { level: "warning" },
        );
        return {
            ok: false,
            persona,
            error: message,
        };
    }
}

async function runJudge(client, options) {
    return runDynamicAgent(client, {
        cwd: options.cwd,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        agentName: `council-judge-${options.councilRunId}`,
        agentPrompt: judgePrompt(),
        userPrompt: judgeUserPrompt(options),
    });
}

async function runAudit(client, options) {
    return runDynamicAgent(client, {
        cwd: options.cwd,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        agentName: `council-audit-${options.councilRunId}`,
        agentPrompt: auditPrompt(),
        userPrompt: auditUserPrompt(options),
    });
}

async function runDynamicAgent(client, options) {
    const councilSession = await client.createSession({
        clientName: "council-orchestrator",
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        workingDirectory: options.cwd,
        streaming: false,
        infiniteSessions: { enabled: false },
        availableTools: [],
        skillDirectories: [],
        onPermissionRequest: approveAll,
        customAgents: [
            {
                name: options.agentName,
                displayName: options.agentName,
                description: "Dynamic council phase agent",
                prompt: options.agentPrompt,
                tools: [],
            },
        ],
        agent: options.agentName,
    });

    try {
        const response = await councilSession.sendAndWait(
            { prompt: options.userPrompt },
            AGENT_TIMEOUT_MS,
        );
        const content = String(response?.data?.content || "").trim();
        if (!content) {
            throw new Error(`No response returned by ${options.agentName}`);
        }
        return content;
    } finally {
        await councilSession.disconnect();
    }
}

function personaGeneratorPrompt() {
    return [
        "You generate grounded reviewer personas for a multi-agent council review.",
        "Return only valid JSON. No markdown, no code fences, no prose outside the JSON object.",
        "Your JSON must match this schema exactly:",
        "{",
        '  "personas": [',
        "    {",
        '      "id": "short-stable-id",',
        '      "name": "reviewer name",',
        '      "role": "reviewer role",',
        '      "background": "1-2 sentence qualification for this specific review",',
        '      "reviewAngle": "distinct review angle",',
        '      "scopeBoundary": "clear in-scope boundary that minimizes overlap"',
        "    }",
        "  ],",
        '  "globalReviewLimits": ["optional shared limit", "optional shared limit"]',
        "}",
        "Rules:",
        `- Aim for the requested persona count, but return fewer if additional personas would force bluffing or fake distinction. Never return fewer than ${MIN_PERSONA_COUNT} unless the subject is too narrow to support that many grounded roles.`,
        "- Only create roles where you can provide substantive, evidence-based review.",
        "- Prefer narrower honest scopes over inflated expertise claims.",
        "- Cover distinct angles such as feasibility, UX, business impact, risk/security, and maintainability when they are relevant.",
    ].join("\n");
}

function personaGeneratorUserPrompt(options) {
    return [
        `Requested reviewer count: ${options.personaCount}`,
        `Subject label: ${options.subjectBundle.label}`,
        "",
        "Known review limits:",
        bulletList(options.subjectBundle.reviewLimits),
        "",
        "Subject packet:",
        options.subjectBundle.packet,
    ].join("\n");
}

function reviewerPrompt(persona) {
    return [
        `You are ${persona.name}, ${persona.role}.`,
        persona.background,
        "",
        "You are one independent reviewer in a council workflow.",
        "Stay within your assigned angle and scope. Do not drift into unrelated perspectives.",
        "",
        `Review angle: ${persona.reviewAngle}`,
        `Scope boundary: ${persona.scopeBoundary}`,
        "",
        "Before writing, silently define 4-6 quality criteria for this role focused on grounding, actionability, impact, uncertainty calibration, distinctiveness, and brevity. Use that rubric to improve the draft internally once. Do not reveal the rubric.",
        "Ground every material claim in the provided subject packet.",
        "Do not invent goals, constraints, implementation details, or unstated context.",
        "If the evidence is too thin for a confident claim, say so in Assumptions / Review Limits instead of inventing detail.",
        "",
        "Produce this exact structure in markdown:",
        "1. **Overall Assessment** (1-2 sentences)",
        "2. **Observed Facts** (2-4 bullet points citing concrete details from the subject packet)",
        "3. **Strengths** (bullet points)",
        "4. **Weaknesses** (bullet points; use severity and confidence only for the highest-impact points)",
        "5. **Risks** (bullet points; add severity and confidence only when it genuinely helps prioritisation)",
        "6. **Specific Recommendations** (actionable, numbered)",
        "7. **Assumptions / Review Limits** (only when needed)",
        "",
        "Be honest and direct. Stay balanced: spend more time on the highest-impact issues, not simply on negatives. Be clear when evidence is strong, and explicit about uncertainty when evidence is mixed or incomplete.",
    ].join("\n");
}

function reviewerUserPrompt(subjectBundle, reviewLimits) {
    return [
        `Subject label: ${subjectBundle.label}`,
        "",
        "Known review limits:",
        bulletList(reviewLimits),
        "",
        "Subject packet:",
        subjectBundle.packet,
    ].join("\n");
}

function judgePrompt() {
    return [
        "You are the Ultimate Judge for a council review.",
        "Your job is to synthesize independent reviewer outputs into one grounded verdict.",
        "Do not introduce major new claims unsupported by the original subject or the reviewer evidence.",
        "Before writing, silently define 4-6 quality criteria focused on evidence quality, consistency across reviews, prioritization, clarity, and calibrated certainty. Use that rubric to improve the draft internally once. Do not reveal the rubric.",
        "",
        "Produce markdown using this exact structure:",
        "## Unified Verdict",
        "",
        "### Consensus Findings",
        "[numbered list of points where reviewers independently converge; preserve repeated concerns only when the overlap itself is meaningful]",
        "",
        "### Contested Points",
        "[where reviewers disagreed, and your ruling on each. Use evidence quality, impact, likelihood, and reversibility. If evidence is insufficient to rule confidently, say so plainly.]",
        "",
        "### Draft Recommendations",
        "[numbered, prioritised list of actionable recommendations. Prioritise by evidence strength and impact, not rhetorical force.]",
        "",
        "### Overall Rating",
        "[choose one: Strong, Mixed, Weak, or Not enough information, then add a one-sentence summary judgement]",
    ].join("\n");
}

function judgeUserPrompt(options) {
    return [
        `Subject label: ${options.subjectBundle.label}`,
        "",
        "Known review limits:",
        bulletList(options.inheritedLimits),
        "",
        "Original subject packet:",
        options.subjectBundle.packet,
        "",
        "Reviewer outputs:",
        options.successfulReviews
            .map(
                (review, index) => [
                    `### Reviewer ${index + 1}: ${review.persona.name} — ${review.persona.role}`,
                    `- Angle: ${review.persona.reviewAngle}`,
                    `- Scope boundary: ${review.persona.scopeBoundary}`,
                    "",
                    review.content,
                ].join("\n"),
            )
            .join("\n\n"),
    ].join("\n");
}

function auditPrompt() {
    return [
        "You are the recommendation auditor for a council review.",
        "This is not a fresh review.",
        "Use only the original subject packet, reviewer outputs, and the Judge verdict.",
        "Do not introduce major new claims unsupported by that material.",
        "Before writing, silently define 4-6 quality criteria focused on support quality, recommendation precision, duplicate removal, and whether each draft recommendation should be kept, revised, or dropped. Use that rubric to improve the draft internally once. Do not reveal the rubric.",
        "",
        "For each Draft Recommendation from the Judge verdict, output one subsection using this structure:",
        "### Recommendation N: [short restatement of the draft recommendation]",
        "1. **Decision** (`Keep`, `Revise`, or `Drop`)",
        "2. **Support** (briefly cite the subject details and reviewer evidence that support it)",
        "3. **Reason** (why it stays, changes, or is removed)",
        "4. **Confidence** (`High`, `Medium`, or `Low`)",
        "",
        "Then produce:",
        "### Audited Recommendation Set",
        "[numbered final recommendations after applying the audit. Merge duplicates, tighten vague wording, and remove weakly supported or speculative items.]",
        "",
        "## Residual Uncertainty",
        "[single biggest unresolved uncertainty limiting confidence]",
    ].join("\n");
}

function auditUserPrompt(options) {
    return [
        `Subject label: ${options.subjectBundle.label}`,
        "",
        "Known review limits:",
        bulletList(options.inheritedLimits),
        "",
        "Original subject packet:",
        options.subjectBundle.packet,
        "",
        "Reviewer outputs:",
        options.successfulReviews
            .map(
                (review, index) => [
                    `### Reviewer ${index + 1}: ${review.persona.name} — ${review.persona.role}`,
                    review.content,
                ].join("\n\n"),
            )
            .join("\n\n"),
        "",
        "Judge verdict:",
        options.judgeVerdict,
    ].join("\n");
}

function parsePersonaEnvelope(rawText, requestedCount) {
    const parsed = extractJsonValue(rawText);
    const root = Array.isArray(parsed) ? { personas: parsed } : parsed;
    if (!root || typeof root !== "object") {
        throw new Error("Persona generator did not return a JSON object.");
    }

    const personas = Array.isArray(root.personas) ? root.personas : [];
    const globalReviewLimits = normalizeStringArray(root.globalReviewLimits);

    const normalized = personas
        .map((persona, index) => normalizePersona(persona, index))
        .filter(Boolean);

    if (normalized.length === 0) {
        throw new Error("Persona generator returned zero usable personas.");
    }

    if (normalized.length > requestedCount) {
        normalized.length = requestedCount;
    }

    return {
        personas: normalized,
        globalReviewLimits,
    };
}

function normalizePersona(persona, index) {
    if (!persona || typeof persona !== "object") {
        return null;
    }

    const name = normalizeOptionalString(persona.name);
    const role = normalizeOptionalString(persona.role);
    const background = normalizeOptionalString(persona.background);
    const reviewAngle = normalizeOptionalString(persona.reviewAngle || persona.angle);
    const scopeBoundary = normalizeOptionalString(persona.scopeBoundary);

    if (!name || !role || !background || !reviewAngle || !scopeBoundary) {
        return null;
    }

    return {
        id: normalizeOptionalString(persona.id) || `p${index + 1}`,
        name,
        role,
        background,
        reviewAngle,
        scopeBoundary,
    };
}

function extractJsonValue(rawText) {
    const cleaned = stripCodeFence(String(rawText || "").trim());
    try {
        return JSON.parse(cleaned);
    } catch {
        const startObject = cleaned.indexOf("{");
        const endObject = cleaned.lastIndexOf("}");
        if (startObject !== -1 && endObject !== -1 && endObject > startObject) {
            return JSON.parse(cleaned.slice(startObject, endObject + 1));
        }

        const startArray = cleaned.indexOf("[");
        const endArray = cleaned.lastIndexOf("]");
        if (startArray !== -1 && endArray !== -1 && endArray > startArray) {
            return JSON.parse(cleaned.slice(startArray, endArray + 1));
        }
        throw new Error("Could not extract valid JSON from persona generator output.");
    }
}

function stripCodeFence(text) {
    if (!text.startsWith("```")) {
        return text;
    }
    return text
        .replace(/^```[a-zA-Z0-9_-]*\n?/, "")
        .replace(/\n?```$/, "")
        .trim();
}

async function writeArtifact(args, cwd, content) {
    const artifactPath = args.artifactPath
        ? path.resolve(cwd, args.artifactPath)
        : await defaultArtifactPath(cwd);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, content, "utf8");
    return artifactPath;
}

async function defaultArtifactPath(cwd) {
    const artifactDir = session.workspacePath
        ? path.join(session.workspacePath, "files", "council-runs")
        : path.join(os.tmpdir(), "copilot-council-runs");
    await fs.mkdir(artifactDir, { recursive: true });
    return path.join(
        artifactDir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-council-run.md`,
    );
}

function buildArtifact({
    startedAt,
    source,
    subjectBundle,
    currentModel,
    requestedPersonaCount,
    personas,
    reviewerResults,
    judgeVerdict,
    judgeError,
    auditVerdict,
    auditError,
    finalReviewLimits,
}) {
    return [
        `# Council Run: ${subjectBundle.label}`,
        "",
        "## Metadata",
        `- Started at: ${startedAt}`,
        `- Trigger source: ${source}`,
        `- Model: ${currentModel || "default"}`,
        `- Requested reviewer count: ${requestedPersonaCount}`,
        `- Actual reviewer count: ${personas.length}`,
        "",
        "## Review Limits",
        bulletList(finalReviewLimits),
        "",
        "## Persona Roster",
        personas
            .map(
                (persona, index) => [
                    `${index + 1}. **${persona.name}** — ${persona.role}`,
                    `   - Angle: ${persona.reviewAngle}`,
                    `   - Scope boundary: ${persona.scopeBoundary}`,
                    `   - Background: ${persona.background}`,
                ].join("\n"),
            )
            .join("\n"),
        "",
        "## Reviewer Outputs",
        reviewerResults
            .map((result, index) => {
                if (result.ok) {
                    return [
                        `### Reviewer ${index + 1}: ${result.persona.name}`,
                        result.content,
                    ].join("\n\n");
                }

                return [
                    `### Reviewer ${index + 1}: ${result.persona.name}`,
                    `Failed: ${result.error}`,
                ].join("\n\n");
            })
            .join("\n\n"),
        "",
        "## Judge Verdict",
        judgeVerdict || `Judge failed: ${judgeError || "No judge verdict returned."}`,
        "",
        "## Recommendation Audit",
        auditVerdict || `Recommendation audit failed: ${auditError || "No audit verdict returned."}`,
        "",
    ].join("\n");
}

function buildSummary({
    artifactPath,
    subjectBundle,
    requestedPersonaCount,
    personas,
    reviewerResults,
    judgeVerdict,
    judgeError,
    auditVerdict,
}) {
    const successfulReviews = reviewerResults.filter((result) => result.ok);

    return [
        `Council orchestration completed for "${subjectBundle.label}".`,
        `Artifact: ${artifactPath}`,
        `Requested reviewers: ${requestedPersonaCount}`,
        `Actual grounded reviewers: ${personas.length}`,
        `Successful reviewer sessions: ${successfulReviews.length}/${personas.length}`,
        "",
        "## Persona Roster",
        personas
            .map(
                (persona, index) =>
                    `${index + 1}. **${persona.name}** — ${persona.role} | Angle: ${persona.reviewAngle}`,
            )
            .join("\n"),
        "",
        "## Judge Verdict",
        judgeVerdict || `Judge failed: ${judgeError || "No verdict returned."}`,
        "",
        "## Recommendation Audit",
        auditVerdict || "Recommendation audit missing.",
    ].join("\n");
}

function successResult(textResultForLlm) {
    return {
        textResultForLlm,
        resultType: "success",
    };
}

function failureResult(textResultForLlm) {
    return {
        textResultForLlm,
        resultType: "failure",
    };
}

function trimToLimit(text, maxChars) {
    const input = String(text || "");
    if (maxChars <= 0 || input.length <= maxChars) {
        return {
            text: input,
            truncated: false,
        };
    }

    const marker = `\n\n[Truncated ${input.length - maxChars} additional characters for council review]`;
    const sliceLength = Math.max(maxChars - marker.length, 0);
    return {
        text: input.slice(0, sliceLength) + marker,
        truncated: true,
    };
}

function deriveLabel(subject, subjectPaths) {
    if (subject) {
        return compactWhitespace(subject).slice(0, 72);
    }
    if (subjectPaths.length > 0) {
        return subjectPaths.join(", ").slice(0, 72);
    }
    return "Council subject";
}

function compactWhitespace(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
}

function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

function bulletList(items) {
    const normalized = dedupeStrings(items);
    if (normalized.length === 0) {
        return "- None noted";
    }
    return normalized.map((item) => `- ${item}`).join("\n");
}

function dedupeStrings(items) {
    return [...new Set(normalizeStringArray(items))];
}

function toErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error || "Unknown error");
}

function slugify(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32)
        || "agent";
}

function shortId() {
    return randomUUID().slice(0, 8);
}
