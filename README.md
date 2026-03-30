# Instagram Public Comment Hunter (High-Recall Beta)

Comments-first Apify Actor for finding as many publicly visible Instagram comments as possible for a username.

This product is intentionally positioned as a **high-recall public beta**:

- comments and replies are the main value
- runs can be longer and more aggressive than a lightweight scraper
- discovery is cumulative across runs
- supporting likes, mentions, and tagged appearances remain secondary

## Main Promise

Start from a username and search for publicly visible Instagram comments attributable to that username.

The Actor is designed to keep improving over time:

- it reuses prior discovery memory
- it rescans productive areas of the public graph
- it supports repeated runs instead of treating every run as a fresh one-off lookup

This includes best-effort support for **public traces left by private accounts on public posts** when those traces are discoverable.

## Input

- `username`
- optional `runMode`
  - `backfill`: deeper multi-cycle discovery
  - `freshness`: lighter repeated update mode
- optional `maxDiscoveryCycles`

No Instagram login is required from the end user in the public flow.

## Main Output

The main dataset remains comments-first.

Current event types:

- `comment`
- `liked_content`
- `mention`
- `tagged_appearance`

The intended reading order remains:
1. confirmed comments and replies
2. ambiguous comment candidates
3. supporting surfaces

## Confirmed vs Ambiguous Comments

Confirmed comments and replies are returned in the dataset.

Ambiguous near-matches are separated into:

- `AMBIGUOUS_COMMENT_CANDIDATES`

The Actor does not silently merge probable username matches into confirmed results.

## High-Recall Operation

This Actor is no longer just a single-pass scraper.

It now supports:

- repeated discovery memory reuse
- frontier-style prioritization of productive owners and graph regions
- multi-cycle runs inside one execution
- distinct operating modes for backfill vs freshness

The `RUN_SUMMARY` includes an `operation` section that explains:

- which run mode was used
- how many discovery cycles were attempted
- how many cycles completed
- why the run stopped

## Discovery Model

The Actor uses a broad but still bounded public discovery model.

It can combine:

- public Instagram profile-derived discovery
- external public web search for Instagram post URLs
- cached candidate posts from previous runs
- cached productive owners from previous runs
- frontier-style prioritization driven by historical yield

This is necessary because Instagram does not provide a reliable public API for “all comments by this username”.

## Comment Fetching Model

The Actor prefers structured comment retrieval when that path is publicly accessible.

When structured retrieval is unavailable or blocked, it falls back to browser DOM extraction.

This means the Actor is **JSON/GraphQL-first in architecture**, but still keeps a browser fallback because many logged-out public comment surfaces are inconsistent.

## Coverage, Confidence, and Honesty

The Actor writes a `RUN_SUMMARY` record that explains:

- target resolution status
- operation mode and cycle behavior
- discovery breadth and warnings
- cache/frontier reuse
- comment coverage and confidence
- supporting-surface coverage
- historical observation reuse and tombstones

The Actor does **not** present “no confirmed comments found” as proof that the target has never commented publicly.

## Important Limits

- This Actor is high-recall, but still **non-exhaustive**.
- It does not guarantee recovery of all public comments a user has ever made.
- Instagram public surfaces change often and may expose only partial data.
- Private accounts can still leave public traces on public posts, but recovery depends on those traces being discoverable.
- Structured comment fetching is not uniformly available when logged out.
- Likes remain weaker and more experimental than comments.
- Strong recall may require longer runtime and stronger anti-blocking support behind the scenes.
- Missing activity is only meaningful when the relevant branch had enough coverage to support that interpretation.

## Anti-Blocking Reality

This product is designed under the assumption that stronger anti-blocking support matters in real high-recall operation.

In practical terms, that means:

- proxies may materially improve reliability
- persistent sessions may materially improve reliability
- repeated runs are part of the recall strategy, not just an operational detail

The public Store contract should therefore be read as a high-effort beta search product, not as a guaranteed comment archive.

## Out of Scope

- non-public Instagram data
- DMs, Close Friends, and private messaging surfaces
- guaranteed complete lifetime recovery of all public comments
- guaranteed full like reconstruction
- treating likes, mentions, or tagged appearances as equal to comments in the public promise

## Pricing Guidance

This Actor should be priced by **discovery effort**, not only by result count.

Why:

- long runs can consume meaningful discovery effort even when confirmed results are sparse
- repeated runs improve recall through persistent memory reuse
- comments, likes, and supporting surfaces do not have equal recoverability

The pricing contract should therefore avoid implying that value is determined only by the number of returned events.

## Public Beta Positioning

This is a public beta and should be presented as such:

- comments-first
- cumulative and long-running
- explicit about uncertainty
- explicit about non-guarantees
- explicit about operating assumptions for real high recall

## Persistence

Repeated lookup state is stored in:

- `target-history`
- `candidate-discovery-cache`

This persistence is a core part of the product value because the Actor improves through repeated runs.

## Local Development

Run locally with:

```bash
/home/jamyl/.local/share/apify-cli/node_modules/.bin/apify run
```

Example input:

```json
{
  "username": "nasa",
  "runMode": "backfill",
  "maxDiscoveryCycles": 5
}
```

## Validation

This repository is currently validated with:

- `npm run lint`
- `npm run build`
- `npm test`
- `apify run`
- `docker build -t instagram-public-comment-discovery:test .`
