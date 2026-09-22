/** The source UI fixes en-US output despite decimal-comma browser locales; grouping is off by default. */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  if (!Number.isFinite(value)) throw new RangeError("Expected a finite number");
  return new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: 2, ...options }).format(value);
}

/** The source UI normalises decimal commas; accepts either decimal separator and rejects ambiguous grouping. */
export function parseNumber(value: string): number | null {
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(text)) return null;
  const number = Number(text.replace(",", "."));
  return Number.isFinite(number) ? number : null;
}
