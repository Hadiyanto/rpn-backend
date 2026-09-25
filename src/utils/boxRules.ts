// Product rules per box type (confirmed with the owner):
//  - HALF ("Box Kecil"): exactly 1 flavor, uses half of a FULL-box recipe.
//  - FULL ("Box Besar"): 1–3 different flavors mixed freely.
// These are the defaults when a box is created and the fallback when a menu row lacks a value.
export const BOX_TYPES = ['FULL', 'HALF'] as const;
export type BoxType = typeof BOX_TYPES[number];

export interface BoxRule {
    max_flavors: number;
    /** Hard upper limit an admin can't exceed for this box type. */
    max_flavors_limit: number;
    box_multiplier: number;
    weight_gram: number;
    length_cm: number;
    width_cm: number;
    height_cm: number;
}

export const DEFAULT_BOX_RULES: Record<BoxType, BoxRule> = {
    FULL: { max_flavors: 3, max_flavors_limit: 3, box_multiplier: 1, weight_gram: 1000, length_cm: 20, width_cm: 20, height_cm: 10 },
    HALF: { max_flavors: 1, max_flavors_limit: 1, box_multiplier: 0.5, weight_gram: 500, length_cm: 10, width_cm: 10, height_cm: 10 },
};

export const isBoxType = (value: unknown): value is BoxType => BOX_TYPES.includes(value as BoxType);

export const boxRule = (boxType: string): BoxRule | undefined => (isBoxType(boxType) ? DEFAULT_BOX_RULES[boxType] : undefined);
