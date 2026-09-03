# @starkeep/photos-ladder

Photos' rendition ladder, and the rule for resolving a requested pixel size
against it.

## Why this is a package

Every Photos surface has to agree on two things: which derived sizes a record
should have, and which of them answers a request for *n* pixels. Web and cloud
share `photos/`, so they agreed for free. `photos-mobile` depends on the four
`@starkeep/*` platform packages and on nothing from `photos`, so it could not
reach either — and implementing the phone against that layout would have meant
a second copy of `STILL_LADDER`.

Two implementations of the resolution rule that disagree is a rendering bug
visible on one device class only, which is close to the worst kind to find. So
the ladder lives here and every surface consumes it.

## What is in here

Five modules, and they are one chain rather than five utilities. A surface
measures its container; `justified-layout.ts` decides what box each photograph
gets; `render-geometry.ts` turns that box, the photograph's shape and the
device pixel ratio into a pixel count; `rendition-policy.ts` snaps that count
onto a rung of `ladder.ts`; `rendition-resolution.ts` picks the record that
answers it. Every link has to agree across surfaces, or a photograph is fetched
at one size and painted at another.

The layout is in here for the strongest version of that argument. It decides
the *box*, and the box is what the pixel count is measured from — so a second
implementation would disagree about which rung to fetch as well as about where
to put it.

## What may go in here

Pure arithmetic over sizes and shapes: no I/O, no platform packages, no React,
no DOM, no sharp. That is what lets it be imported from a Lambda, a Next server
and a React Native bundle alike — and it is why a layout module qualifies while
the component that renders its rows does not.

## What may not

The platform must never learn what a size class is — not `@starkeep/sync-engine`,
not the storage adapters, not `@starkeep/protocol-primitives`. Locally and in the
cloud that boundary is a signed HTTP hop and enforces itself. On the phone there
is one process, so it is a module boundary and nothing enforces it but the
dependency direction: this package depends on none of them, and none of them may
depend on it.
