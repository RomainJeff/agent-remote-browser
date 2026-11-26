# Changelog

## 2026-11-26

- Recording a playbook: **Add output** now picks the output in the live view instead of asking for a CSS selector. **Text on the page** reads the element you click (nothing is clicked on the page); **Page snapshot** returns the links, buttons and fields the agent can act on next, for the whole page or an area you pick. Every recorded output is kept, so a playbook with several outputs returns them all.

## 2026-11-25

- Fixed: on a device trusted for 30 days, admin sign-in now skips the authenticator code instead of failing with "2FA is not set up".
- Gateway admins can create a one-time password reset link for a member from the Members page. The member picks a new password and keeps their authenticator. The reset signs them out everywhere.
- The admin UI is rebuilt as a React app (TypeScript, Vite, TanStack Router and Query, shadcn/ui), with the same pages and look. The gateway serves the built bundle under a `script-src 'self'` policy; its image builds it in a separate stage and ships no front-end package. Admin URLs change from `#/p/<id>/<tab>` to `#/profiles/<id>?tab=<tab>`; handoff and invite links keep working.

## 2026-11-24

- Authenticator enrollment shows a QR code to scan, with the link as a fallback: on invite acceptance in the admin UI, and in the terminal for `admin create` and `admin reset-2fa`.
- Profile admins share a profile by picking one or more gateway members from a list instead of typing an email.
- Added multi-user gateways with invite links, password and authenticator enrollment, and separate gateway and profile roles. Profiles start private and can be shared with viewers, editors and admins. Agent keys and OAuth grants follow their holder's access. Gateway admins can manage members in the UI, remove their private profiles and preserve shared profiles by transferring administration. Operators can also manage users and issue a key for a named member from the CLI.
