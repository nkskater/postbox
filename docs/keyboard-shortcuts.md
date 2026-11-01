# Keyboard shortcuts

Open **Settings → Keyboard shortcuts** (or press `?`) to see and change the keys for common actions.
Changes apply immediately, without a reload, and are saved with your account, so they follow you
between browsers.

| Action                  | Default      |
| ----------------------- | ------------ |
| Send request            | Ctrl/⌘+Enter |
| Save request            | Ctrl/⌘+S     |
| Command palette         | Ctrl/⌘+K     |
| Open settings           | Ctrl/⌘+,     |
| Toggle console          | Ctrl/⌘+`     |
| Toggle sidebar          | Ctrl/⌘+B     |
| New request tab         | Alt+T        |
| Close tab               | Alt+W        |
| Show keyboard shortcuts | ?            |

These are fixed: **Alt+1…9** jumps to a tab, **Ctrl/⌘+F** searches inside an editor or response, and
**Ctrl/⌘+Space** opens variable autocomplete.

## Changing a shortcut

Choose **Change** on a row and press the new keys (**Esc** cancels). **✕** leaves the action without a
shortcut and the circular arrow restores its default. **Reset section** restores everything.

- A combination needs **Ctrl/⌘ or Alt** plus a key. Only the help shortcut may be a single key
  (it is ignored while you are typing in a field), and function keys F1–F12 are allowed.
- A combination already used by another action, or by a built-in one, is refused and the message names
  what uses it. Rebind that action first, or clear it.
- Combinations the browser keeps for itself (Ctrl/⌘+T, W, N, R, L, Q, Tab, F5, F11, F12) are refused.
- Modifiers must match exactly: Ctrl+Shift+S does not trigger Ctrl+S.
- On macOS the Alt shortcuts use the physical key, so Alt+T and Alt+1…9 work although macOS types a
  symbol for them.

The overrides are stored as JSON in the `keys.bindings` setting (only keys that differ from the defaults),
so they are included when you export your settings.
