// US-relevant IANA timezones for the shared `TimezoneCombobox`. Reused
// by every form that writes a stake-doc `timezone` field.
//
// Source: IANA tz database `zone.tab` rows whose ISO country code is
// `US` (50 states + DC), plus the inhabited territories the system may
// eventually cover (Puerto Rico, US Virgin Islands, Guam, Northern
// Mariana Islands, American Samoa). The stored value remains the IANA
// name; `display` is a human-readable hint appended in the option label.
//
// We deliberately omit the deprecated/back-compat Indiana sub-zones
// (Knox, Winamac, Petersburg, etc.) and Kentucky/Monticello — they
// either alias to one of the listed canonical zones or cover a
// vanishingly small population. Add them here if a stake ever needs one.

export interface UsTimezoneOption {
  /** Canonical IANA name; this is what gets persisted on the Stake doc. */
  iana: string;
  /** Human-readable hint shown next to the IANA name in the list. */
  display: string;
}

export const US_TIMEZONES: readonly UsTimezoneOption[] = [
  // Continental US
  { iana: 'America/New_York', display: 'Eastern Time (New York)' },
  { iana: 'America/Detroit', display: 'Eastern Time (Detroit)' },
  { iana: 'America/Kentucky/Louisville', display: 'Eastern Time (Louisville)' },
  { iana: 'America/Indiana/Indianapolis', display: 'Eastern Time (Indianapolis)' },
  { iana: 'America/Chicago', display: 'Central Time (Chicago)' },
  { iana: 'America/Denver', display: 'Mountain Time (Denver)' },
  { iana: 'America/Boise', display: 'Mountain Time (Boise)' },
  { iana: 'America/Phoenix', display: 'Mountain Standard Time — no DST (Phoenix)' },
  { iana: 'America/Los_Angeles', display: 'Pacific Time (Los Angeles)' },
  // Alaska + Hawaii
  { iana: 'America/Anchorage', display: 'Alaska Time (Anchorage)' },
  { iana: 'America/Juneau', display: 'Alaska Time (Juneau)' },
  { iana: 'America/Nome', display: 'Alaska Time (Nome)' },
  { iana: 'America/Adak', display: 'Hawaii-Aleutian Time (Adak)' },
  { iana: 'Pacific/Honolulu', display: 'Hawaii-Aleutian Standard Time — no DST (Honolulu)' },
  // US territories
  { iana: 'America/Puerto_Rico', display: 'Atlantic Standard Time (Puerto Rico)' },
  { iana: 'America/St_Thomas', display: 'Atlantic Standard Time (US Virgin Islands)' },
  { iana: 'Pacific/Guam', display: 'Chamorro Standard Time (Guam)' },
  { iana: 'Pacific/Saipan', display: 'Chamorro Standard Time (Northern Mariana Islands)' },
  { iana: 'Pacific/Pago_Pago', display: 'Samoa Standard Time (American Samoa)' },
];

/** Set of canonical IANA names in the list — O(1) "is this in the menu?" check. */
export const US_TIMEZONE_SET = new Set<string>(US_TIMEZONES.map((tz) => tz.iana));
