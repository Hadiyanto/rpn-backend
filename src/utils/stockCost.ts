// Moving weighted-average cost for raw materials.
//
// When stock comes in at a price, the per-unit cost becomes the average of what's already on
// hand and what was just added:  (onHand × currentCost + inQty × inCost) / (onHand + inQty).
// If nothing usable is on hand (qty ≤ 0) or there's no current cost yet, the incoming cost wins.

export const roundCost = (n: number) => Math.round(n * 10000) / 10000;

export const weightedAverageCost = (
    onHandQty: number,
    currentCost: number | null,
    inQty: number,
    inCostPerUnit: number,
): number => {
    if (!(inQty > 0)) return currentCost ?? inCostPerUnit;
    if (currentCost === null || !(onHandQty > 0)) return roundCost(inCostPerUnit);
    return roundCost((onHandQty * currentCost + inQty * inCostPerUnit) / (onHandQty + inQty));
};
