// 'HAMPERS' can still appear on historical orders; label anything that isn't FULL/HALF generically.
export const boxLabel = (boxType: string) =>
    boxType === 'FULL' ? 'Full Box' : boxType === 'HALF' ? 'Half Box' : boxType;
