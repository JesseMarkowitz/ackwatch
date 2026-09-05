import { bundledAlertTone } from './alert-tone';

/**
 * Lets a deployment replace the alert sound by dropping a file next to `index.html`.
 *
 * The bundled tone has to suit everyone, which means it suits nobody's room particularly well: an
 * alert competing with a noisy workshop and one sitting beside a sleeping household want opposite
 * things. A deployer drops in `alert-tone.wav` or `alert-tone.mp3` and it is used instead, with no
 * rebuild and no setting.
 *
 * The candidates are probed once per session rather than at every alert. **On a deployment with no
 * custom tone both probes return 404, and the browser logs that** — it is expected, and it is why
 * the soak's console classifier names this request. That cost buys a drop-in file with no build
 * step, which is the point.
 */
export const CUSTOM_TONE_CANDIDATES = ['./alert-tone.wav', './alert-tone.mp3'] as const;

export interface ResolvedAlertTone {
  /** What to hand an audio element. */
  readonly source: string;
  /** The deployment's file, when one was found, for an interface that should say which played. */
  readonly custom: string | undefined;
}

export type TonePresenceProbe = (url: string) => Promise<boolean>;

/**
 * A HEAD request rather than a media load: it settles without decoding, and a deployment that
 * serves an HTML error page for a missing file is rejected on its status rather than by waiting
 * for an audio element to fail to parse it.
 */
export const fetchProbe: TonePresenceProbe = async (url) => {
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) return false;
    const type = response.headers.get('content-type') ?? '';
    // A static host that answers every path with index.html would otherwise hand us a web page to
    // play. Anything that is not audio is treated as absent.
    return type === '' || type.startsWith('audio/') || type === 'application/octet-stream';
  } catch {
    return false;
  }
};

export async function resolveAlertTone(
  probe: TonePresenceProbe = fetchProbe,
  candidates: readonly string[] = CUSTOM_TONE_CANDIDATES,
): Promise<ResolvedAlertTone> {
  for (const candidate of candidates) {
    if (await probe(candidate)) return { source: candidate, custom: candidate };
  }
  return { source: bundledAlertTone, custom: undefined };
}
