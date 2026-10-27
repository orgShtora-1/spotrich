// This is NOT an authentication implementation. Replace this adapter on the
// server with your verified session, authorization, durable store and lock code.
// Keep only stateless services here, never a shared current-user credential.
export const denyHost = Object.freeze({
  async authorizeRequest(_request) {
    // Production: authenticate the HOST session, check Origin/CSRF policy,
    // throttling and consent, then derive the authorized grant key internally.
    // Never trust ?userId=, ?account= or a client-provided grant identifier.
    return null;
  },
  async tokenStoreFor(_grantKey) {
    throw new Error('Configure a durable account-bound TokenStore.');
  },
  async withGrantLock(_grantKey, _operation) {
    throw new Error('Configure a durable cross-worker grant lock.');
  },
});
