Discuss milestone {{milestoneId}} ("{{milestoneTitle}}"). Investigate the codebase, identify unknowns, and write `{{milestoneId}}-CONTEXT.md` in the milestone directory. Use the **Context** output template below.

{{inlinedContext}}

{{inlinedTemplates}}

---

## Investigation Protocol

### Codebase investigation

Before writing the context file, do a thorough investigation:
- Scout the codebase (`rg`, `find`) to understand what already exists that this milestone touches or builds on
- Read existing architecture, entry points, and module boundaries relevant to this milestone
- Use `resolve_library` / `get_library_docs` for unfamiliar libraries
- Identify the biggest architectural and behavioural unknowns

### Prior context review

Review the inlined context above (if present). Pay attention to:
- **Decisions** — honour existing architectural and pattern decisions. Do not contradict them unless there is a strong reason documented in the context file.
- **Requirements** — active requirements must be addressed. Deferred requirements should be noted but not planned for.
- **Knowledge** — rules, patterns, and lessons from prior milestones inform constraints.

### What to investigate

Focus on concrete understanding, not abstract summaries:
- **What is being built** — concrete enough to explain to a stranger
- **Why it needs to exist** — the problem it solves
- **What "done" looks like** — observable outcomes, not abstract goals
- **Technical unknowns / risks** — what could fail, what hasn't been proven
- **External systems/services** — APIs, databases, third-party services this touches
- **Existing code** — what already exists that this builds on or replaces

---

## Output

Once investigation is complete:

1. Use the **Context** output template below
2. `mkdir -p` the milestone directory if needed
3. Call `wtf_summary_save` with `milestone_id: {{milestoneId}}`, `artifact_type: "CONTEXT"`, and the full context markdown as `content` — the tool writes the file to disk and persists to DB. Preserve precise terminology from the codebase and prior context. Do not paraphrase into generic summaries. The context file is downstream agents' only window into this investigation.
4. {{commitInstruction}}
5. Say exactly: `"{{milestoneId}} context written."` — nothing else.
