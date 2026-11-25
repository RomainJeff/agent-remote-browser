// Better Auth on the app database: one admin (email + password + mandatory TOTP), the OAuth 2.1 authorization
// server for /mcp (DCR, CIMD, PKCE S256, refresh rotation) and API keys for agents.
// Tables come from migrations/002 (our runner), never from Better Auth's auto-migration.
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { apiKey } from '@better-auth/api-key';
import { oauthProvider } from '@better-auth/oauth-provider';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { hash } from '../policy.ts';
import type { Config } from '../config.ts';

export const PREFIX = { access: 'arb_at_', refresh: 'arb_rt_', secret: 'arb_cs_', apiKey: 'arb_k_' } as const;
export const SCOPES = ['mcp', 'offline_access'];

export interface AuthOptions { baseURL: string; secret: string; trustedOrigins: string[] }
export type Auth = ReturnType<typeof createAuth>['auth'];

/** Same options for the gateway and the CLI: TOTP secrets are encrypted with BETTER_AUTH_SECRET. No auto-creation. */
export function authOptions(cfg: Config): AuthOptions {
  let secret = cfg.authSecret;
  if (!secret) {
    try { secret = readFileSync(cfg.authSecretFile, 'utf8').trim(); }
    catch { throw Error(`BETTER_AUTH_SECRET missing: set it or create ${cfg.authSecretFile} (openssl rand -base64 48)`); }
  }
  if (secret.length < 32) throw Error('BETTER_AUTH_SECRET must be at least 32 characters');
  const admin = [`http://localhost:${cfg.adminPort}`, `http://127.0.0.1:${cfg.adminPort}`];
  return { baseURL: cfg.publicUrl, secret, trustedOrigins: [new URL(cfg.publicUrl).origin, ...admin] };
}

export function createAuth(db: DatabaseSync, o: AuthOptions) {
  // The profile scope chosen on the consent page, handed to Better Auth for the duration of one consent call.
  // ponytail: in memory, keyed by session id; a consent racing another one on the same session takes the last pick.
  const pending = new Map<string, string>();
  const mcp = o.baseURL + '/mcp';
  const auth = betterAuth({
    database: db,
    baseURL: o.baseURL,
    basePath: '/api/auth',
    secret: o.secret,
    appName: 'agent-remote-browser',
    trustedOrigins: o.trustedOrigins,
    telemetry: { enabled: false },
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, revokeSessionsOnPasswordReset: true },
    session: { expiresIn: 12 * 3600, updateAge: 3600 },
    advanced: {
      // Set by the listener (clientIp in server.ts): Cloudflare's value behind the tunnel, else the socket address.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      useSecureCookies: o.baseURL.startsWith('https://'),
    },
    rateLimit: {
      enabled: true, storage: 'database', window: 60, max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/two-factor/*': { window: 60, max: 5 },
        '/oauth2/consent': { window: 60, max: 10 },
        '/oauth2/token': { window: 60, max: 30 },
      },
    },
    plugins: [
      twoFactor({ issuer: 'agent-remote-browser', accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 900 } }),
      apiKey({ defaultPrefix: PREFIX.apiKey, enableMetadata: true, startingCharactersConfig: { charactersLength: 12 }, rateLimit: { enabled: false }, requireName: true }),
      oauthProvider({
        loginPage: '/login',
        consentPage: '/consent',
        scopes: SCOPES,
        grantTypes: ['authorization_code', 'refresh_token'],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: SCOPES,
        clientRegistrationAllowedScopes: SCOPES,
        clientRegistrationRequirePKCE: true,
        clientRegistrationDefaultApplicationType: 'infer', // loopback redirect (CLI agents) = native, https = web
        resources: [mcp],
        clientRegistrationDefaultResources: [mcp],
        clientRegistrationAllowedResources: [mcp],
        disableJwtPlugin: true,
        accessTokenExpiresIn: 3600,
        refreshTokenExpiresIn: 30 * 86400,
        codeExpiresIn: 600,
        // sha256 hex of the token without its prefix: /mcp looks access tokens up the same way.
        storeTokens: { hash: (t) => hash(t) },
        prefix: { opaqueAccessToken: PREFIX.access, refreshToken: PREFIX.refresh, clientSecret: PREFIX.secret },
        postLogin: {
          page: '/consent',
          shouldRedirect: () => false,
          // A consent is stored per scope reference: authorize never finds one (it asks with none), so every
          // connection goes through the consent page and its profile choice.
          consentReferenceId: ({ session }) => pending.get(session.id),
        },
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    ],
  });
  return { auth, pending };
}
