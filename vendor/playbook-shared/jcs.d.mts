// Thin hand-written type declaration for the vendored jcs.mjs (see VENDORED.md). Not
// generated -- kept in sync by hand whenever the vendored file is refreshed, because the
// vendored source is deliberately plain JS (no allowJs; see VENDORED.md for why).

/** RFC 8785 JCS canonicalization (subset: nested plain objects/arrays of strings and
 * non-negative integers, no floats, no non-ASCII keys -- see the vendored file's own header). */
export declare function canonicalize(value: unknown): string;

/** sha256 hex digest of a string or byte buffer. */
export declare function sha256hex(bufOrStr: string | Buffer | Uint8Array): string;
