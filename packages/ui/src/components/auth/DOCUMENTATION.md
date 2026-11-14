# Application access

## Ownership

`SessionAuthGate` establishes access to the selected runtime. `PlatformAccountGate`
then establishes the UniHub product user before the application mounts. Backend
authorization owns access enforcement independently of these React gates.

## Invariants

- Managed web, Electron main and Electron Mini Chat defer workspace bootstrap
  until UniHub reports a signed-in identity. The identity check reads no wallets,
  subscriptions or model credits.
- Pending, failed, unconfigured, unsupported and signed-out identity states
  leave application children unmounted before the first authenticated mount. No
  provider choice bypasses this gate.
- An account session that expires after the application has mounted keeps the
  workspace mounted under a blocking re-authentication overlay; an explicit
  sign-out still unmounts the application.
- Local desktop account sign-in and registration screens, including re-authentication,
  expose a close icon that quits the application through `desktop_quit`. The
  command uses Electron's normal quit path so storage and background services
  are cleaned up, even when ordinary window closing would hide to the tray or
  keep the macOS application running. Browser and unsupported mobile/VS Code
  surfaces and remotely hosted pages do not expose this desktop action. Preload
  exposes `quitApp` only to trusted local UI and the exact development HMR origin
  supplied by main; main refuses `desktop_quit` from remote origins independently
  of the button.
- Packaged Electron establishes a persistent runtime device bearer before mounting
  the product gate. The `openchamber-ui://` page cannot keep a loopback SameSite
  cookie identity across requests. Token creation failure leaves the gate closed.
- A rejected device bearer is not an account answer. The packaging desktop
  re-mints its credential through `packages/ui/src/lib/desktopClientIdentity.ts`
  and reads the identity once more; a server whose client store lost the record
  therefore recovers the window instead of refusing it until someone signs in
  again. The renewal is scoped to the runtime instance that was rejected.
- Losing the account service, offline included, never turns a verified identity
  into a signed-out one. Before the first mount the gate shows the sign-in form
  so credentials can still be submitted; after the first mount the workspace
  stays, because the backend access gate keeps checking the runtime session on
  every request. Only an authoritative identity answer changes the account state.
- The backend keeps the identity it already verified when UniHub cannot be
  reached for `/v1/me`, and reports the failure for other account reads. A
  network failure never removes the stored session; a rejected token still does.
- Packaged desktop password and passkey sign-in trusts the device on first login
  when no preference exists. The saved desktop bearer uses the longer device
  lifetime, while clearing the checkbox keeps the shorter session lifetime.
- Runtime switching clears the displayed identity and rejects old responses.
  Confirmed logout and account-expiry responses invalidate the gate immediately;
  session expiry and focus checks also return it to the login screen.
- Session gate asynchronous identity checks require the captured runtime instance
  and endpoint. Switching instances permanently invalidates earlier captures,
  including a return to the same endpoint and runtime key. Same-instance
  credential refresh preserves ownership; an endpoint change still rejects the
  earlier completion.
- An unknown authorization result keeps the workspace and sign-in form closed.
  Sign in again explicitly signs out the current runtime through the backend;
  only its confirmed state restores the form. Failed sign-out remains visible
  and retryable, and results from a previous runtime cannot alter the active gate.
  This recovery never starts an authorization or changes the account password.
- Recovery host switchers own a connections-only Remote instances dialog because
  the authenticated Settings window is unmounted. Native host and SSH setup remain
  available; server-side device management is not loaded before account sign-in.
  Closing the connection editor leaves the identity gate closed.
- Sign-in and registration share one form width with start-aligned field hints
  and a full-width submit action. Refresh and instance switching share the
  auxiliary row below it. Short windows scroll the entire form from its top;
  password feedback stays below the input without reducing its width.
- Workspace settings, persisted directory validation and home-directory reads
  run after identity authentication. The runtime gate can retain its existing
  bootstrap behavior for callers that do not defer it.
- VS Code, the complete hosted-mobile application and Capacitor show the explicit unsupported identity state and do not mount their business application. The separately approved hosted selected-material reader has its own isolated pilot account gate, documented in `apps/DOCUMENTATION.md`. Its root retains `SessionAuthGate` for existing runtime access and never invokes normal platform account login or runtime bootstrap. The unsupported hosted root exposes only a link to that reader; Capacitor gets no exception.

## Decisions

### Why runtime and product identity have separate gates

Runtime pairing and local access protect the connected machine. UniHub identifies
the product user. Keeping both checks preserves the runtime credential boundary
while making registration mandatory for all SuperWagie features.

### Why session completions capture the runtime instance

Endpoint and runtime key equality cannot distinguish separate visits to the same
instance. The gate adds the shared runtime-instance predicate to its private
capture so old completions cannot lock a freshly authenticated return visit.
Credential refresh keeps that instance ownership. Native commands and settings
receive explicit data fields; the predicate stays in the renderer.

### Why identity reads exclude account finances

An unavailable billing service must not invalidate a successful login. The user
center queries financial data after authentication and reports its own failures.

### Why unknown sign-in results require explicit sign-out

Refreshing can fail while an earlier authorization or token refresh remains
unresolved. An explicit backend sign-out ends that runtime's account session
before another sign-in becomes available; a failed read cannot establish that
the user is signed out.

### Why the desktop bearer outlives the browser cookie

The desktop shell stores its bearer in the protected desktop settings file and
needs it after an app restart. A short browser cookie lifetime would otherwise
make a normal desktop restart look like a logout, so trusted desktop bearers use
a finite lifetime with a 30-day floor while the user can opt out per device.
