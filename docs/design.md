# Admin UI design

How the admin UI looks and why. The rules below apply to every change in `src/admin/ui/`. Values live in `src/admin/ui/styles.css`: if this page and the stylesheet disagree, the stylesheet wins and this page gets fixed. Overview: [README](../README.md). Code layout: [reference.md](reference.md).

The admin is a professional tool first. Its identity comes from one idea, applied everywhere, not from decoration.

## The control tab

Every live browser view sits in a frame with a tab on top that says who is driving. The frame and the tab take the driver's color:

| Who drives | Frame and tab | Tab label |
|---|---|---|
| An agent | Solid teal | `An agent is driving`, with the lease time left |
| You (take over, recording) | Solid ink | `You have control`, `You are recording` |
| An agent waits for a person | Dashed amber, light amber tab | `An agent is waiting` |
| Nobody, or stopped | Grey, dashed when stopped or empty | `Nobody`, `Stopped`, `Never started` |

The same colors carry the same meaning wherever the driver shows up: the state token in the profiles table, the badge in the navigation, the mobile request screen, the empty state. Nothing else uses them.

## Colors

Name tokens by role, never by hue (`--agent`, not `--teal-600`), so a color cannot be borrowed for emphasis.

| Token | Light | Dark | Use for |
|---|---|---|---|
| `--ink` | `#15181B` | `#EDEEEF` | Text, primary buttons, your control, focus rings |
| `--ink-2` | `#4D5459` | `#A9B0B5` | Secondary text |
| `--ink-3` | `#687076` | `#8C949A` | Captions, table headers, timestamps |
| `--canvas` | `#F4F5F5` | `#0F1214` | App background and sidebar |
| `--surface` | `#FFFFFF` | `#161A1D` | Main panel, cards, dialogs |
| `--surface-2` | `#F8F9F9` | `#1C2124` | Table headers, address bar |
| `--line` | `#E3E6E8` | `#262B2F` | Panel and table borders |
| `--line-soft` | `#EEF0F1` | `#22272B` | Row dividers |
| `--line-strong` | `#CDD2D5` | `#363C41` | Inputs, secondary buttons |
| `--agent` | `#0B6B6F` | `#3FB6B2` | An agent drives; values an agent fills (playbook inputs) |
| `--agent-soft` / `--agent-ink` | `#E2F0F0` / `#06595C` | | Backgrounds and text on agent elements |
| `--needs-you` | `#F2A81D` | | An agent waits for a person: banner, tab, nav badge, table row |
| `--needs-you-soft` / `--needs-you-ink` | `#FDF1D8` / `#774B00` | | Backgrounds and text on those elements |
| `--danger` | `#C43D2B` | | The confirm button of an irreversible action, inside its dialog |

- Errors in forms and failed calls are ink with an icon, not red. Success is plain text or a toast, not green.
- The dark column is a target, not shipped yet. When it ships, the agent tab uses dark text on the lighter teal, and the website inside the frame stays as the site renders it.

## Type

- Instrument Sans for everything, weights 400, 500 and 600. Self-hosted: the admin CSP allows fonts only from `'self'`.
- The system monospace stack (`ui-monospace`, SF Mono, Menlo, Consolas) only for domains, URLs, keys, tool names, cookie names and codes.
- Sizes: 13 for captions, 13.5 for tables and buttons, 14 for body, 15 for the page title in the header bar, 16 for dialog titles, 20 for sign-in screens.
- Tabular numbers for timers, durations and counts.
- Sentence case everywhere.

## Shape and layout

- Radii: 5 for state tokens, 7 for controls, 10 for panels and frames, 12 for the main panel, cards and dialogs.
- Shadows only on dialogs and popovers. Cards and panels use a 1px border.
- Spacing steps of 4: 8, 12, 16, 20, 24, 28.
- Desktop: sidebar 228px on the canvas color, main panel on the surface color with an 8px margin. Header bar 56px with the title or breadcrumb on the left and actions on the right. Tab bar 42px, active tab underlined 2px in ink.
- Mobile: one column, primary action 44px tall, the request first and the frame below it.

## Components

| Component | Use it for | Not for |
|---|---|---|
| Frame and tab | Every live browser view | Anything that is not a browser |
| State token | Who drives a profile, one per table row | A generic badge or tag |
| Table | Lists: profiles, members, logins, calls, cookies | Two or three facts, use a definition list |
| Request banner | An agent asking for help, its words quoted | Any other notice |
| Dialog | Confirmations and short create forms | Long forms, use a page or a tab |
| Primary button (ink) | The main action of a view or dialog, one per area | |
| Secondary button (outlined) | Other actions | |
| Text button | Low-emphasis actions: `Use a backup code`, `Cancel` in a choice | Destructive actions |
| Numbered steps | Playbook steps, recording, procedures run on the host | Bullet lists |
| Disclosure | Rare or advanced content | Content most people need |
| Nav badge (amber count) | Agents waiting for a person | Any other count |

- A destructive dialog names what is destroyed. For a profile it asks to type its name, and for a code when the action is sensitive.
- An agent's words are quoted and attributed, never phrased as an instruction from the UI.

## Writing

The copy rules in [AGENTS.md](../AGENTS.md) apply: every visible word is UI, start by asking what can be removed. In addition:

- Name the actor: `An agent is driving`, not `Session active`.
- Relative times (`2 min ago`), the exact time on hover.
- Buttons say what happens: `Take over`, `Create invite link`, `Delete permanently`.

## Don't

- No pills or chips as decoration. Chips only for values you can edit, such as allowed domains.
- No uppercase or letter-spaced labels above sections.
- No `·` between facts: use a comma or a second line.
- No second accent color, gradients, illustrations or emoji.
- No colored icons in the navigation.
- No teal, amber or red outside their role, even for emphasis.

## Screens

The current screens are captured by the `ui-diff` skill from the routes in `ui-diff.config.json`. That capture set is the catalogue: add a new page's route there in the same PR.
