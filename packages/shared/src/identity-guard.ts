// Single source of truth for the B3 identity guard, imported by BOTH the real
// plugin (code.ts) and the mock plugin so the refusal contract is byte-identical.
export const isTargetMismatch = (
  localFileKey: string | null,
  targetFileKey: string | null | undefined,
): boolean =>
  localFileKey !== null &&
  targetFileKey !== null &&
  targetFileKey !== undefined &&
  localFileKey !== targetFileKey

export const targetGuardError = (
  targetFileKey: string,
  ownFileKey: string,
): string =>
  `Command addressed to file "${targetFileKey}" but this plugin is bound to file "${ownFileKey}"; refusing to execute (identity guard, principle B3).`
