import addressparser from "nodemailer/lib/addressparser";

export interface Address {
  name?: string;
  address: string;
}

/** "Name <a@b.c>, d@e.f" or ["a@b.c", ...] → addresses (groups flattened, invalid entries dropped) */
export function parseAddressList(input: string | string[] | undefined): Address[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input.join(", ") : input;
  const out: Address[] = [];
  const walk = (list: ReturnType<typeof addressparser>) => {
    for (const a of list) {
      if ("group" in a && a.group) walk(a.group);
      else if ("address" in a && a.address && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.address)) {
        out.push(a.name ? { name: a.name, address: a.address } : { address: a.address });
      }
    }
  };
  walk(addressparser(raw));
  return out;
}

export function formatAddress(a: { name?: string; address?: string }): string {
  if (!a.address) return a.name ?? "";
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function formatAddresses(list: { name?: string; address?: string }[] | undefined): string {
  return (list ?? []).map(formatAddress).filter(Boolean).join(", ");
}

export const sameAddress = (a: string | undefined, b: string | undefined) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** drop duplicates (case-insensitive) and any address in `exclude` */
export function dedupe(list: Address[], exclude: string[] = []): Address[] {
  const seen = new Set(exclude.map((e) => e.toLowerCase()));
  return list.filter((a) => {
    const k = a.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
