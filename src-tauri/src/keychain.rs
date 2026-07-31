//! Read-only access to the OS keychain (macOS Keychain, Windows Credential
//! Manager, Linux Secret Service, via the `keyring` crate) for saved
//! connection passwords. This app no longer stores anything *into* the
//! keychain — see the module docs on `connections.rs` for why — so this
//! module exists purely so `connections::pull_back_from_keychain` can pull
//! passwords back out for anyone upgrading from a version that did.

use keyring::Entry;

const SERVICE: &str = "cubbydb";

fn entry(account: &str) -> Option<Entry> {
    Entry::new(SERVICE, account).ok()
}

/// Best-effort lookup — `None` covers both "no keychain entry" and "keychain
/// unavailable"; callers can't distinguish the two and don't need to.
pub fn load_password(account: &str) -> Option<String> {
    entry(account)?.get_password().ok()
}

/// Best-effort delete; a missing entry (or an unavailable keychain) is not
/// an error worth surfacing.
pub fn delete_password(account: &str) {
    if let Some(e) = entry(account) {
        let _ = e.delete_credential();
    }
}
