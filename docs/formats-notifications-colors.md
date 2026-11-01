# Formats, notifications and colors

All of these are personal settings: they are saved with your account, apply immediately, and follow
you between browsers.

## Settings → Dates & units

| Setting      | Options                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| Time format  | Follow my system, 12-hour, 24-hour                                         |
| Date format  | Follow my system, `2026-11-01`, `11/01/2026`, `01/11/2026`                 |
| Recent times | Relative (`5m ago`, shown for the last day) or always a full date and time |
| Size units   | `KB, MB` (1024, the default), `KiB, MiB` (1024) or `kB, MB` (1000)         |

They apply wherever Postbox shows a time, date or size: the history list, console, response sizes,
cookies, schedules, run comparison, dataset versions, mock logs, message panels and the settings pages.
A list that is already on screen picks a change up the next time it redraws.

## Settings → Notifications

- **Message position** and **Message duration** control the toasts.
- **Notify when a long run finishes** shows a browser notification when a collection run completes
  while Postbox is in another tab or window. It does nothing while you are looking at the page, for
  runs shorter than **Only for runs longer than** (default 30 s), and for cancelled runs.
  **Play a sound** adds a short chime.
- Use **Allow notifications** on that page to grant permission, and the test buttons to try the toast,
  notification and sound.

Browsers only allow notifications on HTTPS pages or `localhost`. If you reach Postbox over plain HTTP on
your network the page says so and the notification setting has no effect; the toast and sound still work.

## Settings → Appearance: colors

**HTTP method colors** and **Status colors** (success, redirect, error) take any color. The reset button
on a row restores its default. Colors are the same in the light and dark themes, so pick ones that read
well on both if you switch. They are part of the saved appearance, so they paint with the page and do
not flash the defaults first.
