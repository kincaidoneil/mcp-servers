// Unit conversion for the Hevy bridge. Hevy stores metric only, but the display
// config (see config.ts) renders imperial, so pounds cross this boundary in both
// directions and the conversion has to live in one place.
//
// Writes used to be metric-only, which left the conversion to the caller. A
// model asked for 75 lb picked the tidy-looking 34 kg, and Hevy showed the set
// back as 74.96 lb. The read path hid it: rendering rounds to one decimal, so
// 34 kg printed as "75lb" and the mistake looked correct on read-back.

export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

export const lbToKg = (lb: number): number => lb * KG_PER_LB;
export const kgToLb = (kg: number): number => kg / KG_PER_LB;
export const inToCm = (inches: number): number => inches * CM_PER_IN;
export const cmToIn = (cm: number): number => cm / CM_PER_IN;
