# Application access

## Ownership

`SessionAuthGate` establishes access to the selected runtime. `PlatformAccountGate`
then establishes the UniHub product user before the application mounts. Backend
authorization owns access enforcement independently of these React gates.

## Invariants

- Managed web, Electron main and Electron Mini Chat defer workspace bootstrap
  until UniHub reports a signed-in identity. The identity check reads no wallets,
  subscriptions or model credits.
- Pending, failed, unconfigured, unsupported, signed-out and expired identity
  states leave application children unmounted. No provider choice bypasses this
  gate.
- Packaged Electron establishes a persistent runtime device bearer before mounting
  the product gate. The `openchamber-ui://` page cannot keep a loopback SameSite
  cookie identity across requests. Token creation failure leaves the gate closed.
- Runtime switching clears the displayed identity and rejects old responses.
  Confirmed logout and account-expiry responses invalidate the gate immediately;
  session expiry and focus checks also return it to the login screen.
- Workspace settings, persisted directory validation and home-directory reads
  run after identity authentication. The runtime gate can retain its existing
  bootstrap behavior for callers that do not defer it.
- VS Code, hosted mobile and Capacitor show the explicit unsupported identity
  state and do not mount their business application until those runtimes gain
  the UniHub contract.

## Decisions

### Why runtime and product identity have separate gates

Runtime pairing and local access protect the connected machine. UniHub identifies
the product user. Keeping both checks preserves the runtime credential boundary
while making registration mandatory for all SuperWagie features.

### Why identity reads exclude account finances

An unavailable billing service must not invalidate a successful login. The user
center queries financial data after authentication and reports its own failures.
