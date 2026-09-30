//! Settings > Help & Feedback: a pre-filled email to support, opened in the
//! user's mail app.

pub const SUPPORT_EMAIL: &str = "support@cubbydb.com";

/// A `mailto:` link whose body ends with the app version and platform, so a
/// reply doesn't have to start by asking for them.
pub fn mailto(version: &str) -> String {
    let body = format!(
        "\n\n\n---\nCubbyDB {version} on {} ({})",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    format!(
        "mailto:{SUPPORT_EMAIL}?subject={}&body={}",
        percent_encode("CubbyDB support"),
        percent_encode(&body)
    )
}

/// RFC 3986 percent-encoding: everything but unreserved characters.
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_carries_subject_version_and_platform() {
        let link = mailto("0.1.21");
        assert!(link.starts_with("mailto:support@cubbydb.com?subject=CubbyDB%20support&body="));
        assert!(link.contains("CubbyDB%200.1.21%20on%20"));
        assert!(link.contains(std::env::consts::OS));
    }

    #[test]
    fn body_is_encoded_so_it_cannot_break_the_link() {
        assert_eq!(percent_encode("a&b=c\n?"), "a%26b%3Dc%0A%3F");
        assert_eq!(percent_encode("é"), "%C3%A9");
        // Only the one separator between subject and body stays literal.
        assert_eq!(mailto("1.0").matches('&').count(), 1);
    }
}
