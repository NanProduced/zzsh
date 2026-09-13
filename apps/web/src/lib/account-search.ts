import type { AccountCardData } from "../components/delta/account-card";

// ponytail: searches loaded public accounts only; use server search when pagination lands.
export function searchAccounts(accounts: AccountCardData[], query: string): AccountCardData[] {
  const terms = query.normalize("NFKC").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return accounts;
  return accounts.filter(({ id, title }) => {
    const text = `${id} ${title}`.normalize("NFKC").toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
