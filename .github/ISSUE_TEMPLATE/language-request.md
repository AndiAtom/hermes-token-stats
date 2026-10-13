name: Language request
description: Request an additional UI language for the plugin
labels: ["language-request"]
body:
  - type: markdown
    attributes:
      value: |
        The plugin UI ships with **DE, EN (default), FR, NL, IT** — user-toggleable
        via the chip menu (desktop) or header (web dashboard), persisted per
        browser/machine via localStorage. Adding a language is a dictionary
        addition (`I18N` table in `plugin.js` / `web-entry.js`) — no UI code
        changes needed.

        **What we need from you:** the language code, and ideally a native
        speaker's review of the generated strings before merge (wrong
        translations are worse than English fallback text).
  - type: input
    id: lang
    attributes:
      label: Language
      description: ISO 639-1 code plus name, e.g. `es` — Spanish
      placeholder: e.g. es — Spanish
    validations:
      required: true
  - type: input
    id: locale
    attributes:
      label: Preferred locale for number/date formatting
      description: ICU locale the Intl formatting should use, e.g. `es-ES`
      placeholder: e.g. es-ES
    validations:
      required: false
  - type: textarea
    id: notes
    attributes:
      label: Notes (optional)
      description: Regional variants, terminology preferences (e.g. Latin American vs. Iberian Spanish), UI conventions
      placeholder: e.g. Prefer Latin American Spanish; use "sesión" singular/plural as in Microsoft style guides
    validations:
      required: false
  - type: checkboxes
    id: contribute
    attributes:
      label: Willing to review the translated strings?
      description: A PR with the dictionary entries will be linked here — a native-speaker sanity check before merge catches wrong terms early
      options:
        - label: Yes, I can review the generated translations
        - label: No — please use careful English fallback where unsure
