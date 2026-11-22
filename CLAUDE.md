# Project Instructions

## Web UI

- Use shadcn components from `web/src/components/ui/` for interactive controls and overlays.
- Add the official shadcn component when the required control is missing.
- Use Tailwind CSS utility classes in TSX for layout and styling.
- Do not add custom CSS classes when Tailwind utilities can express the same result.
- Reserve custom CSS for shared tokens/global foundations, third-party overrides, and behavior Tailwind cannot reasonably express.

## Commit / MR title format

All commit and MR (merge request) titles must follow this template, with the Jira ticket number always included:

```
fix|feat|refactor(<scope>) <Jira Ticket Number> Title
```

Example: `fix(assignment-report) PROJ-1234 bypass entity cache on refetch for proper change detection`

The Jira ticket number is required, not optional. If it isn't known, look it up (e.g. from the branch name or linked issue) rather than omitting it.

## MR assignment

When creating an MR, always assign it to the current user (the person authoring the change), not left unassigned or assigned to someone else.
