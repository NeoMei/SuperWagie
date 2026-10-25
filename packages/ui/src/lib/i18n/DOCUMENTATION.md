# Interface language

## Ownership

This module owns interface language selection, reactive dictionaries, bootstrap
messages, and formatting locales for every shared UI runtime. Native menus follow
the normalized language sent by `I18nProvider`.

## Invariants

- The application offers English and Simplified Chinese through `LOCALES`.
- English platform tags resolve to `en`. Chinese tags resolve to `zh-CN`.
  Retired and unknown language tags resolve to the existing `zh-CN` default.
- Initial storage, host language, store updates, and bootstrap messages use the
  same normalization. A retired saved language cannot reactivate its dictionary.
- Switching language preserves mounted UI state and writes the normalized value
  to local storage. Settings persistence accepts the same active languages.
- The update dialog selects its release notes from the active interface locale
  and reselects while the dialog stays open. Localized release notes use paired
  `<!-- release-notes:zh-CN -->` or `<!-- release-notes:en -->` and
  `<!-- /release-notes -->` comments. Unmarked legacy Markdown stays readable;
  a missing translation falls back to English. Release copy describes product
  changes, while build and acceptance evidence remains in release attachments.
- App-owned extension navigation is translated at render time, without changing
  catalog identity or the action declarations checked by the executor. Iframes
  receive the current locale through repeated SDK ready messages; their own
  dictionaries translate built-in content while retaining user-authored data.

## Decisions

### Why the language resources contain 2 locales

The product supports English and Simplified Chinese. Main dictionaries, feature
dictionaries, formatting tags, and native menu resources contain only those
languages. Compatibility normalization preserves startup from retired saved tags.
