# Instagram Public Comment Discovery

Best-effort Apify Actor for `#2`: start from a single Instagram username, resolve the public target profile, inspect directly reachable recent public post surfaces, and return matched public comments authored by that target.

## Current scope

- Public-only
- Username-only input
- Comments only
- Exact username matching on visible public comment blocks
- Structured dataset items plus a `RUN_SUMMARY` record in the default key-value store

## Current discovery model

The Actor resolves the target profile through Instagram's public web profile endpoint and builds a bounded recent-first discovery plan from:

- the target profile's recent public posts
- Instagram usernames mentioned in those recent captions
- co-authors and tagged users visible on those recent posts

For each candidate post, the Actor inspects the visible comment thread on the public post page and keeps comments whose visible author username matches the resolved target username exactly.

## Important limitations

- Coverage is best-effort, not exhaustive.
- Instagram's unauthenticated web surfaces do not expose all comments equally.
- For many posts, only a limited set of visible comments is accessible without login.
- If a browser runtime is unavailable, the Actor returns a partial-coverage summary instead of failing the whole run.
- Likes, mentions/tagged output, and tombstones are out of scope for this issue and will be added in later issues.

## Output

Dataset items contain matched comment events.

`RUN_SUMMARY` contains:

- target resolution status
- user-facing message
- target snapshot
- counts
- qualitative coverage
- warnings

## Local development

Run locally with:

```bash
/home/jamyl/.local/share/apify-cli/node_modules/.bin/apify run
```

Example input:

```json
{
  "username": "nasa"
}
```

## Validation notes

This repository is currently validated by:

- TypeScript build
- unit tests for pure parsing and normalization utilities
- local/dry `apify run` behavior
- Docker runtime check using the official Apify Playwright image
