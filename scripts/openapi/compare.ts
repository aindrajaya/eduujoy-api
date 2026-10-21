// Structural comparison of the exported OpenAPI document with the frozen contract.
// Documentation-only keys are ignored; everything a client depends on is compared.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = Record<string, Json>;

export interface OpenApiDoc {
  paths?: Record<string, Record<string, Json>>;
  security?: Json;
  components?: Record<string, Record<string, Json>>;
}

/** A known, approved difference, e.g. a contract parameter whose slice has not landed yet. */
export interface ContractException {
  method: string;
  path: string;
  parameter: { in: string; name: string };
  reason: string;
}

export interface Comparison {
  errors: string[];
  notImplemented: string[];
  excepted: string[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const IGNORED_KEYS = new Set(['description', 'title', 'example', 'examples', 'externalDocs', 'xml', 'deprecated', 'summary']);

/** Scalars as text; objects as JSON (never "[object Object]"). */
const text = (value: Json | undefined): string => (typeof value === 'string' ? value : JSON.stringify(value ?? null));

const isObj = (value: Json | undefined): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

function resolve(doc: OpenApiDoc, value: Json | undefined): Json | undefined {
  let current = value;
  for (let hops = 0; isObj(current) && typeof current.$ref === 'string' && hops < 20; hops += 1) {
    const [, , section, name] = current.$ref.split('/');
    current = section && name ? doc.components?.[section]?.[name] : undefined;
  }
  return current;
}

/** Canonical form of a schema: refs inlined, allOf merged, 3.0/3.1 nullability and const unified. */
export function normalizeSchema(doc: OpenApiDoc, schema: Json | undefined, seen: string[] = []): Json {
  if (!isObj(schema)) return schema ?? null;
  if (typeof schema.$ref === 'string') {
    if (seen.includes(schema.$ref)) return { $cycle: schema.$ref };
    return normalizeSchema(doc, resolve(doc, schema), [...seen, schema.$ref]);
  }

  let out: Obj = {};
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      const normalized = normalizeSchema(doc, part, seen);
      if (isObj(normalized)) out = mergeSchemas(out, normalized);
    }
  }

  const types = new Set<string>();
  const enumValues: Json[] = [];
  let hasEnum = false;
  for (const [key, raw] of Object.entries(schema)) {
    if (IGNORED_KEYS.has(key) || key === 'allOf') continue;
    if (key === 'type') (Array.isArray(raw) ? raw : [raw]).forEach((t) => types.add(text(t)));
    else if (key === 'nullable') {
      if (raw === true) types.add('null');
    } else if (key === 'const') {
      hasEnum = true;
      enumValues.push(raw);
    } else if (key === 'enum' && Array.isArray(raw)) {
      hasEnum = true;
      for (const v of raw) {
        if (v === null) types.add('null');
        else enumValues.push(v);
      }
    } else if (key === 'properties' && isObj(raw)) {
      out.properties = Object.fromEntries(
        Object.keys(raw)
          .sort()
          .map((name) => [name, normalizeSchema(doc, raw[name], seen)]),
      );
    } else if (key === 'items' || (key === 'additionalProperties' && isObj(raw))) {
      out[key] = normalizeSchema(doc, raw, seen);
    } else if (key === 'required' && Array.isArray(raw)) {
      if (raw.length > 0) out.required = [...raw].map(String).sort();
    } else {
      out[key] = raw;
    }
  }
  if (types.size > 0) out.type = [...new Set([...(Array.isArray(out.type) ? out.type.map(String) : []), ...types])].sort();
  // A bare `null` added by nullable/enum means nothing without a base type from the other side.
  if (Array.isArray(out.type) && out.type.length === 1 && out.type[0] === 'null' && !hasEnum) delete out.type;
  if (hasEnum) out.enum = [...enumValues].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return sortDeep(out);
}

function mergeSchemas(a: Obj, b: Obj): Obj {
  const merged: Obj = { ...a, ...b };
  if (isObj(a.properties) || isObj(b.properties)) {
    merged.properties = { ...(isObj(a.properties) ? a.properties : {}), ...(isObj(b.properties) ? b.properties : {}) };
  }
  const required = [...(Array.isArray(a.required) ? a.required : []), ...(Array.isArray(b.required) ? b.required : [])];
  if (required.length > 0) merged.required = [...new Set(required.map(String))].sort();
  if (Array.isArray(a.type) || Array.isArray(b.type)) {
    merged.type = [...new Set([...(Array.isArray(a.type) ? a.type : []), ...(Array.isArray(b.type) ? b.type : [])].map(String))].sort();
  }
  return merged;
}

function sortDeep(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isObj(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortDeep(value[k] ?? null)]));
}

/** Lists where two normalized values differ, as JSON-pointer-like paths. */
export function diff(a: Json | undefined, b: Json | undefined, at = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diff(a[k], b[k], `${at}/${k}`));
  }
  return [`${at || '/'}: api=${JSON.stringify(a)} contract=${JSON.stringify(b)}`];
}

function operations(doc: OpenApiDoc): Map<string, Obj> {
  const ops = new Map<string, Obj>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (isObj(op)) ops.set(`${method.toUpperCase()} ${path}`, op);
    }
  }
  return ops;
}

function effectiveSecurity(doc: OpenApiDoc, op: Obj): Json {
  const security = op.security ?? doc.security ?? [];
  return sortDeep(Array.isArray(security) ? [...security].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : security);
}

function parameters(doc: OpenApiDoc, op: Obj): Map<string, Json> {
  const out = new Map<string, Json>();
  for (const raw of Array.isArray(op.parameters) ? op.parameters : []) {
    const p = resolve(doc, raw);
    if (!isObj(p)) continue;
    const key = `${text(p.in)}:${text(p.name)}`;
    out.set(key, { required: p.required === true, schema: normalizeSchema(doc, p.schema) });
  }
  return out;
}

function content(doc: OpenApiDoc, holder: Json | undefined): Json {
  const resolved = resolve(doc, holder);
  if (!isObj(resolved) || !isObj(resolved.content)) return {};
  const media = resolved.content;
  return Object.fromEntries(
    Object.keys(media)
      .sort()
      .map((type) => {
        const entry = media[type];
        return [type, normalizeSchema(doc, isObj(entry) ? entry.schema : undefined)];
      }),
  );
}

export function compareToContract(api: OpenApiDoc, contract: OpenApiDoc, exceptions: ContractException[] = []): Comparison {
  const errors: string[] = [];
  const excepted: string[] = [];
  const apiOps = operations(api);
  const contractOps = operations(contract);

  for (const [key, op] of apiOps) {
    const expected = contractOps.get(key);
    if (!expected) {
      errors.push(`${key}: not in the contract`);
      continue;
    }
    const report = (where: string, a: Json | undefined, b: Json | undefined): void => {
      for (const d of diff(a, b)) errors.push(`${key} ${where} ${d}`);
    };

    report('operationId', op.operationId ?? null, expected.operationId ?? null);
    report('security', effectiveSecurity(api, op), effectiveSecurity(contract, expected));

    const apiParams = parameters(api, op);
    const contractParams = parameters(contract, expected);
    for (const name of [...new Set([...apiParams.keys(), ...contractParams.keys()])].sort()) {
      const [where, paramName] = name.split(':') as [string, string];
      const exception = exceptions.find(
        (e) => `${e.method.toUpperCase()} ${e.path}` === key && e.parameter.in === where && e.parameter.name === paramName,
      );
      if (exception && !apiParams.has(name)) {
        excepted.push(`${key} parameter ${name}: ${exception.reason}`);
        continue;
      }
      report(`parameter ${name}`, apiParams.get(name) ?? null, contractParams.get(name) ?? null);
    }

    const apiBody = resolve(api, op.requestBody);
    const contractBody = resolve(contract, expected.requestBody);
    report(
      'requestBody',
      apiBody === undefined ? null : { required: isObj(apiBody) && apiBody.required === true, content: content(api, apiBody) },
      contractBody === undefined ? null : { required: isObj(contractBody) && contractBody.required === true, content: content(contract, contractBody) },
    );

    const apiResponses = isObj(op.responses) ? op.responses : {};
    const contractResponses = isObj(expected.responses) ? expected.responses : {};
    report('response codes', Object.keys(apiResponses).sort(), Object.keys(contractResponses).sort());
    for (const status of Object.keys(apiResponses).filter((s) => s in contractResponses).sort()) {
      report(`response ${status}`, content(api, apiResponses[status]), content(contract, contractResponses[status]));
    }
  }

  errors.push(...staleExceptions(api, contract, apiOps, contractOps, exceptions));
  const notImplemented = [...contractOps.keys()].filter((key) => !apiOps.has(key)).sort();
  return { errors, notImplemented, excepted };
}

/**
 * An exception must keep suppressing a real difference: it is stale once the contract drops the
 * parameter or the API implements it. Exceptions for operations not built yet stay valid.
 */
function staleExceptions(
  api: OpenApiDoc,
  contract: OpenApiDoc,
  apiOps: Map<string, Obj>,
  contractOps: Map<string, Obj>,
  exceptions: ContractException[],
): string[] {
  return exceptions.flatMap((e) => {
    const key = `${e.method.toUpperCase()} ${e.path}`;
    const param = `${e.parameter.in}:${e.parameter.name}`;
    const label = `exception ${key} ${param} is no longer needed`;
    const fix = 'remove it from CONTRACT_EXCEPTIONS';
    const contractOp = contractOps.get(key);
    if (!contractOp || !parameters(contract, contractOp).has(param)) return [`${label} (not in the contract): ${fix}`];
    const apiOp = apiOps.get(key);
    if (apiOp && parameters(api, apiOp).has(param)) return [`${label} (the API implements it): ${fix}`];
    return [];
  });
}
