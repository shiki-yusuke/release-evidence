// Thin hand-written type declaration for the vendored schema-validator.mjs (see VENDORED.md).

export interface SchemaValidator {
  /** Validates `instance` against the named schema file (resolved relative to the schemaDir
   * passed to createValidator). Returns a list of human-readable error strings; empty = valid. */
  validate(schemaFilename: string, instance: unknown): string[];
  loadSchemaFile(filename: string): unknown;
  resolveRef(ref: string, currentDoc: unknown): { schema: unknown; doc: unknown };
  resolvePointer(doc: unknown, pointer: string): unknown;
  typeOf(instance: unknown): string;
  validateAgainst(
    schema: unknown,
    instance: unknown,
    currentDoc: unknown,
    pathStr: string,
    errors: string[],
  ): void;
}

/** `schemaDir` is the directory $ref filenames (and validate()'s schemaFilename) are resolved
 * relative to -- normally the release-evidence/v0 contracts directory. */
export declare function createValidator(schemaDir: string): SchemaValidator;
