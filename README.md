# Instagram Public Activity History

Best-effort Apify Actor for looking up the public Instagram activity history of a single username.

This Actor is packaged as a public beta product with a comments-first contract:

- comments and visible replies first
- experimental liked-content signals second
- mentions and tagged appearances as supporting surfaces

It is designed for public research use cases such as creator vetting, moderation research, due diligence, and brand-safety review.

## What You Provide

- One Instagram username
- No Instagram login is required in the standard public flow

The Actor accepts usernames with or without a leading `@`.

## What You Get Back

The dataset contains public activity events for the resolved target when they are discoverable.

Event types currently supported:

- `comment`
- `liked_content`
- `mention`
- `tagged_appearance`

Each event includes source context, timestamps when available, match confidence, and observation metadata.

## Observation States

Each dataset item includes an `observationState`:

- `visible`: the event was observed again in the current run
- `historical_tombstone`: the event was observed in an earlier run and is now considered no longer visible based on sufficiently strong coverage
- `historical_unconfirmed`: the event was observed before, but the current run was not strong enough to safely infer disappearance

Historical output is metadata-focused. When an event becomes historical, the Actor does not republish old text content in full.

## How Discovery Works

The Actor resolves the target profile through public Instagram web surfaces and builds a bounded recent-first discovery plan from:

- the target profile's recent public posts
- usernames mentioned in recent captions
- directly visible co-authors and tagged users on recent posts

Within that discovery scope, the Actor:

- extracts visible public comments and replies
- looks for exact caption mentions of the target username
- looks for exact tagged-user appearances of the target username
- looks for attributable public liker-username signals when Instagram exposes them

## Coverage And Confidence

The Actor returns a `RUN_SUMMARY` record in the default key-value store.

It includes:

- overall run status
- target resolution snapshot
- comments coverage and confidence
- liked-content coverage and confidence
- mention/tagged coverage
- history reuse and tombstone counts
- warnings and limitations seen during the run

This is important because different surfaces have different reliability:

- comments are the strongest current surface
- liked-content is the weakest and most experimental surface
- mentions/tagged are useful supporting signals, but still limited by the bounded discovery scope

## Important Limitations

- This Actor is best-effort, not exhaustive.
- It does not guarantee recovery of all public appearances of a target account.
- Instagram's unauthenticated web surfaces change often and may expose only partial public data.
- Private accounts are out of scope.
- Replies are included only when Instagram exposes them in visible public threads.
- Liked-content recovery is experimental and depends on Instagram exposing attributable public liker usernames. In many runs, that signal may not be available at all.
- Sparse liked-content output does not mean the target never liked anything.
- Missing activity in a run does not automatically prove disappearance unless the relevant branch had strong enough coverage.

## Out Of Scope

- Private or non-public Instagram data
- DMs, Close Friends, or private messaging surfaces
- Stories as a required surface
- Guaranteed full archive of a user's public appearances
- Guaranteed full reconstruction of a user's likes
- Mandatory end-user Instagram login in the public Store flow

## Public Beta Positioning

This Actor should be treated as a public beta launch contract:

- conservative on promises
- explicit about uncertainty
- explicit about branch-specific limitations
- suitable for iterative improvement as Instagram surfaces change

## Pricing Guidance

This product should be priced in a way that reflects discovery effort rather than guaranteed result volume.

The reason is simple:

- some runs require inspecting multiple public surfaces just to establish limited coverage
- comments, likes, and supporting surfaces do not have equal recoverability
- a low result count can still represent meaningful discovery work

In other words, the Store contract should not imply that payment is tied only to the number of matched events returned.

## Persistence

Repeated-lookup state is persisted in a named key-value store:

- store name: `TARGET_HISTORY`
- key pattern: `TARGET_STATE__<resolved-target-id>`

This state is used only to improve repeated lookups and historical output behavior.

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

- `npm run build`
- `npm test`
- `npm run lint`
- `apify run`
- `docker build -t instagram-public-comment-discovery:test .`
