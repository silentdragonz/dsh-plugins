# dsh-ina-theme

A color theme bundle for [DSH](https://github.com/deepseek-ai/dsh) extracted from the
"Ina" artwork: deep eggplant-indigo surfaces, a rose-magenta brand accent
(the satchel), amber hair-tip highlights, and plum-tinted neutrals replacing the
stock blue-tinted grays.

Registers two first-class themes with the built-in theme runtime:

| Theme | Scheme | Mood |
| --- | --- | --- |
| `ina-dark` | dark | the artwork: plum-black canvas, eggplant layers, ivory text |
| `ina-light` | light | the same hues as eggplant ink on ivory paper |

Both variants also remap the primitive ramps (`--dsw-static-deepseek-*`,
`--dsw-static-blue-*`, `--dsw-static-neutral-bluish-*`) so send buttons, active
tabs, and workspace-folder icons carry rose/plum instead of DeepSeek blue.

## Settings page

**Settings → Ina** offers:

- **Enable theme** — off restores stock DSH colors instantly
- **Variant** — `Auto` (follows the OS light/dark setting), `Light`, or `Dark`

Choices persist server-side in `~/.dsh/ina-theme.json` (via the
bundle's fenced `/api/dsh-ina-theme/settings` route), with a
localStorage instant layer so the first paint after a reload is already the
configured variant; on boot the durable route wins when the two disagree.

DSH persists only its built-in preference (light/dark/system) and re-adopts
it asynchronously after boot and on settings-document reloads, which would
otherwise clobber the custom theme id. While enabled, the bundle re-asserts
the configured variant whenever the preference lands back on a built-in
(deferred to a fresh task, as the theme presenter requires), and maps an
explicit Light/Dark/System pick in General → Appearance onto the scheme
setting so both controls drive one source of truth. Turning the theme off
restores the last stock preference.

## Install

```sh
dsh plugin --profile web add file:/workspace/workspace/tmp/dsh-ina-theme
```

Then add `"dsh-ina-theme"` to `dsh.profile.bundles` in
`~/.dsh/profiles/web/package.json` (if the CLI did not do it) and restart the
profile.

## Remove

Remove the bundle from `dsh.profile.bundles`, `dsh plugin --profile web remove
dsh-ina-theme`, restart. Disposing the plugin resets the preference
and removes the Settings page; the state file `~/.dsh/ina-theme.json`
can be deleted by hand.
