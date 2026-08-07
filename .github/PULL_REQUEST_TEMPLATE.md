## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] `npm run lint`, `npm run build`, and `npm test` pass (tests mock the HTTP layer, no network calls)
- [ ] Every tool is still read-only: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`, all four stated explicitly
- [ ] No write path added to `src/client.ts` — every request stays a GET, and `ids=channel==MINE` stays hardcoded rather than caller-supplied
- [ ] Any value the server computes is listed in that response's `computedFields`, with the API's own values returned beside it
- [ ] New list tools take a `limit` and default it low (responses cost agents tokens)
- [ ] README tool table and count updated if tools were added or changed
- [ ] Assertions pin exact values, not shapes, and any carve-out has a must-fail leg beside the must-pass one
- [ ] No `console.log` to stdout — diagnostics go to stderr only
