export type EgressPolicy = "open" | "block-metadata" | "block-private";

export interface EgressDecision {
  allowed: boolean;
  reason?: string;
}

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "fd00:ec2::254",
]);

/**
 * The tool fetches what the operator points it at, including localhost targets,
 * so loopback is allowed. Cloud metadata endpoints are never a legitimate agent
 * target and are denied by default; "block-private" additionally refuses RFC1918,
 * CGNAT and unique-local ranges for operators who want a strict profile.
 */
export function checkEgress(target: string, policy: EgressPolicy = "block-metadata"): EgressDecision {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: "Only HTTP(S) is allowed" };
  }
  if (policy === "open") return { allowed: true };

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (METADATA_HOSTS.has(host)) {
    return { allowed: false, reason: "Cloud metadata endpoints are blocked" };
  }
  if (policy === "block-metadata") return { allowed: true };

  const ip = ipv4(host);
  if (!ip) {
    const lower = host.toLowerCase();
    if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
      return { allowed: false, reason: "Private host names are blocked by the current egress policy" };
    }
    return { allowed: true };
  }
  if (ip.loopback) return { allowed: false, reason: "Loopback is blocked by the current egress policy" };
  if (ip.private) return { allowed: false, reason: "Private networks are blocked by the current egress policy" };
  if (ip.linkLocal) return { allowed: false, reason: "Link-local addresses are blocked" };
  return { allowed: true };
}

function ipv4(host: string): { private: boolean; loopback: boolean; linkLocal: boolean } | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return null;
  const [a, b] = octets as [number, number, number, number];
  const loopback = a === 127;
  const linkLocal = a === 169 && b === 254;
  const privateRange =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 0);
  return { private: privateRange, loopback, linkLocal };
}
