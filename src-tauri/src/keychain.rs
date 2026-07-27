//! OS credential storage for saved-connection passwords — macOS Keychain,
//! Windows Credential Manager, or Linux Secret Service, via the `keyring`
//! crate. Every operation here is best-effort and infallible from the
//! caller's point of view: if the OS store is unavailable (locked,
//! unsupported, permission denied), callers fall back to leaving the
//! password in the JSON file rather than losing it — see `connections.rs`.

use keyring::Entry;

const SERVICE: &str = "cubbydb";

fn entry(account: &str) -> Option<Entry> {
    Entry::new(SERVICE, account).ok()
}

/// Store `password` under `account` (a saved connection's id, or a fixed
/// sentinel for the singleton "last connection" record). `Err` means the
/// keychain wasn't available — the caller should keep the password in place
/// rather than treat this as "no password".
pub fn store_password(account: &str, password: &str) -> Result<(), ()> {
    entry(account).ok_or(())?.set_password(password).map_err(|_| ())
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
