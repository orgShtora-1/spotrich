// Server-only configuration. Error messages name the variable, never its value.
export function requiredEnv(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('replace_with_')) {
    throw new Error(`Configure ${name} privately on the server.`);
  }
  return value;
}

export function oauthCredentials(env) {
  const mode = requiredEnv(env, 'SPOTIFY_OAUTH_MODE');
  const clientId = requiredEnv(env, 'SPOTIFY_CLIENT_ID');
  if (mode === 'pkce') return { mode, clientId };
  if (mode === 'confidential') {
    return { mode, clientId, clientSecret: requiredEnv(env, 'SPOTIFY_CLIENT_SECRET') };
  }
  throw new Error('SPOTIFY_OAUTH_MODE must be pkce or confidential.');
}
