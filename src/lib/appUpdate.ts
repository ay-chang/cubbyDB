import { relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";

/**
 * Downloads and installs `update`, then relaunches the app — the one bit
 * shared between the launch-time banner (`UpdateBanner`) and the Settings
 * "Check for Updates" button, so both install the same way. Everything
 * else (when to check, how to show progress/errors) differs enough between
 * the two call sites to stay local to each component.
 */
export async function installUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
  await relaunch();
}
