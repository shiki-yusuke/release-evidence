// Shared minimal JSON Schema (draft 2020-12 subset) validator: type, const, enum, pattern,
// minLength, minimum, exclusiveMinimum, exclusiveMaximum, maxItems, minItems, uniqueItems,
// required, properties, additionalProperties (boolean `false`, closing an object, or a schema,
// applied to every instance property not named in `properties` -- e.g. a session_id-keyed
// dictionary), items, allOf, if/then/else, not, oneOf, and $ref (to a
// sibling schema file, or to a local #/$defs/... pointer). Extracted out
// of contracts/agent-metrics/v1/verify-fixtures.mjs so every contract's verify script shares
// one implementation instead of re-implementing it. This is exactly the subset this repo's
// schemas use -- it is not a general draft 2020-12 implementation, and does not replace a
// real validator (e.g. ajv) for schemas outside this repo.
//
// `oneOf` was added 2026-08-23 (I-2026-08-23-shared-validator-oneof, sol architect review):
// before this, a property whose schema was `{"oneOf": [...]}` with no sibling allOf/if-then
// enforcement -- release-evidence-bundle.schema.json's `lane_ref` and `review` were the only two
// such properties in any schema this repo owns -- accepted ANY value, because `oneOf` was silently
// ignored. See contracts/shared/schema-validator.selftest.mjs for the regression this closes.
//
// Usage: const { validate } = createValidator(schemaDir); validate("some.schema.json", instance)
// `schemaDir` is the directory $ref filenames are resolved relative to (normally the calling
// contract's own directory, so "envelope.schema.json" means "<schemaDir>/envelope.schema.json").

import { readFileSync } from "node:fs";
import path from "node:path";

export function createValidator(schemaDir) {
  const schemaFileCache = new Map();

  function loadSchemaFile(filename) {
    if (!schemaFileCache.has(filename)) {
      const text = readFileSync(path.join(schemaDir, filename), "utf-8");
      schemaFileCache.set(filename, JSON.parse(text));
    }
    return schemaFileCache.get(filename);
  }

  function resolvePointer(doc, pointer) {
    // pointer looks like "#/$defs/tokenUsageRecord"
    const parts = pointer.replace(/^#\//, "").split("/").filter(Boolean);
    let node = doc;
    for (const part of parts) node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    return node;
  }

  function resolveRef(ref, currentDoc) {
    if (ref.startsWith("#/")) {
      return { schema: resolvePointer(currentDoc, ref), doc: currentDoc };
    }
    const [filename, pointer] = ref.split("#");
    const doc = loadSchemaFile(filename);
    if (!pointer) return { schema: doc, doc };
    return { schema: resolvePointer(doc, "#" + pointer), doc };
  }

  function typeOf(instance) {
    if (instance === null) return "null";
    if (Array.isArray(instance)) return "array";
    if (typeof instance === "number") return Number.isInteger(instance) ? "integer" : "number";
    return typeof instance; // "string" | "object" | "boolean"
  }

  function validateAgainst(schema, instance, currentDoc, pathStr, errors) {
    if (schema.$ref) {
      const { schema: refSchema, doc: refDoc } = resolveRef(schema.$ref, currentDoc);
      validateAgainst(refSchema, instance, refDoc, pathStr, errors);
      return;
    }
    if (schema.allOf) {
      // Composes with every other keyword on the same schema object (does not return early)
      // -- correct draft 2020-12 semantics, and needed so a schema can carry its own
      // required/properties/additionalProperties at the top level *and* a set of per-relation
      // if/then conditionals via allOf, both applying together. No existing schema in this
      // repo combines allOf with sibling keywords in a way this change alters (agent-metrics/
      // v1's token-usage.schema.json's only top-level keys besides allOf are $schema/$id/
      // title/description, none of which this validator interprets), so this is safe.
      for (const sub of schema.allOf) validateAgainst(sub, instance, currentDoc, pathStr, errors);
    }
    // if/then/else: `if` is evaluated in an isolated error list (never leaked into the
    // caller's `errors` on its own) purely to decide which branch applies; only the chosen
    // branch's errors (if any) are appended to `errors`. This composes with every other
    // keyword on the same schema object -- it does not return early -- so a schema can mix
    // e.g. `required` with a conditional `if/then` at the same level.
    if (schema.if) {
      const ifErrors = [];
      validateAgainst(schema.if, instance, currentDoc, pathStr, ifErrors);
      const branch = ifErrors.length === 0 ? schema.then : schema.else;
      if (branch) validateAgainst(branch, instance, currentDoc, pathStr, errors);
    }
    // `not`: the instance must NOT validate against schema.not. Evaluated the same way as
    // `if` -- into an isolated error list purely to decide whether schema.not "passed" (zero
    // errors = the instance DOES match it, which is the failure case here). Composes with
    // every other keyword on the same schema object.
    if (schema.not) {
      const notErrors = [];
      validateAgainst(schema.not, instance, currentDoc, pathStr, notErrors);
      if (notErrors.length === 0) {
        errors.push(`${pathStr}: instance must not validate against the "not" schema, but it does`);
      }
    }
    // `oneOf`: the instance must validate against EXACTLY ONE of the listed subschemas -- zero
    // matches and two-or-more matches are both invalid. Each branch is trialed into its OWN
    // isolated error list, same discipline as `if`/`not` above, so a non-matching branch's
    // errors never leak into the caller's `errors`; only the count of clean (zero-error) trials
    // decides the verdict. Composes with every other keyword on the same schema object -- does
    // not return early, same discipline as `allOf` above -- and each branch is evaluated with the
    // SAME `currentDoc`, so a `$ref` inside a branch resolves exactly as it would outside one.
    if (schema.oneOf) {
      const matched = schema.oneOf.filter((sub) => {
        const branchErrors = [];
        validateAgainst(sub, instance, currentDoc, pathStr, branchErrors);
        return branchErrors.length === 0;
      }).length;
      if (matched !== 1) {
        errors.push(`${pathStr}: oneOf expected exactly one subschema to match, matched ${matched}`);
      }
    }
    if (schema.const !== undefined && instance !== schema.const) {
      errors.push(`${pathStr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(instance)}`);
    }
    if (schema.enum && !schema.enum.includes(instance)) {
      errors.push(`${pathStr}: ${JSON.stringify(instance)} not in enum ${JSON.stringify(schema.enum)}`);
    }
    if (schema.type) {
      // `type` may be a single string or (draft 2020-12) an array of alternatives, e.g.
      // ["integer", "null"] for a nullable numeric field -- needed by contracts that
      // represent "genuinely unmeasured" as null rather than 0 (never collapse the two).
      const actual = typeOf(instance);
      const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
      const ok = allowed.some((t) => actual === t || (t === "number" && actual === "integer"));
      if (!ok) errors.push(`${pathStr}: expected type ${JSON.stringify(schema.type)}, got ${actual}`);
    }
    if (schema.pattern && typeof instance === "string" && !new RegExp(schema.pattern).test(instance)) {
      errors.push(`${pathStr}: ${JSON.stringify(instance)} does not match pattern ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && typeof instance === "string" && instance.length < schema.minLength) {
      errors.push(`${pathStr}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.minimum !== undefined && typeof instance === "number" && instance < schema.minimum) {
      errors.push(`${pathStr}: ${instance} < minimum ${schema.minimum}`);
    }
    if (schema.exclusiveMinimum !== undefined && typeof instance === "number" && instance <= schema.exclusiveMinimum) {
      errors.push(`${pathStr}: ${instance} must be > exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && typeof instance === "number" && instance >= schema.exclusiveMaximum) {
      errors.push(`${pathStr}: ${instance} must be < exclusiveMaximum ${schema.exclusiveMaximum}`);
    }
    if (Array.isArray(instance)) {
      if (schema.maxItems !== undefined && instance.length > schema.maxItems) {
        errors.push(`${pathStr}: array length ${instance.length} > maxItems ${schema.maxItems}`);
      }
      if (schema.minItems !== undefined && instance.length < schema.minItems) {
        errors.push(`${pathStr}: array length ${instance.length} < minItems ${schema.minItems}`);
      }
      if (schema.uniqueItems) {
        // Equality is JSON.stringify comparison, not structural deep-equality -- two objects
        // with the same keys in a different insertion order would stringify differently and
        // so would NOT be caught as duplicates here. Every current use of uniqueItems in this
        // repo is over arrays of plain strings (e.g. impact-scan/v1's candidate_paths), where
        // this limitation cannot bite; it would need a real deep-equality check before this
        // keyword is applied to arrays of objects.
        const seen = new Set();
        instance.forEach((item, i) => {
          const key = JSON.stringify(item);
          if (seen.has(key)) errors.push(`${pathStr}[${i}]: duplicate item, uniqueItems requires no repeats`);
          seen.add(key);
        });
      }
      if (schema.items) {
        instance.forEach((item, i) => validateAgainst(schema.items, item, currentDoc, `${pathStr}[${i}]`, errors));
      }
    }
    if (instance !== null && typeof instance === "object" && !Array.isArray(instance)) {
      if (schema.required) {
        for (const key of schema.required) {
          if (!(key in instance)) errors.push(`${pathStr}: missing required property "${key}"`);
        }
      }
      if (schema.properties) {
        for (const [key, subSchema] of Object.entries(schema.properties)) {
          if (key in instance) validateAgainst(subSchema, instance[key], currentDoc, `${pathStr}.${key}`, errors);
        }
      }
      if (schema.additionalProperties === false) {
        const known = new Set(Object.keys(schema.properties || {}));
        for (const key of Object.keys(instance)) {
          if (!known.has(key)) errors.push(`${pathStr}: additional property "${key}" not allowed`);
        }
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        // measure/v1 addition: a dictionary keyed by an arbitrary runtime value (e.g.
        // session_id), where every value must match one shared schema -- draft 2020-12's
        // ordinary meaning of `additionalProperties` as a schema, not just the boolean-false
        // "closed object" form every other schema in this repo has used so far. Safe to add:
        // no existing schema file sets `additionalProperties` to anything but `false` (or
        // leaves it unset), so this branch is unreachable for every previously-frozen
        // contract and only activates for a schema that opts into it.
        const known = new Set(Object.keys(schema.properties || {}));
        for (const [key, value] of Object.entries(instance)) {
          if (known.has(key)) continue;
          validateAgainst(schema.additionalProperties, value, currentDoc, `${pathStr}.${key}`, errors);
        }
      }
    }
  }

  function validate(schemaFilename, instance) {
    const doc = loadSchemaFile(schemaFilename);
    const errors = [];
    validateAgainst(doc, instance, doc, "$", errors);
    return errors;
  }

  return { validate, loadSchemaFile, resolveRef, resolvePointer, typeOf, validateAgainst };
}
