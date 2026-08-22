//! Opens a bastion SSH connection and a `direct-tcpip` channel through it to
//! the real database host, exposing the channel as a plain async stream —
//! `postgres.rs`'s `establish()` hands it straight to
//! `tokio_postgres::Config::connect_raw` exactly as if it were a normal TCP
//! socket. Everything downstream of that call (query execution, paging,
//! reconnect) has no idea a tunnel is involved.

use std::path::Path;
use std::sync::{Arc, Mutex};

use russh::client;
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelStream;

use super::{DbError, DbErrorKind, SshAuthMethod, SshTunnelParams};
use crate::ssh_known_hosts::SshKnownHostsStore;

/// Keeps the bastion connection alive for as long as a tunneled session
/// needs its channel. `channel_open_direct_tcpip` borrows the `Handle`
/// rather than consuming it, so the channel it returns only stays usable
/// while this is still alive — dropping it drops the whole bastion
/// connection (and, with it, every channel multiplexed over it, though this
/// app only ever opens one per tunnel).
pub struct SshTunnelHandle(#[allow(dead_code)] client::Handle<TofuHandler>);

/// Opens the tunnel and hands back a stream to `target_host:target_port`,
/// as seen from the bastion, plus the handle that has to outlive it.
pub async fn open_tunnel(
    params: &SshTunnelParams,
    target_host: &str,
    target_port: u16,
    data_dir: &Path,
) -> Result<(ChannelStream<client::Msg>, SshTunnelHandle), DbError> {
    let bastion_host = params
        .bastion_host
        .as_deref()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| {
            DbError::new(
                DbErrorKind::Connection,
                "SSH tunnel is on but no bastion host is set.",
            )
        })?;
    let bastion_port = params.bastion_port;
    let bastion_user = params
        .bastion_user
        .as_deref()
        .filter(|u| !u.is_empty())
        .ok_or_else(|| {
            DbError::new(
                DbErrorKind::Connection,
                "SSH tunnel is on but no bastion user is set.",
            )
        })?;
    let addr = format!("{bastion_host}:{bastion_port}");

    let handler = TofuHandler {
        known_hosts: SshKnownHostsStore::new(data_dir),
        host: bastion_host.to_string(),
        port: bastion_port,
    };
    let config = Arc::new(client::Config::default());
    let mut handle = client::connect(config, addr.clone(), handler)
        .await
        .map_err(|e| {
            DbError::new(
                DbErrorKind::Connection,
                format!("Could not reach SSH bastion {addr}: {e}"),
            )
        })?;

    let auth_result = match &params.auth {
        SshAuthMethod::Password { password } => {
            let password = password.clone().unwrap_or_default();
            handle
                .authenticate_password(bastion_user, password)
                .await
        }
        SshAuthMethod::PrivateKey {
            key_contents,
            passphrase,
        } => {
            let key_contents = key_contents.as_deref().filter(|k| !k.is_empty()).ok_or_else(|| {
                DbError::new(
                    DbErrorKind::Connection,
                    "SSH tunnel is set to private-key auth but no key was provided.",
                )
            })?;
            let key = decode_secret_key(key_contents, passphrase.as_deref()).map_err(|e| {
                DbError::new(
                    DbErrorKind::Connection,
                    format!("Could not read the SSH private key: {e}"),
                )
            })?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), None);
            handle.authenticate_publickey(bastion_user, key).await
        }
        // Requesting identities from ssh-agent and signing through it needs
        // its own `Signer` adapter (`AgentClient` doesn't implement one
        // itself) — left for later rather than shipped half-verified.
        // Password and private-key auth cover a bastion by themselves.
        SshAuthMethod::Agent => {
            return Err(DbError::new(
                DbErrorKind::Connection,
                "SSH agent authentication isn't supported yet — use a password or private key.",
            ));
        }
    }
    .map_err(|e| {
        DbError::new(
            DbErrorKind::Connection,
            format!("SSH authentication to {addr} failed for user \"{bastion_user}\": {e}"),
        )
    })?;

    if !auth_result.success() {
        return Err(DbError::new(
            DbErrorKind::Connection,
            format!("SSH authentication to {addr} failed for user \"{bastion_user}\"."),
        ));
    }

    let channel = handle
        .channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| {
            DbError::new(
                DbErrorKind::Connection,
                format!("Bastion {addr} could not reach {target_host}:{target_port}: {e}"),
            )
        })?;

    Ok((channel.into_stream(), SshTunnelHandle(handle)))
}

/// `russh::client::Handler` that only ever *checks* a host key against the
/// stored fingerprint — it never prompts and never writes to the trust
/// store. Trusting a key happens exclusively through the separate
/// `trust_ssh_host_key` command, itself only reachable after the frontend's
/// own TOFU confirmation UI, so a rejected or not-yet-verified key can't be
/// bypassed by simply retrying a connect.
pub(crate) struct TofuHandler {
    pub(crate) known_hosts: SshKnownHostsStore,
    pub(crate) host: String,
    pub(crate) port: u16,
}

impl client::Handler for TofuHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = fingerprint_of(server_public_key);
        let trusted = self.known_hosts.lookup(&self.host, self.port).ok().flatten();
        Ok(matches!(trusted, Some(t) if t.key_fingerprint == fingerprint))
    }
}

/// `"ssh-ed25519"`, `"ecdsa-sha2-nistp256"`, etc. — shown alongside the
/// fingerprint in the TOFU confirmation UI, same as `ssh-keygen -l`'s own
/// output.
pub(crate) fn key_type_of(key: &PublicKeyOrCertificate) -> String {
    match key {
        PublicKeyOrCertificate::PublicKey { key, .. } => key.algorithm().to_string(),
        PublicKeyOrCertificate::Certificate(cert) => cert.public_key().algorithm().to_string(),
    }
}

/// `SHA256:<base64>` — the same format `ssh-keygen -l` prints, so a user
/// comparing it against their own terminal (or against what a colleague
/// pastes them) is comparing like with like. Shared by the enforcement
/// handler above and the `probe_ssh_host_key` command.
pub(crate) fn fingerprint_of(key: &PublicKeyOrCertificate) -> String {
    // The two variants' `.public_key()`/`key` accessors return different
    // underlying types (a full `PublicKey` vs. a certificate's raw key
    // data), so `.fingerprint(..).to_string()` is called inside each arm
    // rather than unifying to a shared binding first — both arms still
    // resolve to a plain `String`, which is all that has to match.
    match key {
        PublicKeyOrCertificate::PublicKey { key, .. } => {
            key.fingerprint(HashAlg::Sha256).to_string()
        }
        PublicKeyOrCertificate::Certificate(cert) => {
            cert.public_key().fingerprint(HashAlg::Sha256).to_string()
        }
    }
}

/// A bastion's host key, read without authenticating — what
/// `probe_ssh_host_key` hands back for the frontend's trust-on-first-use UI.
pub struct ProbedHostKey {
    pub fingerprint: String,
    pub key_type: String,
}

/// Connects just far enough to read the bastion's host key and no further —
/// no authentication is ever attempted, and the key is deliberately
/// *rejected* the instant it's captured (see `ProbeHandler` below), so this
/// touches nothing on the bastion beyond a TCP connect and key exchange.
/// Trusting what it reads is a separate, later step
/// (`SshKnownHostsStore::trust`, driven by the user's own confirmation) —
/// this function only ever reads, never writes.
pub async fn probe_host_key(host: &str, port: u16) -> Result<ProbedHostKey, DbError> {
    let captured: Arc<Mutex<Option<ProbedHostKey>>> = Arc::new(Mutex::new(None));
    let handler = ProbeHandler {
        captured: captured.clone(),
    };
    let config = Arc::new(client::Config::default());
    let addr = format!("{host}:{port}");

    // Rejecting the key in the handler (see below) makes `connect` itself
    // return an `Err` even on a fully successful probe — that's expected,
    // not a failure, so the real success/failure signal is whether
    // `captured` actually got filled, checked before this result is looked
    // at for anything else.
    let connect_result = client::connect(config, addr.clone(), handler).await;
    if let Some(probed) = captured.lock().expect("probe capture lock poisoned").take() {
        return Ok(probed);
    }
    match connect_result {
        Ok(_) => Err(DbError::new(
            DbErrorKind::Connection,
            format!("Connected to {addr} without completing key exchange — could not read its host key."),
        )),
        Err(e) => Err(DbError::new(
            DbErrorKind::Connection,
            format!("Could not reach SSH bastion {addr}: {e}"),
        )),
    }
}

struct ProbeHandler {
    captured: Arc<Mutex<Option<ProbedHostKey>>>,
}

impl client::Handler for ProbeHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        *self.captured.lock().expect("probe capture lock poisoned") = Some(ProbedHostKey {
            fingerprint: fingerprint_of(server_public_key),
            key_type: key_type_of(server_public_key),
        });
        // Reject on purpose: the probe only wants the key, not a live
        // session, and returning `false` here ends the handshake cleanly
        // right after key exchange instead of completing a connection that
        // would then need its own separate teardown.
        Ok(false)
    }
}
