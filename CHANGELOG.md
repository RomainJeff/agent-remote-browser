# Changelog

## 2026-11-26

- Authenticator enrollment shows a setup key to type into the app instead of an `otpauth://` link, next to the QR code: on invite acceptance in the admin UI, and in the terminal for `admin create`, `user create` and `admin reset-2fa`. The invite API returns `setupKey` instead of `totpURI`.
- Recording a playbook, **Add output** now picks what the agent gets back from the page instead of asking for a CSS selector: **Text on the page** reads the value you click (a total, a status, a date), **Page snapshot** keeps the links, buttons and fields the agent can act on next, for the whole page or an area you click. Every recorded output is returned, not only the last one.
- Redesigned the admin UI around who is driving each browser. Every live view sits in a frame whose tab names the driver: teal while an agent drives, ink while you have control or record, dashed amber while an agent waits for you. The profiles list groups profiles by who needs you, and an agent's help request opens as a banner with its words quoted. Recordings and playbooks read as numbered sentences, with inputs marked. Profile tabs, Members (invites listed with members, role picked when inviting), Agent access (one table, with "Connect an agent" for OAuth or an API key), Security and the sign-in, invite and password screens follow the same layout. The font is Instrument Sans, self-hosted. On a phone, the sidebar becomes a tab bar at the bottom, and the account opens from the avatar in the header. The Domains URL tester and the logins' last use are no longer shown.

## 2026-11-25

- Fixed: on a device trusted for 30 days, admin sign-in now skips the authenticator code instead of failing with "2FA is not set up".
- Gateway admins can create a one-time password reset link for a member from the Members page. The member picks a new password and keeps their authenticator. The reset signs them out everywhere.
- The admin UI is rebuilt as a React app (TypeScript, Vite, TanStack Router and Query, shadcn/ui), with the same pages and look. The gateway serves the built bundle under a `script-src 'self'` policy; its image builds it in a separate stage and ships no front-end package. Admin URLs change from `#/p/<id>/<tab>` to `#/profiles/<id>?tab=<tab>`; handoff and invite links keep working.

## 2026-11-24

- Authenticator enrollment shows a QR code to scan, with the link as a fallback: on invite acceptance in the admin UI, and in the terminal for `admin create` and `admin reset-2fa`.
- Profile admins share a profile by picking one or more gateway members from a list instead of typing an email.
- Added multi-user gateways with invite links, password and authenticator enrollment, and separate gateway and profile roles. Profiles start private and can be shared with viewers, editors and admins. Agent keys and OAuth grants follow their holder's access. Gateway admins can manage members in the UI, remove their private profiles and preserve shared profiles by transferring administration. Operators can also manage users and issue a key for a named member from the CLI.
