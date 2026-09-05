/**
 * Records the connections this deployment's Content Security Policy refuses.
 *
 * A connection blocked by policy and a server that is switched off are the same event to the code
 * that made the request: `fetch` rejects with `TypeError: Failed to fetch` and says nothing about
 * why. The browser does say why — once, on a `securitypolicyviolation` event — and nothing was
 * listening, so a deployment whose policy omitted a homeserver reported a network error and sent
 * whoever read it to check a server that was answering correctly.
 *
 * This listens for those events and remembers which origins were refused, so a failed request can
 * be explained rather than guessed at. It holds origins only: never a path, query, or token.
 */
export interface PolicyViolationLogPort {
  /** Whether this deployment's policy has refused a connection to `url`'s origin. */
  wasBlocked(url: string): boolean;
  /** Every origin refused so far, for diagnostics. */
  blockedOrigins(): readonly string[];
}

interface ViolationEventLike {
  readonly violatedDirective: string;
  readonly effectiveDirective?: string;
  readonly blockedURI: string;
}

interface DocumentLike {
  addEventListener(
    type: 'securitypolicyviolation',
    listener: (event: ViolationEventLike) => void,
  ): void;
  removeEventListener(
    type: 'securitypolicyviolation',
    listener: (event: ViolationEventLike) => void,
  ): void;
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    // `blockedURI` is not always a URL: it can be a keyword such as "inline" or "eval".
    return undefined;
  }
}

export class ContentSecurityPolicyLog implements PolicyViolationLogPort {
  private readonly blocked = new Set<string>();
  private readonly listener = (event: ViolationEventLike): void => {
    const directive = event.effectiveDirective ?? event.violatedDirective;
    // Only connections. A blocked font or image is a deployment mistake too, but it is not the
    // failure this exists to explain, and recording everything would make the set meaningless.
    if (!directive.startsWith('connect-src')) return;
    const origin = originOf(event.blockedURI);
    if (origin) this.blocked.add(origin);
  };

  public constructor(private readonly documentTarget: DocumentLike) {}

  public install(): () => void {
    this.documentTarget.addEventListener('securitypolicyviolation', this.listener);
    return () => this.documentTarget.removeEventListener('securitypolicyviolation', this.listener);
  }

  public wasBlocked(url: string): boolean {
    const origin = originOf(url);
    return origin === undefined ? false : this.blocked.has(origin);
  }

  public blockedOrigins(): readonly string[] {
    return [...this.blocked];
  }
}
