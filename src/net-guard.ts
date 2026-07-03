// net-guard.ts — shared SSRF host/URL validation, used by the request handler
// (resolveSurveyUrl in index.ts) AND per-request by the Browser Rendering
// walker (walker.ts request interception), so redirect hops and subresources
// are re-validated with exactly the same rules as the submitted URL.
//
// Pure string/parse checks only — no DNS resolution. Handles the alternate
// encodings attackers use to smuggle internal addresses past a naive
// dotted-quad check: decimal/octal/hex IPv4 (2130706433, 0x7f000001,
// 0177.0.0.1), shorthand IPv4 (127.1), bracketed IPv6, IPv4-mapped and
// IPv4-compatible IPv6 (::ffff:169.254.169.254, ::ffff:a9fe:a9fe), and the
// NAT64 well-known prefix (64:ff9b::/96).

/** Blocked IPv4 ranges, keyed on the first two octets. */
function isBlockedIpv4(a: number, b: number): boolean {
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    a >= 224 // multicast + reserved
  );
}

/** Parse one IPv4 component in decimal, octal (leading 0), or hex (0x) form. */
function parseIpv4Part(part: string): number | null {
  if (/^0x[0-9a-f]+$/.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]*$/.test(part)) return Number.parseInt(part, 8) || 0;
  if (/^[1-9][0-9]*$/.test(part)) return Number.parseInt(part, 10);
  return null;
}

/**
 * Interpret a hostname as an IPv4 literal in any legacy inet_aton encoding:
 * dotted decimal/octal/hex ("127.0.0.1", "0177.0.0.1", "0x7f.0.0.1") or the
 * 1–3 part shorthands where the final part fills the remaining bytes
 * ("2130706433", "0x7f000001", "127.1"). Returns the four octets, or null
 * when the string is not an IPv4 literal (e.g. a domain name).
 */
function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const n = parseIpv4Part(part);
    if (n === null) return null;
    nums.push(n);
  }
  // First k-1 parts are single octets; the last covers the remaining bytes.
  const last = nums[nums.length - 1];
  const lastMax = 2 ** (8 * (5 - nums.length)) - 1;
  if (last > lastMax) return null;
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 255) return null;
  }
  let value = last;
  for (let i = 0; i < nums.length - 1; i++) {
    value += nums[i] * 2 ** (8 * (3 - i));
  }
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

/** Strict dotted-quad parse for the tail of an IPv6 literal (no shorthand). */
function parseStrictDottedQuad(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return null;
  return [octets[0], octets[1], octets[2], octets[3]];
}

/**
 * Expand an IPv6 literal (brackets already stripped) into its eight 16-bit
 * groups. Handles "::" compression, a dotted-quad tail, and zone ids.
 * Returns null for anything malformed.
 */
function parseIpv6(host: string): number[] | null {
  const zone = host.indexOf("%");
  const addr = zone === -1 ? host : host.slice(0, zone);
  if (!addr.includes(":")) return null;

  const dc = addr.indexOf("::");
  const hasCompression = dc !== -1;
  if (hasCompression && addr.indexOf("::", dc + 1) !== -1) return null; // at most one "::"
  const head = hasCompression ? addr.slice(0, dc) : addr;
  const tail = hasCompression ? addr.slice(dc + 2) : "";

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const raw = s.split(":");
    const groups: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const g = raw[i];
      if (g.includes(".")) {
        // Dotted IPv4 tail — only valid as the final element.
        if (i !== raw.length - 1) return null;
        const v4 = parseStrictDottedQuad(g);
        if (v4 === null) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        groups.push(Number.parseInt(g, 16));
      }
    }
    return groups;
  };

  const headGroups = parseGroups(head);
  const tailGroups = parseGroups(tail);
  if (headGroups === null || tailGroups === null) return null;
  if (hasCompression) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 1) return null;
    const zeros: number[] = new Array<number>(missing).fill(0);
    return [...headGroups, ...zeros, ...tailGroups];
  }
  return headGroups.length === 8 ? headGroups : null;
}

/** Blocked IPv6 space, including addresses that embed a blocked IPv4. */
function isBlockedIpv6(groups: number[]): boolean {
  const zeroThrough = (n: number): boolean => groups.slice(0, n).every((g) => g === 0);
  if (zeroThrough(7) && (groups[7] === 0 || groups[7] === 1)) return true; // :: and ::1
  const g0 = groups[0];
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true; // fc00::/7 ULA
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true; // fe80::/10 link-local
  if (g0 >= 0xff00) return true; // ff00::/8 multicast
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form
  // (::a.b.c.d): both are just IPv4 in disguise — block them outright, as the
  // original hostname check did for "::ffff:". No legitimate survey host is
  // reached via an IPv6-embedded IPv4 literal.
  if (zeroThrough(5) && (groups[5] === 0xffff || groups[5] === 0)) return true;
  // NAT64 well-known prefix 64:ff9b::/96 — translates to the embedded IPv4 in
  // the final 32 bits (groups[6..7]). The /96 prefix means groups[2..5] are
  // zero; groups[0..1] are the 64:ff9b marker (NOT zero), so this must check
  // the middle groups explicitly rather than a zeroThrough over the marker.
  if (
    g0 === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    return isBlockedIpv4(groups[6] >> 8, groups[6] & 0xff);
  }
  // 6to4 (2002::/16) embeds the IPv4 in the next 32 bits (groups[1..2]); a
  // 6to4 address wrapping a private/link-local IPv4 must be blocked exactly as
  // the bare IPv4 would be. The first two octets (groups[1]) fully determine
  // every blocked IPv4 range.
  if (g0 === 0x2002) {
    return isBlockedIpv4(groups[1] >> 8, groups[1] & 0xff);
  }
  return false;
}

/**
 * True when the hostname points at loopback/private/link-local/metadata space —
 * anything Browser Rendering must never be aimed at. Accepts bare hostnames,
 * IPv4 in any encoding, and IPv6 with or without brackets. Malformed
 * IPv6-looking hosts fail closed (blocked).
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === "") return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return true;
  }

  // IPv6 literals: URL.hostname keeps the surrounding brackets.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.includes(":")) {
    const groups = parseIpv6(bare);
    if (groups === null) return true; // fail closed on malformed IPv6
    return isBlockedIpv6(groups);
  }

  const v4 = parseIpv4(bare);
  if (v4 !== null) return isBlockedIpv4(v4[0], v4[1]);

  return false; // ordinary public domain name
}

/**
 * True when a raw URL must not be fetched: unparseable, a non-http(s) scheme
 * (file:, ftp:, gopher:, ...), or a blocked hostname. Used per-request by the
 * walker so every redirect hop and subresource is re-validated.
 */
export function isBlockedUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  return isBlockedHostname(parsed.hostname);
}
