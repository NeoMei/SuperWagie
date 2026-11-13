# VS Code application roots

## Ownership

`VSCodeApp` composes the shared runtime, theme and sync contexts for VS Code webviews. The extension host selects the root's `panelType` in its bootstrap document. `VSCodeLayout` owns chat/session navigation; `SettingsView` owns Settings pages and responsive navigation. The native panel lifecycle belongs to `packages/vscode/src`, documented there.

## Invariants

- Chat-side Settings entry points request the native Settings tab through `RuntimeAPIs.vscode`. They preserve chat selection, drafts and the current layout. The source's in-page dialog flag is cleared so it cannot block chat shortcuts.
- Only the Settings root receives page navigation. The bridge parses it before applying it to stores, and the mounted root signals readiness before the host consumes pending navigation.
- The Settings root supplies no selected directory to the shared sync provider. It does not start global session polling, selected-directory session bootstrap or background queue delivery/cleanup, and seeing it never marks a chat as viewed. Settings pages resolve their own project through `useSettingsDirectory`; catalog updates still use the shared sync context.
- Its runtime shortcut hook registers Settings actions only and requires no chat sync context. Chat, model and session shortcuts remain with chat roots, so a key pressed in Settings cannot create an unseen draft or change a session selection there. Escape reaches an input or menu before the tab's close handler.
- Settings uses the existing persistence and broadcast protocol. Moving its host changes no stored format, registry key or runtime availability.

## Decisions

### Why navigation carries intent and not the source's stores

Each webview owns its own stores. A small parsed request preserves the originating Settings directory, page links, provider-connect action and new-snippet action without transferring chat state or overwriting the tab's independently edited settings.

## Mobile session authority and quota demand

Mobile disappearance cleanup reads the global store's complete snapshot value.
A partial head refresh never advances its baseline. The mobile metadata popover
registers quota demand only while open; the Status pane passes its existing
visibility state into shared Work status sections. Existing native/relay
transports and isolated-space completeness checks remain unchanged.


## Hosted-mobile selected material

`MobileOfficialPane` is a passive projection of server-owned selections. Its list belongs to the visible registered project, active runtime and current account generation. Project/runtime/account changes hide previous results immediately and discard pending responses. A failed read displays an error; it never becomes an empty task list. Preview bytes come only from an existing selection ID. Text is plain and images use revocable object URLs. The pane has no write, guest, service or model effect. Capacitor shows unsupported copy; the pilot is the connected mobile webpage.


### Dedicated hosted reader

`MobileApplicationBoundary` keeps the complete mobile business application behind
its existing unsupported gate. Hosted browsers get an explicit link to
`?view=official`; Capacitor gets no exception. This mode mounts the existing
runtime `SessionAuthGate` followed by `MobileOfficialEntry`, with local i18n only.
It starts no shared-preference/model autosave, widget bridge, diff worker,
OpenCode sync, full project/session loader or model bootstrap.

The dedicated root uses `/api/mobile-official/auth/*`, an isolated product-login
namespace. It shows only verified account memberships and the projects that own
that actor's explicitly selected material. Project IDs from links must match
that returned list; they never become filesystem paths. Account changes, logout,
runtime changes, expiry and refresh retire the visible reader before awaiting
new data. Failed reads remain errors. The provider-free `MobileOfficialView`
owns the passive list and previews; the existing workspace wrapper only supplies
its project ID when that full runtime becomes supported separately.

### Why the hosted reader has a separate root

A read-only pilot must not unlock the complete mobile application or initialize
its session, model, task and filesystem effects. The dedicated root supplies
only runtime authentication, a separately scoped pilot account and selected
snapshots. Existing managed web and desktop account gates keep their behavior.


The dedicated root calls explicit `/api/mobile-official/reader` GET routes;
existing full readers retain the original GET routes. The authority choice only
selects a route, and each server route validates its own identity. A pilot UI
signed in to account B can never display account A through a full-account
fallback. Route-query parsing lives in `mobileOfficialRoute.ts`; the lazy full
application belongs to `MobileBusinessApplication.tsx`, outside the boot entry.
