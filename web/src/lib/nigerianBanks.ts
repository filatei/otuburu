/**
 * Paystack bank codes for the major Nigerian banks.
 *
 * These codes are stable — Paystack hasn't rotated them in years — so a
 * hardcoded list keeps the withdraw form snappy without an extra round-trip
 * to /bank on every modal open. The list is curated to the 20+ biggest
 * institutions retail customers actually use. A user whose bank isn't here
 * can wait until we proxy Paystack's live /bank endpoint (TODO).
 *
 * Source of truth for each code: a successful /bank/resolve roundtrip on the
 * live Paystack API. Bank names are the customer-facing brand, not the legal
 * name (e.g. "GTBank" not "Guaranty Trust Bank Plc"), since that's what users
 * recognise.
 */
export interface NigerianBank {
  code: string
  name: string
}

export const NIGERIAN_BANKS: NigerianBank[] = [
  { code: '044',   name: 'Access Bank' },
  { code: '063',   name: 'Access Bank (Diamond)' },
  { code: '023',   name: 'Citibank' },
  { code: '050',   name: 'Ecobank Nigeria' },
  { code: '070',   name: 'Fidelity Bank' },
  { code: '011',   name: 'First Bank of Nigeria' },
  { code: '214',   name: 'FCMB' },
  { code: '058',   name: 'GTBank' },
  { code: '030',   name: 'Heritage Bank' },
  { code: '301',   name: 'Jaiz Bank' },
  { code: '082',   name: 'Keystone Bank' },
  { code: '50211', name: 'Kuda Bank' },
  { code: '076',   name: 'Polaris Bank' },
  { code: '101',   name: 'Providus Bank' },
  { code: '221',   name: 'Stanbic IBTC Bank' },
  { code: '068',   name: 'Standard Chartered' },
  { code: '232',   name: 'Sterling Bank' },
  { code: '032',   name: 'Union Bank' },
  { code: '033',   name: 'UBA' },
  { code: '215',   name: 'Unity Bank' },
  { code: '035',   name: 'Wema Bank' },
  { code: '057',   name: 'Zenith Bank' },
]
