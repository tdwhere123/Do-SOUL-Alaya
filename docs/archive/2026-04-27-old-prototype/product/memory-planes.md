# Memory Planes

SOUL Memory must model more than project-local notes. The first standalone
product needs a clear distinction between personal memory that follows the
operator and project memory that belongs to a local repo, workspace, or task
context.

## Decision

Day one includes:

- Global Personal Memory.
- Project/Local Memory.

Day one excludes:

- Shared/Cloud/Team Memory.

Shared, cloud, and team memory may become future infrastructure, but they are
not first-version product semantics. "Global" means personal and cross-context,
not hosted, synced, or shared with a team by default.

## Plane 1: Global Personal Memory

Global Personal Memory stores durable operator-level facts and preferences that
should travel across projects, repos, agents, and sessions.

Examples:

- communication preferences;
- review strictness and workflow discipline;
- recurring tool or environment constraints;
- stable personal decisions about agent behavior;
- cross-repo lessons that are not owned by one workspace;
- hazards that apply broadly, such as avoiding unverified claims.

Rules:

- it is local-first by default;
- it must have evidence or an explicit operator source;
- it can be recalled into any compatible session when relevant;
- it must not be confused with team knowledge or cloud sync;
- it can be filtered, disabled, exported, or governed separately from project
  memory.

## Plane 2: Project/Local Memory

Project/Local Memory stores durable memory tied to a repo, workspace, directory,
task line, product track, or local operator context.

Examples:

- architecture decisions;
- task-card boundaries;
- accepted review findings and fix-loop outcomes;
- project-specific commands and verification rules;
- local file/path ownership;
- repo-specific hazards and deferred issues.

Rules:

- Project/Local Memory wins over Global Personal Memory when the project has a
  more specific rule;
- every project memory must carry a project, workspace, repo, or path identity;
- migration/import must preserve local scope and evidence;
- recall must expose whether the source was local/project or global/personal.

## Plane 3: Shared/Cloud/Team Memory

Shared/Cloud/Team Memory means memory that is synced, hosted, multi-user, or
team-governed.

This is deferred because it changes the trust model:

- identity and access control become mandatory;
- conflict resolution becomes multi-actor;
- audit records need actor attribution;
- private personal preferences may leak into team context;
- hosted durability and deletion rules become product commitments.

SOUL Memory should leave room for this plane without designing the first release
around it.

## Recall Precedence

Recall should assemble both day-one planes with explicit source labels:

```text
project/local required memories
  -> global personal required memories
  -> project/local advisory memories
  -> global personal advisory memories
  -> historical/background memories
```

When memories conflict, the context pack must report the conflict rather than
silently choosing one. Specific local evidence normally outranks broad global
preference, but the explanation must state the decision.

## Product Implication

The product must let the operator answer:

1. Is this memory global or project-local?
2. Why was a Global Personal Memory used in this project?
3. Which local memories overrode or constrained global memories?
4. Can I disable, export, retire, or correct one plane without damaging the
   other?
