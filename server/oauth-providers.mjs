import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export class OAuthError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function oauthConfig(env) {
  return Object.fromEntries(["google", "github"].flatMap((provider) => {
    const clientId = env[`${provider.toUpperCase()}_CLIENT_ID`]?.trim();
    const clientSecret = env[`${provider.toUpperCase()}_CLIENT_SECRET`]?.trim();
    return clientId && clientSecret ? [[provider, { clientId, clientSecret }]] : [];
  }));
}

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { timeoutDuration: 10000 });
const pkce = (verifier) => createHash("sha256").update(verifier).digest("base64url");

async function jsonRequest(fetcher, url, options = {}) {
  const response = await fetcher(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { Accept: "application/json", ...options.headers },
  });
  if (!response.ok) throw new OAuthError("provider");
  const data = await response.json();
  if (!data || data.error) throw new OAuthError("provider");
  return data;
}

// Adapters return a stable subject and a verified email, never client identities.
// Tokens live only during the callback; only the resulting identity is persisted.
export function createOAuthProviders(config = {}, { fetcher = fetch, googleKeySet = googleKeys } = {}) {
  const result = {};
  for (const [id, credentials] of Object.entries(config)) {
    if (!["google", "github"].includes(id)) continue;
    const google = id === "google";
    const authorizationEndpoint = google
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://github.com/login/oauth/authorize";
    result[id] = {
      id,
      name: google ? "Google" : "GitHub",
      authorizationUrl({ state, verifier, nonce, redirectUri }) {
        const url = new URL(authorizationEndpoint);
        url.search = new URLSearchParams({
          client_id: credentials.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: google ? "openid email" : "read:user user:email",
          state,
          code_challenge: pkce(verifier),
          code_challenge_method: "S256",
          ...(google ? { nonce, prompt: "select_account" } : {}),
        }).toString();
        return url.toString();
      },
      async exchange({ code, verifier, nonce, redirectUri }) {
        const tokens = await jsonRequest(fetcher, google
          ? "https://oauth2.googleapis.com/token"
          : "https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
          }).toString(),
        });
        if (google) {
          const { payload } = await jwtVerify(tokens.id_token, googleKeySet, {
            issuer: ["https://accounts.google.com", "accounts.google.com"],
            audience: credentials.clientId,
            algorithms: ["RS256"],
            requiredClaims: ["sub", "exp", "iat", "nonce", "email", "email_verified"],
            maxTokenAge: "10m",
            clockTolerance: 5,
          });
          if (payload.nonce !== nonce || (payload.azp && payload.azp !== credentials.clientId))
            throw new OAuthError("provider");
          if (payload.email_verified !== true) throw new OAuthError("email");
          return { subject: payload.sub, email: payload.email };
        }
        if (typeof tokens.access_token !== "string" || tokens.token_type?.toLowerCase() !== "bearer")
          throw new OAuthError("provider");
        const headers = {
          Authorization: `Bearer ${tokens.access_token}`,
          "User-Agent": "Maildesk",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        const [user, emails] = await Promise.all([
          jsonRequest(fetcher, "https://api.github.com/user", { headers }),
          jsonRequest(fetcher, "https://api.github.com/user/emails?per_page=100", { headers }),
        ]);
        const email = Array.isArray(emails) && emails.find((entry) => entry.primary === true && entry.verified === true)?.email;
        if (!email) throw new OAuthError("email");
        if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new OAuthError("provider");
        return { subject: String(user.id), email };
      },
    };
  }
  return result;
}
