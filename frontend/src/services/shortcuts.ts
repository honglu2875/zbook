function currentPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

export function usesCommandKey(platform = currentPlatform()): boolean {
  return /^(Mac|iPhone|iPad|iPod)/i.test(platform);
}

export function primaryShortcut(
  key: string,
  options: { shift?: boolean; platform?: string } = {},
): string {
  if (usesCommandKey(options.platform ?? currentPlatform())) {
    return `${options.shift ? "⇧" : ""}⌘${key}`;
  }
  return `Ctrl+${options.shift ? "Shift+" : ""}${key}`;
}
