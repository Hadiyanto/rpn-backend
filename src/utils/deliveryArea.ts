// Delivery destination areas, from the `destination` object of a Biteship rates response
// (docs/plan-paxel-whitelist.md). Biteship uses short level-2 names without "Kota"/"Kabupaten":
// "Jakarta Selatan", "Depok", "Bogor", "Bekasi", "Tangerang" (Kota Tangerang and Cisauk/BSD alike).

export interface BiteshipArea {
    administrative_division_level_1_name?: string | null;
    administrative_division_level_2_name?: string | null;
}

/** Bodetabek level-2 names (DKI Jakarta is matched on the province). */
const JABODETABEK_L2 = ['bogor', 'depok', 'tangerang', 'tangerang selatan', 'bekasi'];

const clean = (name: string | null | undefined) =>
    (name ?? '').toLowerCase().replace(/^(kota|kabupaten|kab\.?)\s+/, '').trim();

/** Jakarta, Bogor, Depok, Tangerang (incl. Tangerang Selatan) or Bekasi — city and regency alike. */
export const isJabodetabek = (area: BiteshipArea) =>
    clean(area.administrative_division_level_1_name).includes('jakarta')
    || JABODETABEK_L2.includes(clean(area.administrative_division_level_2_name));

/**
 * True only for a known destination outside Jabodetabek. An unknown destination (no area in the
 * response) counts as Jabodetabek, so nothing that is limited to "outside" is offered by mistake.
 */
export const isOutsideJabodetabek = (area: BiteshipArea | null | undefined) =>
    !!area && !!clean(area.administrative_division_level_2_name) && !isJabodetabek(area);
