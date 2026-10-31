# SuperPPT generation state

## Ownership

This module owns the durable job, budget, image-reference, and checkpoint
contracts for SuperPPT image generation. The host or API executor owns provider
calls and route selection; this module records each request and validates the
artifacts that the executor reports.

## Invariants

- `requestCount` counts every paid request, including failed attempts, and never
  decreases during a job.
- `completed` contains only validated artifacts that can be reused without a
  new generation request.
- `inFlightSlideIds` lists every request whose result has not been committed;
  the legacy singular `inFlightSlideId` is read and written as a compatibility
  view for old jobs.
- `maxConcurrency` is bounded at four, defaults to two for deck jobs, and is
  forced to one for style samples. Capacity is limited by both this value and
  the remaining call budget.
- A result cannot be accepted while an in-flight request remains unknown, and a
  successful page cannot be regenerated.

### Why bounded API waves and not shared parallel sticky routing

Independent API requests can overlap after one provider is explicitly locked,
but host capability selection and fallback remain ordered. Sharing the existing
`SerialStickyRouter` between workers would race its sticky cursor and make a
crash ambiguous across paid requests, so the executor uses bounded waves and a
single checkpoint coordinator instead.
