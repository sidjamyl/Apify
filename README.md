# Instagram Public Comment Discovery

Best-effort Apify Actor for `#4`: start from a single Instagram username, resolve the public target profile, inspect directly reachable recent public post surfaces, and return matched public comments, visible replies, experimental liked-content signals, caption mentions, and tagged appearances involving that target.

## Current scope

- Public-only
- Username-only input
- Comments and replies when visible
- Liked content only when Instagram exposes attributable public liker usernames on scanned public surfaces
- Mentions and tagged appearances as supporting surfaces
- Exact username matching on visible public comment blocks, with ambiguous near-matches flagged separately in the run summary
- Structured dataset items plus a `RUN_SUMMARY` record in the default key-value store

## Current discovery model

The Actor resolves the target profile through Instagram's public web profile endpoint and builds a bounded recent-first discovery plan from:

- the target profile's recent public posts
- Instagram usernames mentioned in those recent captions
- co-authors and tagged users visible on those recent posts

For each candidate post, the Actor:

- inspects the visible comment thread on the public post page
- tries to expand visible replies when possible
- keeps comments or replies whose visible author username matches the resolved target username exactly
- scans non-owned candidate posts for exact caption mentions of the target username
- scans non-owned candidate posts for exact tagged-user appearances of the target username
- scans non-owned candidate posts for exact attributable public liker-username signals when Instagram exposes them

## Important limitations

- Coverage is best-effort, not exhaustive.
- Instagram's unauthenticated web surfaces do not expose all comments equally.
- For many posts, only a limited set of visible comments is accessible without login.
- If a browser runtime is unavailable, the Actor returns a partial-coverage summary instead of failing the whole run.
- Replies are included only when Instagram exposes them in the public visible thread.
- Mention and tagged coverage is limited to the candidate-post discovery scope already available to the Actor.
- Liked-content recovery is the weakest surface in the Actor and is explicitly experimental, best-effort, and non-exhaustive.
- Ambiguous near-matches are flagged in the run summary and are not blended into confirmed results.
- Likes, mentions/tagged output, and tombstones are out of scope for this issue and will be added in later issues.

## Output

Dataset items contain matched comment events.

The dataset now also includes `liked_content`, `mention`, and `tagged_appearance` events as distinct activity types.

`RUN_SUMMARY` contains:

- target resolution status
- user-facing message
- target snapshot
- counts
- comments coverage and scan state
- comments confidence summary and ambiguous candidate samples
- liked-content coverage and confidence reported separately from comments
- mention/tagged coverage reported separately from comments
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
