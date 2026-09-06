/**
 * Copying, and saying truthfully whether it copied.
 *
 * `navigator.clipboard` is exposed only in a secure context, so on any page that is not HTTPS or
 * localhost it is simply absent. Reaching it with optional chaining resolves as though the copy
 * had happened — which made this report success while nothing reached the clipboard, in the one
 * function whose entire job is telling the operator whether the copy worked. It is checked
 * explicitly instead.
 *
 * The text stays on screen either way, so a refusal costs a select-and-copy rather than the export.
 */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export async function copyToClipboard(
  text: string,
  clipboard: ClipboardLike | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    // Permissions policy, a context without user activation, or a browser that declines. All of
    // them mean the same thing to the person reading the status line: it is not on your clipboard.
    return false;
  }
}

export function copyOutcome(copied: boolean, what: string): string {
  return copied
    ? `${what} copied to the clipboard.`
    : `${what} ready below — the browser refused clipboard access, so select and copy it.`;
}
