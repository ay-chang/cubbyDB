//! Opens a URL in the user's default browser.

/// Hands `url` to the OS's default opener. Only ever called with URLs the
/// backend itself chose (sign-in pages, the purchase page) — never one
/// supplied by the frontend.
pub fn open(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    command.arg(url).spawn()?;
    Ok(())
}
