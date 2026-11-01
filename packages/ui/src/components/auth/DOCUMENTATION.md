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
- Packaged desktop password and passkey sign-in trusts the device on first login
  when no preference exists. The saved desktop bearer uses the longer device
  lifetime, while clearing the checkbox keeps the shorter session lifetime.
- Runtime switching clears the displayed identity and rejects old responses.
  Confirmed logout and account-expiry responses invalidate the gate immediately;
  session expiry and focus checks also return it to the login screen.
- Recovery host switchers own a connections-only Remote instances dialog because
  the authenticated Settings window is unmounted. Native host and SSH setup remain
  available; server-side device management is not loaded before account sign-in.
  Closing the connection editor leaves the identity gate closed.
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

### Why the desktop bearer outlives the browser cookie

The desktop shell stores its bearer in the protected desktop settings file and
needs it after an app restart. A short browser cookie lifetime would otherwise
make a normal desktop restart look like a logout, so trusted desktop bearers use
a finite lifetime with a 30-day floor while the user can opt out per device.
