/** scrcpy 5 writes INFO to buffered stdout on Unix. Supply a terminal/line
 * buffer so video readiness arrives while the window is still open. */
export function displayCommand(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === "darwin") {
    // BSD script passes command arguments directly to execvp, without a shell.
    // Closing its PTY sends SIGHUP to the owned foreground display process.
    return { file: "/usr/bin/script", args: ["-q", "/dev/null", executable, ...args] };
  }
  if (platform === "linux") {
    // Linux development/CI hosts provide GNU coreutils; stdbuf execs scrcpy.
    return { file: "/usr/bin/stdbuf", args: ["-oL", "-eL", executable, ...args] };
  }
  // The upstream Windows binary explicitly disables stdout buffering.
  return { file: executable, args };
}

export function hasVideoTexture(output: string): boolean {
  return /(?:initial\s+)?texture(?:\s+\([^\r\n)]+\))?:\s*[1-9]\d*x[1-9]\d*/i.test(output);
}
