// Thin hand-written type declaration for the vendored personal-dimensions.mjs (see VENDORED.md).

export declare const FORBIDDEN_PERSONAL_DIMENSION_KEYS: Set<string>;

/** Recursively scans `value` for forbidden personal-dimension keys (case-sensitive, anywhere
 * in the structure). Returns the dotted/indexed paths where a violation was found. */
export declare function scanPersonalDimensions(value: unknown, pathStr?: string): string[];
