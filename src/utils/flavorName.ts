/**
 * Stored order item name for the chosen flavors, in the order form's format
 * (rpn-frontend/utils/flavors.ts buildSelection): one flavor → its name, several → "Mix A Dan B",
 * sorted in plain code-unit order so existing names don't change.
 */
export const flavorName = (names: string[]): string => {
    const sorted = names.map(n => n.trim()).filter(Boolean).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return sorted.length > 1 ? `Mix ${sorted.join(' Dan ')}` : sorted[0] ?? '';
};
