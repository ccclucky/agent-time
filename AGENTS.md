# Agent Guidelines

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for this repo (`ccclucky/agent-time`). See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses five canonical roles mapped to labels on GitHub Issues. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo layout. See `docs/agents/domain.md`.

## Release Guidelines & PR Requirements

This project uses an automated release pipeline with a single human gate (clicking "Publish release" in GitHub Releases). All release notes and version context must be captured upfront in Pull Requests.

### PR Description Standard

Whenever an Agent or contributor opens a Pull Request that introduces changes intended for a release (features, fixes, performance, docs), the PR description MUST include a structured `### Release Notes` section:

```markdown
## Summary
<!-- 1-2 sentence description of what this PR accomplishes -->

### Release Notes
- feat: <concise summary of new user-facing functionality>
- fix: <concise summary of bug fix and impact>

### SemVer Recommendation
<!-- patch | minor | major (default: patch) -->
```

### Rules for Release Notes
1. **User-facing perspective**: Describe what users or integrations will observe, not internal function names or refactoring minutiae.
2. **Explicit types**: Prefix each note with conventional types (`feat:`, `fix:`, `perf:`, `docs:`, `chore:`).
3. **Internal/Non-release changes**: If the PR contains no changes that warrant a public release note (e.g. CI test tweaks), write:
   ```markdown
   ### Release Notes
   None
   ```
4. **Draft Release Aggregation**: Upon merging into `main`, GitHub Actions automatically parses the `### Release Notes` block and appends it to the pending GitHub Draft Release. When the maintainer clicks "Publish release", the accumulated release notes are published directly to npmjs and GitHub Releases with zero manual editing.
