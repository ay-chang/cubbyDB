//! Opens a URL with the user's default handler (browser, or mail app for `mailto:`).

/// Hands `url` to the OS's default opener. Only ever called with URLs the
/// backend itself chose (sign-in pages, the purchase page, support emails) —
/// never one supplied by the frontend.
pub fn open(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    // Not `cmd /C start`: cmd treats `&` as a command separator and would cut
    // the URL off at its second query parameter.
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    command.arg(url).spawn()?;
    Ok(())
}
