# Instagram Public Comment Hunter (Beta)

Best-effort Apify Actor for finding publicly visible Instagram comments by username.

This Actor is packaged as a **public beta** and is intentionally comments-first:

- confirmed public comments and visible replies are the main product value
- likes remain experimental and weaker than comments
- mentions and tagged appearances remain supporting signals

The product is designed for public research use cases such as due diligence, moderation research, creator vetting, and brand-safety review.

## Main Promise

Start from a single Instagram username and search for publicly visible comments attributable to that username.

This includes best-effort support for **public traces left by private accounts on public posts** when those traces are discoverable.

## Input

- one Instagram username
- no Instagram login required in the standard public flow

The Actor accepts usernames with or without a leading `@`.

## Main Output

The main dataset is a comments-first activity stream.

Current event types:

- `comment`
- `liked_content`
- `mention`
- `tagged_appearance`

But the product contract is not “all activity equally.”

The intended reading order is:
1. confirmed comments and replies
2. ambiguous comment candidates
3. supporting surfaces

## Confirmed vs Ambiguous Comments

Confirmed comments and replies are returned in the default dataset.

Ambiguous near-matches are kept separate in:

- `AMBIGUOUS_COMMENT_CANDIDATES`

This separation is deliberate. The Actor does not silently mix probable username matches into confirmed comment results.

## Observation States

Each dataset item includes `observationState`:

- `visible`
- `historical_tombstone`
- `historical_unconfirmed`

Historical output is metadata-focused. When an item is no longer currently visible, the Actor does not republish old text content in full.

## How Discovery Works

The Actor uses a broad but bounded discovery strategy.

It can combine:

- public Instagram profile-derived discovery
- external public web search for Instagram post URLs
- bounded expansion around public owners discovered from those hits
- frontier-style prioritization that reuses productive owners and candidate posts from prior runs

When fetching comments from a post, the Actor now prefers structured API retrieval when that surface is publicly accessible. Browser DOM extraction remains a fallback for posts where structured retrieval is unavailable.

This is necessary because Instagram does not provide a reliable public search surface for “all comments by this username”.

## Coverage, Confidence, and Honesty

The Actor returns a `RUN_SUMMARY` record in the default key-value store.

It explains:

- target resolution status
- comment-hunt result state
- discovery breadth and warnings
- discovery memory reuse such as cached candidate posts
- comments coverage and confidence
- liked-content coverage and confidence
- mention/tagged coverage
- historical observation reuse and tombstone counts

This matters because an empty result can mean very different things:

- no confirmed comments were found in the inspected scope
- discovery breadth was weak
- external search was blocked or sparse
- canonical resolution was temporarily unavailable

The Actor does **not** present “no confirmed comments found” as proof that the target has never commented publicly.

## Important Limitations

- This Actor is best-effort, not exhaustive.
- It does not guarantee recovery of all public comments by a username.
- Instagram public surfaces change often and may expose only partial data.
- Private accounts can still leave public traces on public posts, but recovery depends on those traces being discoverable.
- Replies are included only when Instagram exposes them publicly.
- Liked-content recovery is experimental and depends on attributable public liker usernames being exposed. In many runs, that signal may not exist at all.
- Sparse or missing liked-content output does not prove the target never liked anything.
- Missing activity only becomes meaningful when the relevant branch had enough coverage to support that interpretation.

## Out of Scope

- non-public Instagram data
- DMs, Close Friends, and private messaging surfaces
- mandatory end-user Instagram login in the public flow
- guaranteed full recovery of all public comments
- guaranteed full reconstruction of a user’s likes
- Stories as a required surface

## Pricing Guidance

This Actor should be priced according to **discovery effort**, not only returned result volume.

Why:

- some runs consume real search and inspection work even when confirmed results are sparse
- comments, likes, and supporting surfaces do not have equal recoverability
- a low result count can still reflect meaningful bounded discovery work

The Store contract should therefore avoid implying that users only pay for matched event volume.

## Public Beta Positioning

This is a public beta product and should be presented that way:

- conservative on promises
- explicit about uncertainty
- explicit about comments-first hierarchy
- explicit about branch-specific limitations

## Persistence

Repeated lookup state is stored in `target-history`.

Candidate discovery memory is also stored separately in `candidate-discovery-cache`.

This cache can keep:

- previously found candidate posts for a username
- productive owners that are worth rescanning later

The Actor may persist history either by:

- canonical target identity
- provisional input-username identity

If canonical resolution is unavailable, history may be keyed provisionally by username. In that case, historical interpretation should remain cautious until canonical resolution succeeds in a future run.

This means repeated runs do not depend only on fresh search-engine results. They can reuse older discovery memory and continue from earlier findings.

## Local Development

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

## Validation

This repository is currently validated with:

- `npm run lint`
- `npm run build`
- `npm test`
- `apify run`
- `docker build -t instagram-public-comment-discovery:test .`
