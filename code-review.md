# /code-review

Run a full code review on staged or recent changes using the code-reviewer agent.

## What It Does
1. Runs `git diff --staged` (or `git diff HEAD~1` if nothing staged)
2. Applies code-reviewer agent checklist (Security → Quality → Performance → Best Practices)
3. Returns: APPROVE / WARNING / BLOCK verdict with specific line references

## Usage
```
/code-review              # reviews staged changes
/code-review HEAD~3       # reviews last 3 commits
/code-review [file]       # reviews specific file
```
