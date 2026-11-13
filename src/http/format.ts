// Readable numbers and times for the dashboard (PBI 189): tokens in thousands or millions, cost to the cent, how long
// a stage attempt took, and a time in the viewer's own time zone.

/** A token count: as is under 1,000, else thousands or millions to 1 decimal place, rounding half up. */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  // Whole tenths of a thousand, so rounding never meets a binary fraction: 1050 is 10.5 tenths, so 1.1k.
  const tenthsK = Math.round(n / 100);
  if (tenthsK < 10_000) return `${(tenthsK / 10).toFixed(1)}k`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1)}m`;
}

/**
 * A cost in US dollars to the cent, rounding half up on the decimal digits, so $1.235 is $1.24 though 1.235 is just
 * under it in binary. A cost above zero that rounds to nothing shows "<$0.01", so a cheap call never reads as free.
 */
export function cost(usd: string | number | null | undefined): string {
  const s = typeof usd === "number" ? usd.toFixed(12) : String(usd ?? "0").trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return `$${s}`;
  const frac = (m[2] ?? "").padEnd(3, "0");
  const cents = BigInt(m[1] || "0") * 100n + BigInt(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1n : 0n);
  if (cents === 0n) return /[1-9]/.test(frac) ? "<$0.01" : "$0.00";
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

/** How long from start to end: minutes and seconds under an hour, hours and minutes from an hour on. */
export function timeSpent(start: Date, end: Date): string {
  const secs = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** A time to the minute in the IANA zone, as "YYYY-MM-DD HH:MM". */
export function localTime(at: Date, zone: string): string {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formats.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** The time zone the viewer's browser sent in its `tz` cookie, or UTC when it sent none or one that isn't a zone. */
export function zoneFrom(cookieHeader: string | undefined): string {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k !== "tz") continue;
    try {
      const zone = decodeURIComponent(v.join("="));
      // Throws on a name that isn't a zone. The name comes back as sent, so the page's script sees its own zone.
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return zone;
    } catch {
      return "UTC";
    }
  }
  return "UTC";
}
