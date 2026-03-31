# Instagram Deep Investigation (Advanced Self-Serve Beta)

Advanced self-serve Apify Actor for deep Instagram investigation by target username.

This product builds on the existing comments-first discovery engine, but it is no longer positioned as a lightweight public-only lookup. It is now an **advanced deep-investigation beta** that can combine:

- cumulative discovery memory across runs
- backfill and freshness investigation modes
- typed checkpointed runtime execution
- operator-backed session bootstrap and reuse
- proxy-aware root graph expansion
- comments-first scanning with supporting appearance surfaces

## Main Promise

Start from **any Instagram target username** and investigate the target's observable Instagram footprint as deeply as the supported visibility surfaces allow.

Important:

- the target username does **not** need to belong to you
- operator accounts are **execution resources**, not target identities
- results remain **best-effort and non-exhaustive**

## Product Positioning

This Actor is for **advanced self-serve users** who are willing to supply legitimate operator accounts and proxy configuration to unlock deeper, session-aware discovery.

It is not a consumer-grade one-click public scraper.

## Investigation Modes

- `backfill`
  - deeper first-pass investigation
  - wider discovery effort
  - longer runtime and heavier resource usage

- `freshness`
  - lighter revisit mode
  - reuses prior memory and runtime state
  - intended for repeated follow-up investigations

## Required Operating Assumptions

For true deep investigation behavior, the Actor expects:

- legitimate operator Instagram accounts supplied by the user
- proxy configuration capable of supporting sticky, reusable sessions

Without those resources, the Actor can still fall back to weaker public-only behavior, but operator readiness will be reported as degraded or unavailable in the run summary.

## Input

Primary fields:

- `username`
- `runMode`
- `maxDiscoveryCycles`
- `proxyConfiguration`
- `operatorAccounts`
- `graphExpansion`

### Target semantics

`username` is always the **target account to investigate**.

It can be any Instagram username.

It does not need to match any operator account.

### Operator accounts

`operatorAccounts` are legitimate Instagram accounts you provide so the Actor can:

- bootstrap reusable sessions
- reuse prior session state
- inspect session-visible root graph surfaces
- expand discovery through follower / following roots and bio-linked pivots

### Proxy configuration

`proxyConfiguration` is the Actor-level network configuration used for operator-backed work.

In practice, reliable deep investigation depends on proxies because session reuse and anti-blocking behavior materially affect what can be inspected.

## Discovery Model

The Actor can combine:

- canonical or degraded target resolution
- public profile-derived discovery
- external public web search for Instagram post URLs
- cached candidate posts from previous runs
- cached productive owners from previous runs
- checkpointed runtime reuse
- operator-backed root graph expansion via:
  - bio-linked usernames
  - followers
  - following

This still does **not** mean the Actor can recover every appearance a target ever made.

## Comment Fetching Model

The Actor remains **comments-first** in product value.

It prefers structured comment retrieval where available and falls back to browser extraction when needed. Supporting surfaces such as mentions, tagged appearances, and weak like signals are still useful, but comments and replies remain the primary reading order.

## Runtime and Recovery

The Actor now runs through a typed, checkpointed runtime.

That means investigations are designed to support:

- pause / resume behavior
- retry from checkpoint instead of zero
- runtime-state reuse between interrupted runs
- recovery of stale leased work on later runs

The `RUN_SUMMARY` now includes runtime metadata under `operation.runtime`.

## Main Output

The Actor remains Apify-native.

Current user-facing outputs still include:

- dataset items for confirmed or historical activity records
- `RUN_SUMMARY`
- `AMBIGUOUS_COMMENT_CANDIDATES`

Comments and replies remain the first-class reading surface.

## Coverage, Confidence, and Honesty

The Actor is designed for strong recall effort, but it is still **non-exhaustive**.

The `RUN_SUMMARY` explains:

- target resolution status
- runtime reuse and checkpoint recovery
- discovery breadth and warnings
- operator readiness and graph expansion warnings
- comment coverage and confidence
- supporting-surface coverage
- historical observation reuse and tombstones

The Actor does **not** present an empty confirmed-comment result as proof that the target has never commented.

## Important Limits

- This Actor does not guarantee complete lifetime recovery of all appearances.
- Instagram visibility changes often and can expose only partial data.
- Private targets are only recoverable to the extent that traces are visible on supported surfaces.
- Operator sessions may still encounter rate limits, checkpoints, or incomplete graph access.
- Structured comment retrieval is not uniformly available.
- Like signals remain weaker than comments.

## Out of Scope

- DMs and private messaging surfaces
- surfaces not normally visible to legitimate operator accounts
- fake, disposable, or fabricated operator accounts
- guaranteed exhaustive lifetime recovery
- treating weak signals as equal to comments in the product reading order

## Persistence

The Actor currently persists investigation value across runs in stores such as:

- `target-history`
- `candidate-discovery-cache`
- `deep-investigation-runtime`
- `operator-sessions`

These stores are part of the product value because repeated runs should improve effectiveness over time.

## Local Development

Run locally with:

```bash
/home/jamyl/.local/share/apify-cli/node_modules/.bin/apify run
```

Example minimal input:

```json
{
  "username": "nasa",
  "runMode": "backfill",
  "maxDiscoveryCycles": 5
}
```

Example deep-investigation input:

```json
{
  "username": "nasa",
  "runMode": "backfill",
  "maxDiscoveryCycles": 5,
  "proxyConfiguration": {
    "useApifyProxy": true
  },
  "operatorAccounts": [
    {
      "username": "research_operator",
      "password": "<secret>",
      "sessionKey": "op-1"
    }
  ],
  "graphExpansion": {
    "maxFollowersToInspect": 25,
    "maxFollowingToInspect": 25,
    "maxExpandedProfiles": 20
  }
}
```

## Validation

This repository is currently validated with:

- `npm run lint`
- `npm run build`
- `npm test`
- `apify run`
- `docker build -t instagram-public-comment-discovery:test .`
