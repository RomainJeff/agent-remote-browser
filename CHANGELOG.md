# Changelog

## 2026-11-24

- Authenticator enrollment shows a QR code to scan, with the link as a fallback: on invite acceptance in the admin UI, and in the terminal for `admin create` and `admin reset-2fa`.
- Profile admins share a profile by picking one or more gateway members from a list instead of typing an email.
- Added multi-user gateways with invite links, password and authenticator enrollment, and separate gateway and profile roles. Profiles start private and can be shared with viewers, editors and admins. Agent keys and OAuth grants follow their holder's access. Gateway admins can manage members in the UI, remove their private profiles and preserve shared profiles by transferring administration. Operators can also manage users and issue a key for a named member from the CLI.
