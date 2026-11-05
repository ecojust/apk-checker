import { describe, expect, it } from "vitest";
import { displayCommand, hasVideoTexture } from "../electron/display";

describe("live display readiness", () => {
  it.each([
    "INFO: Texture: 1080x1920", "INFO: Initial texture: 1080x1920",
    "INFO: Texture (VideoToolbox): 1920x1080",
    "INFO: Texture (D3D11VA): 1920x1080", "INFO: Texture (VA-API): 1920x1080",
  ])("recognizes an actual decoded texture: %s", output => {
    expect(hasVideoTexture(output)).toBe(true);
  });
  it("requires a completed video message, not a server/banner/renderer", () => {
    expect(hasVideoTexture("scrcpy 5.0.1\n[server] INFO: Device: Android\nINFO: Renderer: metal\nINFO: Texture (VideoToolbox): 1920x")).toBe(false);
    expect(hasVideoTexture("INFO: Texture (VideoToolbox): 1920x" + "1080\r\n")).toBe(true);
    expect(hasVideoTexture("Texture: 0x0")).toBe(false);
  });
  it.each(["darwin", "linux", "win32"] as const)("preserves window title arguments on %s without shell interpolation", platform => {
    const args = ["--window-title", "name'; $(touch /tmp/never-execute) `id`", "--serial", "emulator-5554"];
    const command = displayCommand("/application data/scrcpy", args, platform);
    expect(command.args.slice(-args.length)).toEqual(args);
    if (platform === "darwin") {
      expect(command.file).toBe("/usr/bin/script");
      expect(command.args.slice(0, 3)).toEqual(["-q", "/dev/null", "/application data/scrcpy"]);
    } else if (platform === "linux") {
      expect(command.file).toBe("/usr/bin/stdbuf");
      expect(command.args.slice(0, 3)).toEqual(["-oL", "-eL", "/application data/scrcpy"]);
    } else expect(command.file).toBe("/application data/scrcpy");
  });
});
