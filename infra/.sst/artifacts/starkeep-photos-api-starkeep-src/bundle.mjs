import { createRequire as topLevelCreateRequire } from 'module';
const require = topLevelCreateRequire(import.meta.url);
import { fileURLToPath as topLevelFileUrlToPath, URL as topLevelURL } from "url"
const __filename = topLevelFileUrlToPath(import.meta.url)
const __dirname = topLevelFileUrlToPath(new topLevelURL(".", import.meta.url))

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/photos-handler.ts
import { createHash } from "node:crypto";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import pg from "pg";

// ../../node_modules/.pnpm/ulidx@2.4.1/node_modules/ulidx/dist/node/index.js
import crypto from "node:crypto";

// ../../node_modules/.pnpm/layerr@3.0.0/node_modules/layerr/dist/error.js
function assertError(err) {
  if (!isError(err)) {
    throw new Error("Parameter was not an error");
  }
}
__name(assertError, "assertError");
function isError(err) {
  return !!err && typeof err === "object" && objectToString(err) === "[object Error]" || err instanceof Error;
}
__name(isError, "isError");
function objectToString(obj) {
  return Object.prototype.toString.call(obj);
}
__name(objectToString, "objectToString");

// ../../node_modules/.pnpm/layerr@3.0.0/node_modules/layerr/dist/global.js
var NAME = "Layerr";
var __name2 = NAME;
function getGlobalName() {
  return __name2;
}
__name(getGlobalName, "getGlobalName");

// ../../node_modules/.pnpm/layerr@3.0.0/node_modules/layerr/dist/tools.js
function parseArguments(args) {
  let options, shortMessage = "";
  if (args.length === 0) {
    options = {};
  } else if (isError(args[0])) {
    options = {
      cause: args[0]
    };
    shortMessage = args.slice(1).join(" ") || "";
  } else if (args[0] && typeof args[0] === "object") {
    options = Object.assign({}, args[0]);
    shortMessage = args.slice(1).join(" ") || "";
  } else if (typeof args[0] === "string") {
    options = {};
    shortMessage = shortMessage = args.join(" ") || "";
  } else {
    throw new Error("Invalid arguments passed to Layerr");
  }
  return {
    options,
    shortMessage
  };
}
__name(parseArguments, "parseArguments");

// ../../node_modules/.pnpm/layerr@3.0.0/node_modules/layerr/dist/layerr.js
var Layerr = class _Layerr extends Error {
  static {
    __name(this, "Layerr");
  }
  constructor(errorOptionsOrMessage, messageText) {
    const args = [...arguments];
    const { options, shortMessage } = parseArguments(args);
    let message = shortMessage;
    if (options.cause) {
      message = `${message}: ${options.cause.message}`;
    }
    super(message);
    this.message = message;
    if (options.name && typeof options.name === "string") {
      this.name = options.name;
    } else {
      this.name = getGlobalName();
    }
    if (options.cause) {
      Object.defineProperty(this, "_cause", { value: options.cause });
    }
    Object.defineProperty(this, "_info", { value: {} });
    if (options.info && typeof options.info === "object") {
      Object.assign(this._info, options.info);
    }
    if (Error.captureStackTrace) {
      const ctor = options.constructorOpt || this.constructor;
      Error.captureStackTrace(this, ctor);
    }
  }
  static cause(err) {
    assertError(err);
    if (!err._cause)
      return null;
    return isError(err._cause) ? err._cause : null;
  }
  static fullStack(err) {
    assertError(err);
    const cause = _Layerr.cause(err);
    if (cause) {
      return `${err.stack}
caused by: ${_Layerr.fullStack(cause)}`;
    }
    return err.stack ?? "";
  }
  static info(err) {
    assertError(err);
    const output = {};
    const cause = _Layerr.cause(err);
    if (cause) {
      Object.assign(output, _Layerr.info(cause));
    }
    if (err._info) {
      Object.assign(output, err._info);
    }
    return output;
  }
  toString() {
    let output = this.name || this.constructor.name || this.constructor.prototype.name;
    if (this.message) {
      output = `${output}: ${this.message}`;
    }
    return output;
  }
};

// ../../node_modules/.pnpm/ulidx@2.4.1/node_modules/ulidx/dist/node/index.js
var ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
var ENCODING_LEN = 32;
var TIME_MAX = 281474976710655;
var TIME_LEN = 10;
var RANDOM_LEN = 16;
var ERROR_INFO = Object.freeze({
  source: "ulid"
});
function detectPRNG(root) {
  const rootLookup = root || detectRoot();
  const globalCrypto = rootLookup && (rootLookup.crypto || rootLookup.msCrypto) || (typeof crypto !== "undefined" ? crypto : null);
  if (typeof globalCrypto?.getRandomValues === "function") {
    return () => {
      const buffer = new Uint8Array(1);
      globalCrypto.getRandomValues(buffer);
      return buffer[0] / 255;
    };
  } else if (typeof globalCrypto?.randomBytes === "function") {
    return () => globalCrypto.randomBytes(1).readUInt8() / 255;
  } else if (crypto?.randomBytes) {
    return () => crypto.randomBytes(1).readUInt8() / 255;
  }
  throw new Layerr({
    info: {
      code: "PRNG_DETECT",
      ...ERROR_INFO
    }
  }, "Failed to find a reliable PRNG");
}
__name(detectPRNG, "detectPRNG");
function detectRoot() {
  if (inWebWorker())
    return self;
  if (typeof window !== "undefined") {
    return window;
  }
  if (typeof global !== "undefined") {
    return global;
  }
  if (typeof globalThis !== "undefined") {
    return globalThis;
  }
  return null;
}
__name(detectRoot, "detectRoot");
function encodeRandom(len, prng) {
  let str = "";
  for (; len > 0; len--) {
    str = randomChar(prng) + str;
  }
  return str;
}
__name(encodeRandom, "encodeRandom");
function encodeTime(now, len) {
  if (isNaN(now)) {
    throw new Layerr({
      info: {
        code: "ENC_TIME_NAN",
        ...ERROR_INFO
      }
    }, `Time must be a number: ${now}`);
  } else if (now > TIME_MAX) {
    throw new Layerr({
      info: {
        code: "ENC_TIME_SIZE_EXCEED",
        ...ERROR_INFO
      }
    }, `Cannot encode a time larger than ${TIME_MAX}: ${now}`);
  } else if (now < 0) {
    throw new Layerr({
      info: {
        code: "ENC_TIME_NEG",
        ...ERROR_INFO
      }
    }, `Time must be positive: ${now}`);
  } else if (Number.isInteger(now) === false) {
    throw new Layerr({
      info: {
        code: "ENC_TIME_TYPE",
        ...ERROR_INFO
      }
    }, `Time must be an integer: ${now}`);
  }
  let mod, str = "";
  for (let currentLen = len; currentLen > 0; currentLen--) {
    mod = now % ENCODING_LEN;
    str = ENCODING.charAt(mod) + str;
    now = (now - mod) / ENCODING_LEN;
  }
  return str;
}
__name(encodeTime, "encodeTime");
function incrementBase32(str) {
  let done = void 0, index = str.length, char, charIndex, output = str;
  const maxCharIndex = ENCODING_LEN - 1;
  while (!done && index-- >= 0) {
    char = output[index];
    charIndex = ENCODING.indexOf(char);
    if (charIndex === -1) {
      throw new Layerr({
        info: {
          code: "B32_INC_ENC",
          ...ERROR_INFO
        }
      }, "Incorrectly encoded string");
    }
    if (charIndex === maxCharIndex) {
      output = replaceCharAt(output, index, ENCODING[0]);
      continue;
    }
    done = replaceCharAt(output, index, ENCODING[charIndex + 1]);
  }
  if (typeof done === "string") {
    return done;
  }
  throw new Layerr({
    info: {
      code: "B32_INC_INVALID",
      ...ERROR_INFO
    }
  }, "Failed incrementing string");
}
__name(incrementBase32, "incrementBase32");
function inWebWorker() {
  return typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
}
__name(inWebWorker, "inWebWorker");
function monotonicFactory(prng) {
  const currentPRNG = prng || detectPRNG();
  let lastTime = 0, lastRandom;
  return /* @__PURE__ */ __name(function _ulid(seedTime) {
    const seed = isNaN(seedTime) ? Date.now() : seedTime;
    if (seed <= lastTime) {
      const incrementedRandom = lastRandom = incrementBase32(lastRandom);
      return encodeTime(lastTime, TIME_LEN) + incrementedRandom;
    }
    lastTime = seed;
    const newRandom = lastRandom = encodeRandom(RANDOM_LEN, currentPRNG);
    return encodeTime(seed, TIME_LEN) + newRandom;
  }, "_ulid");
}
__name(monotonicFactory, "monotonicFactory");
function randomChar(prng) {
  let rand = Math.floor(prng() * ENCODING_LEN);
  if (rand === ENCODING_LEN) {
    rand = ENCODING_LEN - 1;
  }
  return ENCODING.charAt(rand);
}
__name(randomChar, "randomChar");
function replaceCharAt(str, index, char) {
  if (index > str.length - 1) {
    return str;
  }
  return str.substr(0, index) + char + str.substr(index + 1);
}
__name(replaceCharAt, "replaceCharAt");

// ../../node_modules/.pnpm/valibot@1.3.1_typescript@5.9.3/node_modules/valibot/dist/index.mjs
var store$4;
// @__NO_SIDE_EFFECTS__
function getGlobalConfig(config$1) {
  return {
    lang: config$1?.lang ?? store$4?.lang,
    message: config$1?.message,
    abortEarly: config$1?.abortEarly ?? store$4?.abortEarly,
    abortPipeEarly: config$1?.abortPipeEarly ?? store$4?.abortPipeEarly
  };
}
__name(getGlobalConfig, "getGlobalConfig");
var store$3;
// @__NO_SIDE_EFFECTS__
function getGlobalMessage(lang) {
  return store$3?.get(lang);
}
__name(getGlobalMessage, "getGlobalMessage");
var store$2;
// @__NO_SIDE_EFFECTS__
function getSchemaMessage(lang) {
  return store$2?.get(lang);
}
__name(getSchemaMessage, "getSchemaMessage");
var store$1;
// @__NO_SIDE_EFFECTS__
function getSpecificMessage(reference, lang) {
  return store$1?.get(reference)?.get(lang);
}
__name(getSpecificMessage, "getSpecificMessage");
// @__NO_SIDE_EFFECTS__
function _stringify(input) {
  const type = typeof input;
  if (type === "string") return `"${input}"`;
  if (type === "number" || type === "bigint" || type === "boolean") return `${input}`;
  if (type === "object" || type === "function") return (input && Object.getPrototypeOf(input)?.constructor?.name) ?? "null";
  return type;
}
__name(_stringify, "_stringify");
function _addIssue(context, label, dataset, config$1, other) {
  const input = other && "input" in other ? other.input : dataset.value;
  const expected = other?.expected ?? context.expects ?? null;
  const received = other?.received ?? /* @__PURE__ */ _stringify(input);
  const issue = {
    kind: context.kind,
    type: context.type,
    input,
    expected,
    received,
    message: `Invalid ${label}: ${expected ? `Expected ${expected} but r` : "R"}eceived ${received}`,
    requirement: context.requirement,
    path: other?.path,
    issues: other?.issues,
    lang: config$1.lang,
    abortEarly: config$1.abortEarly,
    abortPipeEarly: config$1.abortPipeEarly
  };
  const isSchema = context.kind === "schema";
  const message$1 = other?.message ?? context.message ?? /* @__PURE__ */ getSpecificMessage(context.reference, issue.lang) ?? (isSchema ? /* @__PURE__ */ getSchemaMessage(issue.lang) : null) ?? config$1.message ?? /* @__PURE__ */ getGlobalMessage(issue.lang);
  if (message$1 !== void 0) issue.message = typeof message$1 === "function" ? message$1(issue) : message$1;
  if (isSchema) dataset.typed = false;
  if (dataset.issues) dataset.issues.push(issue);
  else dataset.issues = [issue];
}
__name(_addIssue, "_addIssue");
// @__NO_SIDE_EFFECTS__
function _getStandardProps(context) {
  return {
    version: 1,
    vendor: "valibot",
    validate(value$1) {
      return context["~run"]({ value: value$1 }, /* @__PURE__ */ getGlobalConfig());
    }
  };
}
__name(_getStandardProps, "_getStandardProps");
// @__NO_SIDE_EFFECTS__
function _isValidObjectKey(object$1, key) {
  return Object.hasOwn(object$1, key) && key !== "__proto__" && key !== "prototype" && key !== "constructor";
}
__name(_isValidObjectKey, "_isValidObjectKey");
// @__NO_SIDE_EFFECTS__
function _joinExpects(values$1, separator) {
  const list = [...new Set(values$1)];
  if (list.length > 1) return `(${list.join(` ${separator} `)})`;
  return list[0] ?? "never";
}
__name(_joinExpects, "_joinExpects");
// @__NO_SIDE_EFFECTS__
function integer(message$1) {
  return {
    kind: "validation",
    type: "integer",
    reference: integer,
    async: false,
    expects: null,
    requirement: Number.isInteger,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && !this.requirement(dataset.value)) _addIssue(this, "integer", dataset, config$1);
      return dataset;
    }
  };
}
__name(integer, "integer");
// @__NO_SIDE_EFFECTS__
function length(requirement, message$1) {
  return {
    kind: "validation",
    type: "length",
    reference: length,
    async: false,
    expects: `${requirement}`,
    requirement,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && dataset.value.length !== this.requirement) _addIssue(this, "length", dataset, config$1, { received: `${dataset.value.length}` });
      return dataset;
    }
  };
}
__name(length, "length");
// @__NO_SIDE_EFFECTS__
function minLength(requirement, message$1) {
  return {
    kind: "validation",
    type: "min_length",
    reference: minLength,
    async: false,
    expects: `>=${requirement}`,
    requirement,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && dataset.value.length < this.requirement) _addIssue(this, "length", dataset, config$1, { received: `${dataset.value.length}` });
      return dataset;
    }
  };
}
__name(minLength, "minLength");
// @__NO_SIDE_EFFECTS__
function minValue(requirement, message$1) {
  return {
    kind: "validation",
    type: "min_value",
    reference: minValue,
    async: false,
    expects: `>=${requirement instanceof Date ? requirement.toJSON() : /* @__PURE__ */ _stringify(requirement)}`,
    requirement,
    message: message$1,
    "~run"(dataset, config$1) {
      if (dataset.typed && !(dataset.value >= this.requirement)) _addIssue(this, "value", dataset, config$1, { received: dataset.value instanceof Date ? dataset.value.toJSON() : /* @__PURE__ */ _stringify(dataset.value) });
      return dataset;
    }
  };
}
__name(minValue, "minValue");
// @__NO_SIDE_EFFECTS__
function getFallback(schema, dataset, config$1) {
  return typeof schema.fallback === "function" ? schema.fallback(dataset, config$1) : schema.fallback;
}
__name(getFallback, "getFallback");
// @__NO_SIDE_EFFECTS__
function getDefault(schema, dataset, config$1) {
  return typeof schema.default === "function" ? schema.default(dataset, config$1) : schema.default;
}
__name(getDefault, "getDefault");
// @__NO_SIDE_EFFECTS__
function literal(literal_, message$1) {
  return {
    kind: "schema",
    type: "literal",
    reference: literal,
    expects: /* @__PURE__ */ _stringify(literal_),
    async: false,
    literal: literal_,
    message: message$1,
    get "~standard"() {
      return /* @__PURE__ */ _getStandardProps(this);
    },
    "~run"(dataset, config$1) {
      if (dataset.value === this.literal) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  };
}
__name(literal, "literal");
// @__NO_SIDE_EFFECTS__
function nullable(wrapped, default_) {
  return {
    kind: "schema",
    type: "nullable",
    reference: nullable,
    expects: `(${wrapped.expects} | null)`,
    async: false,
    wrapped,
    default: default_,
    get "~standard"() {
      return /* @__PURE__ */ _getStandardProps(this);
    },
    "~run"(dataset, config$1) {
      if (dataset.value === null) {
        if (this.default !== void 0) dataset.value = /* @__PURE__ */ getDefault(this, dataset, config$1);
        if (dataset.value === null) {
          dataset.typed = true;
          return dataset;
        }
      }
      return this.wrapped["~run"](dataset, config$1);
    }
  };
}
__name(nullable, "nullable");
// @__NO_SIDE_EFFECTS__
function number(message$1) {
  return {
    kind: "schema",
    type: "number",
    reference: number,
    expects: "number",
    async: false,
    message: message$1,
    get "~standard"() {
      return /* @__PURE__ */ _getStandardProps(this);
    },
    "~run"(dataset, config$1) {
      if (typeof dataset.value === "number" && !isNaN(dataset.value)) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  };
}
__name(number, "number");
// @__NO_SIDE_EFFECTS__
function object(entries$1, message$1) {
  return {
    kind: "schema",
    type: "object",
    reference: object,
    expects: "Object",
    async: false,
    entries: entries$1,
    message: message$1,
    get "~standard"() {
      return /* @__PURE__ */ _getStandardProps(this);
    },
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (input && typeof input === "object") {
        dataset.typed = true;
        dataset.value = {};
        for (const key in this.entries) {
          const valueSchema = this.entries[key];
          if (key in input || (valueSchema.type === "exact_optional" || valueSchema.type === "optional" || valueSchema.type === "nullish") && valueSchema.default !== void 0) {
            const value$1 = key in input ? input[key] : /* @__PURE__ */ getDefault(valueSchema);
            const valueDataset = valueSchema["~run"]({ value: value$1 }, config$1);
            if (valueDataset.issues) {
              const pathItem = {
                type: "object",
                origin: "value",
                input,
                key,
                value: value$1
              };
              for (const issue of valueDataset.issues) {
                if (issue.path) issue.path.unshift(pathItem);
                else issue.path = [pathItem];
                dataset.issues?.push(issue);
              }
              if (!dataset.issues) dataset.issues = valueDataset.issues;
              if (config$1.abortEarly) {
                dataset.typed = false;
                break;
              }
            }
            if (!valueDataset.typed) dataset.typed = false;
            dataset.value[key] = valueDataset.value;
          } else if (valueSchema.fallback !== void 0) dataset.value[key] = /* @__PURE__ */ getFallback(valueSchema);
          else if (valueSchema.type !== "exact_optional" && valueSchema.type !== "optional" && valueSchema.type !== "nullish") {
            _addIssue(this, "key", dataset, config$1, {
              input: void 0,
              expected: `"${key}"`,
              path: [{
                type: "object",
                origin: "key",
                input,
                key,
                value: input[key]
              }]
            });
            if (config$1.abortEarly) break;
          }
        }
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  };
}
__name(object, "object");
// @__NO_SIDE_EFFECTS__
function picklist(options, message$1) {
  return {
    kind: "schema",
    type: "picklist",
    reference: picklist,
    expects: /* @__PURE__ */ _joinExpects(options.map(_stringify), "|"),
    async: false,
    options,
    message: message$1,
    get "~standard"() {
      return /* @__PURE__ */ _getStandardProps(this);
    },
    "~run"(dataset, config$1) {
      if (this.options.includes(dataset.value)) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  };
}
__name(picklist, "picklist");
// @__NO_SIDE_EFFECTS__
function record(key, value$1, message$1) {
  return {
    kind: "schema",
    type: "record",
    reference: record,
    expects: "Object",
    async: false,
    key,
    value: value$1,
    message: message$1,
    get "~standard"() {
      return /* @__PURE__ */ _getStandardProps(this);
    },
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (input && typeof input === "object") {
        dataset.typed = true;
        dataset.value = {};
        for (const entryKey in input) if (/* @__PURE__ */ _isValidObjectKey(input, entryKey)) {
          const entryValue = input[entryKey];
          const keyDataset = this.key["~run"]({ value: entryKey }, config$1);
          if (keyDataset.issues) {
            const pathItem = {
              type: "object",
              origin: "key",
              input,
              key: entryKey,
              value: entryValue
            };
            for (const issue of keyDataset.issues) {
              issue.path = [pathItem];
              dataset.issues?.push(issue);
            }
            if (!dataset.issues) dataset.issues = keyDataset.issues;
            if (config$1.abortEarly) {
              dataset.typed = false;
              break;
            }
          }
          const valueDataset = this.value["~run"]({ value: entryValue }, config$1);
          if (valueDataset.issues) {
            const pathItem = {
              type: "object",
              origin: "value",
              input,
              key: entryKey,
              value: entryValue
            };
            for (const issue of valueDataset.issues) {
              if (issue.path) issue.path.unshift(pathItem);
              else issue.path = [pathItem];
              dataset.issues?.push(issue);
            }
            if (!dataset.issues) dataset.issues = valueDataset.issues;
            if (config$1.abortEarly) {
              dataset.typed = false;
              break;
            }
          }
          if (!keyDataset.typed || !valueDataset.typed) dataset.typed = false;
          if (keyDataset.typed) dataset.value[keyDataset.value] = valueDataset.value;
        }
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  };
}
__name(record, "record");
// @__NO_SIDE_EFFECTS__
function string(message$1) {
  return {
    kind: "schema",
    type: "string",
    reference: string,
    expects: "string",
    async: false,
    message: message$1,
    get "~standard"() {
      return /* @__PURE__ */ _getStandardProps(this);
    },
    "~run"(dataset, config$1) {
      if (typeof dataset.value === "string") dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  };
}
__name(string, "string");
// @__NO_SIDE_EFFECTS__
function unknown() {
  return {
    kind: "schema",
    type: "unknown",
    reference: unknown,
    expects: "unknown",
    async: false,
    get "~standard"() {
      return /* @__PURE__ */ _getStandardProps(this);
    },
    "~run"(dataset) {
      dataset.typed = true;
      return dataset;
    }
  };
}
__name(unknown, "unknown");
// @__NO_SIDE_EFFECTS__
function pipe(...pipe$1) {
  return {
    ...pipe$1[0],
    pipe: pipe$1,
    get "~standard"() {
      return /* @__PURE__ */ _getStandardProps(this);
    },
    "~run"(dataset, config$1) {
      for (const item of pipe$1) if (item.kind !== "metadata") {
        if (dataset.issues && (item.kind === "schema" || item.kind === "transformation")) {
          dataset.typed = false;
          break;
        }
        if (!dataset.issues || !config$1.abortEarly && !config$1.abortPipeEarly) dataset = item["~run"](dataset, config$1);
      }
      return dataset;
    }
  };
}
__name(pipe, "pipe");

// ../../data-protocol/packages/core/dist/index.js
function createStarkeepId(value) {
  return value;
}
__name(createStarkeepId, "createStarkeepId");
var monotonic = monotonicFactory();
function createHLCClock(options) {
  const { nodeId, wallClockFunction = Date.now, initialState, onTick } = options;
  let lastWallTime = initialState?.wallTime ?? 0;
  let lastCounter = initialState?.counter ?? 0;
  function emit() {
    if (onTick) onTick({ wallTime: lastWallTime, counter: lastCounter });
  }
  __name(emit, "emit");
  function now() {
    const physicalTime = wallClockFunction();
    if (physicalTime > lastWallTime) {
      lastWallTime = physicalTime;
      lastCounter = 0;
    } else {
      lastCounter++;
    }
    emit();
    return { wallTime: lastWallTime, counter: lastCounter, nodeId };
  }
  __name(now, "now");
  function send() {
    return now();
  }
  __name(send, "send");
  function receive(remote) {
    const physicalTime = wallClockFunction();
    if (physicalTime > lastWallTime && physicalTime > remote.wallTime) {
      lastWallTime = physicalTime;
      lastCounter = 0;
    } else if (remote.wallTime > lastWallTime) {
      lastWallTime = remote.wallTime;
      lastCounter = remote.counter + 1;
    } else if (lastWallTime === remote.wallTime) {
      lastCounter = Math.max(lastCounter, remote.counter) + 1;
    } else {
      lastCounter++;
    }
    emit();
    return { wallTime: lastWallTime, counter: lastCounter, nodeId };
  }
  __name(receive, "receive");
  return { now, send, receive };
}
__name(createHLCClock, "createHLCClock");
var SEPARATOR = ":";
function serializeHLC(timestamp) {
  const wallTimeHex = timestamp.wallTime.toString(16).padStart(12, "0");
  const counterHex = timestamp.counter.toString(16).padStart(4, "0");
  return `${wallTimeHex}${SEPARATOR}${counterHex}${SEPARATOR}${timestamp.nodeId}`;
}
__name(serializeHLC, "serializeHLC");
function deserializeHLC(serializedString) {
  const parts = serializedString.split(SEPARATOR);
  if (parts.length !== 3) {
    throw new Error(`Invalid HLC timestamp string: ${serializedString}`);
  }
  return {
    wallTime: parseInt(parts[0], 16),
    counter: parseInt(parts[1], 16),
    nodeId: parts[2]
  };
}
__name(deserializeHLC, "deserializeHLC");
var hlcTimestampSchema = object({
  wallTime: pipe(number(), integer(), minValue(0)),
  counter: pipe(number(), integer(), minValue(0)),
  nodeId: pipe(string(), minLength(1))
});
var baseRecordSchema = object({
  id: pipe(string(), length(26)),
  type: pipe(string(), minLength(1)),
  createdAt: hlcTimestampSchema,
  updatedAt: hlcTimestampSchema,
  ownerId: pipe(string(), minLength(1)),
  syncStatus: picklist(["local", "synced", "pending_push", "pending_pull", "conflict"]),
  deletedAt: nullable(hlcTimestampSchema),
  version: pipe(number(), integer(), minValue(1))
});
var dataRecordSchema = object({
  ...baseRecordSchema.entries,
  kind: literal("data"),
  contentHash: nullable(string()),
  objectStorageKey: nullable(string()),
  mimeType: nullable(string()),
  sizeBytes: nullable(pipe(number(), integer(), minValue(0))),
  content: record(string(), unknown())
});
var metadataRecordSchema = object({
  targetId: pipe(string(), length(26)),
  generatorId: pipe(string(), minLength(1)),
  generatorVersion: pipe(number(), integer(), minValue(1)),
  inputHash: pipe(string(), minLength(1)),
  value: record(string(), unknown())
});
var StarkeepError = class extends Error {
  static {
    __name(this, "StarkeepError");
  }
  constructor(message, code, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "StarkeepError";
  }
};

// ../../data-protocol/packages/storage-adapter/dist/index.js
var StorageError = class extends StarkeepError {
  static {
    __name(this, "StorageError");
  }
  constructor(message, cause) {
    super(message, "STORAGE_ERROR", cause);
    this.name = "StorageError";
  }
};
var TransactionError = class extends StorageError {
  static {
    __name(this, "TransactionError");
  }
  constructor(message, cause) {
    super(message, cause);
    this.name = "TransactionError";
  }
};

// ../../data-protocol/packages/storage-aurora-dsql/dist/index.js
function recordToRow(record2) {
  return {
    id: record2.id,
    type: record2.type,
    created_at: serializeHLC(record2.createdAt),
    updated_at: serializeHLC(record2.updatedAt),
    owner_id: record2.ownerId,
    sync_status: record2.syncStatus,
    deleted_at: record2.deletedAt ? serializeHLC(record2.deletedAt) : null,
    version: record2.version,
    content: record2.content,
    content_hash: record2.contentHash,
    object_storage_key: record2.objectStorageKey,
    mime_type: record2.mimeType,
    size_bytes: record2.sizeBytes,
    original_filename: record2.originalFilename
  };
}
__name(recordToRow, "recordToRow");
function rowToRecord(row) {
  const content = typeof row.content === "string" ? JSON.parse(row.content) : row.content;
  return {
    id: createStarkeepId(row.id),
    kind: "data",
    type: row.type,
    createdAt: deserializeHLC(row.created_at),
    updatedAt: deserializeHLC(row.updated_at),
    ownerId: row.owner_id,
    syncStatus: row.sync_status,
    deletedAt: row.deleted_at ? deserializeHLC(row.deleted_at) : null,
    version: row.version,
    content,
    contentHash: row.content_hash,
    objectStorageKey: row.object_storage_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    originalFilename: row.original_filename
  };
}
__name(rowToRecord, "rowToRecord");
var FIELD_MAP = {
  id: "id",
  type: "type",
  createdAt: "created_at",
  updatedAt: "updated_at",
  ownerId: "owner_id",
  syncStatus: "sync_status",
  deletedAt: "deleted_at",
  version: "version",
  contentHash: "content_hash",
  objectStorageKey: "object_storage_key",
  mimeType: "mime_type",
  sizeBytes: "size_bytes"
};
function mapField(field, parameterIndex) {
  if (field.startsWith("content.")) {
    const jsonKey = field.slice("content.".length);
    return `(content::json)->>'${jsonKey}'`;
  }
  return FIELD_MAP[field] ?? field;
}
__name(mapField, "mapField");
function buildPostgresQuery(query) {
  const conditions = [];
  const values = [];
  let parameterIndex = 1;
  if (query.type) {
    conditions.push(`type = $${parameterIndex}`);
    values.push(query.type);
    parameterIndex++;
  }
  if (query.filters) {
    for (const filter of query.filters) {
      const column = mapField(filter.field, { value: parameterIndex });
      switch (filter.operator) {
        case "eq":
          conditions.push(`${column} = $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "neq":
          conditions.push(`${column} != $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "gt":
          conditions.push(`${column} > $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "gte":
          conditions.push(`${column} >= $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "lt":
          conditions.push(`${column} < $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "lte":
          conditions.push(`${column} <= $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "in": {
          const filterValues = filter.value;
          const placeholders = filterValues.map(() => {
            const placeholder = `$${parameterIndex}`;
            parameterIndex++;
            return placeholder;
          });
          conditions.push(`${column} IN (${placeholders.join(", ")})`);
          values.push(...filterValues);
          break;
        }
        case "like":
          conditions.push(`${column} LIKE $${parameterIndex}`);
          values.push(`%${filter.value}%`);
          parameterIndex++;
          break;
      }
    }
  }
  if (query.cursor) {
    conditions.push(`id > $${parameterIndex}`);
    values.push(query.cursor);
    parameterIndex++;
  }
  let text = "SELECT * FROM records";
  if (conditions.length > 0) {
    text += ` WHERE ${conditions.join(" AND ")}`;
  }
  if (query.sort && query.sort.length > 0) {
    const orderClauses = query.sort.map(
      (sortField) => `${mapField(sortField.field, { value: 0 })} ${sortField.direction === "desc" ? "DESC" : "ASC"}`
    );
    text += ` ORDER BY ${orderClauses.join(", ")}`;
  } else {
    text += " ORDER BY id ASC";
  }
  if (query.limit) {
    text += ` LIMIT $${parameterIndex}`;
    values.push(query.limit + 1);
    parameterIndex++;
  }
  return { text, values };
}
__name(buildPostgresQuery, "buildPostgresQuery");
function camelToSnake(s) {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase();
}
__name(camelToSnake, "camelToSnake");
function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
__name(snakeToCamel, "snakeToCamel");
function generatorIdToPrefix(generatorId) {
  return generatorId.replace(/^@/, "").replace(/[/:@\-]/g, "_").replace(/__+/g, "_").replace(/^_|_$/g, "");
}
__name(generatorIdToPrefix, "generatorIdToPrefix");
function metadataTableName(targetType) {
  const sanitized = targetType.replace(/^@/, "").replace(/[/:@\-]/g, "_").replace(/__+/g, "_").replace(/^_|_$/g, "");
  return `metadata_${sanitized}`;
}
__name(metadataTableName, "metadataTableName");
function buildPostgresMetadataQuery(targetType, query) {
  const table = metadataTableName(targetType);
  const conditions = [];
  const values = [];
  let parameterIndex = 1;
  if (query.targetId) {
    conditions.push(`target_id = $${parameterIndex}`);
    values.push(query.targetId);
    parameterIndex++;
  } else if (query.targetIds && query.targetIds.length > 0) {
    const placeholders = query.targetIds.map(() => {
      const p = `$${parameterIndex}`;
      parameterIndex++;
      return p;
    });
    conditions.push(`target_id IN (${placeholders.join(", ")})`);
    values.push(...query.targetIds);
  }
  if (query.filters) {
    for (const filter of query.filters) {
      const column = camelToSnake(filter.field);
      switch (filter.operator) {
        case "eq":
          conditions.push(`${column} = $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "neq":
          conditions.push(`${column} != $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "gt":
          conditions.push(`${column} > $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "gte":
          conditions.push(`${column} >= $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "lt":
          conditions.push(`${column} < $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "lte":
          conditions.push(`${column} <= $${parameterIndex}`);
          values.push(filter.value);
          parameterIndex++;
          break;
        case "in": {
          const filterValues = filter.value;
          const placeholders = filterValues.map(() => {
            const p = `$${parameterIndex}`;
            parameterIndex++;
            return p;
          });
          conditions.push(`${column} IN (${placeholders.join(", ")})`);
          values.push(...filterValues);
          break;
        }
        case "like":
          conditions.push(`${column} LIKE $${parameterIndex}`);
          values.push(`%${filter.value}%`);
          parameterIndex++;
          break;
      }
    }
  }
  let text = `SELECT * FROM ${table}`;
  if (conditions.length > 0) {
    text += ` WHERE ${conditions.join(" AND ")}`;
  }
  return { text, values };
}
__name(buildPostgresMetadataQuery, "buildPostgresMetadataQuery");
var CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS records (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    sync_status TEXT NOT NULL DEFAULT 'local',
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT,
    object_storage_key TEXT,
    mime_type TEXT,
    size_bytes INTEGER,
    original_filename TEXT
  )
`;
var CREATE_INDEXES_SQL = [
  "CREATE INDEX ASYNC IF NOT EXISTS idx_records_type ON records(type)",
  "CREATE INDEX ASYNC IF NOT EXISTS idx_records_sync_status ON records(sync_status)",
  "CREATE INDEX ASYNC IF NOT EXISTS idx_records_updated_at ON records(updated_at)"
];
var CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;
var CREATE_METADATA_SYNC_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS metadata_sync (
    target_id          TEXT NOT NULL,
    target_type        TEXT NOT NULL,
    generator_id       TEXT NOT NULL,
    generator_version  INTEGER NOT NULL,
    input_hash         TEXT,
    updated_at         TEXT NOT NULL,
    value              TEXT NOT NULL,
    object_storage_key TEXT,
    content_hash       TEXT,
    mime_type          TEXT,
    size_bytes         BIGINT,
    PRIMARY KEY (target_id, generator_id)
  )
`;
var CREATE_METADATA_SYNC_INDEX_SQL = "CREATE INDEX ASYNC IF NOT EXISTS idx_metadata_sync_updated_at ON metadata_sync(updated_at)";
var AuroraDsqlDatabaseAdapter = class {
  static {
    __name(this, "AuroraDsqlDatabaseAdapter");
  }
  client = null;
  options;
  clientFactory;
  metadataRegistry = /* @__PURE__ */ new Map();
  constructor(options, clientFactory) {
    this.options = options;
    this.clientFactory = clientFactory;
  }
  async init() {
    this.client = await this.clientFactory.createClient(this.options);
    await this.client.query(CREATE_TABLE_SQL);
    for (const sql of CREATE_INDEXES_SQL) {
      await this.client.query(sql);
    }
    await this.client.query(CREATE_MIGRATIONS_TABLE_SQL);
    await this.client.query(CREATE_METADATA_SYNC_TABLE_SQL);
    await this.client.query(CREATE_METADATA_SYNC_INDEX_SQL);
  }
  async close() {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
  async healthCheck() {
    if (!this.client) return false;
    try {
      await this.client.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
  getClient() {
    if (!this.client) {
      throw new StorageError("Database not initialized. Call init() first.");
    }
    return this.client;
  }
  async put(record2) {
    const row = recordToRow(record2);
    const columns = Object.keys(row);
    const values = Object.values(row).map(
      (value) => typeof value === "object" && value !== null ? JSON.stringify(value) : value
    );
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const updates = columns.filter((column) => column !== "id").map((column) => `${column} = EXCLUDED.${column}`).join(", ");
    const text = `INSERT INTO records (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT(id) DO UPDATE SET ${updates}`;
    await this.getClient().query(text, values);
  }
  async get(id) {
    const result = await this.getClient().query(
      "SELECT * FROM records WHERE id = $1",
      [id]
    );
    if (result.rows.length === 0) return null;
    return rowToRecord(result.rows[0]);
  }
  async delete(id) {
    await this.getClient().query("DELETE FROM records WHERE id = $1", [id]);
  }
  async query(query) {
    const { text, values } = buildPostgresQuery(query);
    const result = await this.getClient().query(text, values);
    const rows = result.rows;
    const limit = query.limit;
    const hasMore = limit ? rows.length > limit : false;
    const resultRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      records: resultRows.map(rowToRecord),
      nextCursor: hasMore ? resultRows[resultRows.length - 1].id : null,
      hasMore
    };
  }
  async batch(operations) {
    await this.getClient().query("BEGIN");
    try {
      for (const operation of operations) {
        if (operation.type === "put") {
          await this.put(operation.record);
        } else {
          await this.delete(operation.id);
        }
      }
      await this.getClient().query("COMMIT");
    } catch (error) {
      await this.getClient().query("ROLLBACK");
      throw error;
    }
  }
  async transaction(callback) {
    await this.getClient().query("SAVEPOINT starkeep_transaction");
    try {
      const transaction = {
        put: /* @__PURE__ */ __name(async (record2) => this.put(record2), "put"),
        get: /* @__PURE__ */ __name(async (id) => this.get(id), "get"),
        delete: /* @__PURE__ */ __name(async (id) => this.delete(id), "delete"),
        query: /* @__PURE__ */ __name(async (query) => this.query(query), "query")
      };
      const result = await callback(transaction);
      await this.getClient().query("RELEASE SAVEPOINT starkeep_transaction");
      return result;
    } catch (error) {
      await this.getClient().query(
        "ROLLBACK TO SAVEPOINT starkeep_transaction"
      );
      await this.getClient().query("RELEASE SAVEPOINT starkeep_transaction");
      throw new TransactionError("Transaction failed", error);
    }
  }
  async runMigrations(migrations) {
    const applied = await this.getClient().query(
      "SELECT version FROM migrations ORDER BY version"
    );
    const appliedVersions = new Set(
      applied.rows.map((record2) => record2.version)
    );
    const pending = migrations.filter((migration) => !appliedVersions.has(migration.version)).sort((a, b) => a.version - b.version);
    for (const migration of pending) {
      await this.getClient().query("BEGIN");
      try {
        const transaction = {
          put: /* @__PURE__ */ __name(async (record2) => this.put(record2), "put"),
          get: /* @__PURE__ */ __name(async (id) => this.get(id), "get"),
          delete: /* @__PURE__ */ __name(async (id) => this.delete(id), "delete"),
          query: /* @__PURE__ */ __name(async (query) => this.query(query), "query")
        };
        await migration.up(transaction);
        await this.getClient().query(
          "INSERT INTO migrations (version, name) VALUES ($1, $2)",
          [migration.version, migration.name]
        );
        await this.getClient().query("COMMIT");
      } catch (error) {
        await this.getClient().query("ROLLBACK");
        throw new StorageError(
          `Migration ${migration.version} (${migration.name}) failed`,
          error
        );
      }
    }
  }
  // ---------------------------------------------------------------------------
  // Per-type metadata table methods
  // ---------------------------------------------------------------------------
  async ensureMetadataTable(targetType, generatorId, columns) {
    const table = metadataTableName(targetType);
    const prefix = generatorIdToPrefix(generatorId);
    await this.getClient().query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        target_id TEXT PRIMARY KEY
      )
    `);
    const postgresColumnType = /* @__PURE__ */ __name((col) => {
      switch (col.columnType) {
        case "integer":
          return "INTEGER";
        case "real":
          return "DOUBLE PRECISION";
        case "boolean":
          return "BOOLEAN";
        default:
          return "TEXT";
      }
    }, "postgresColumnType");
    for (const col of columns) {
      try {
        await this.getClient().query(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.name} ${postgresColumnType(col)}`
        );
      } catch {
      }
    }
    for (const [colName, colType] of [
      [`${prefix}_input_hash`, "TEXT"],
      [`${prefix}_generator_version`, "INTEGER"]
    ]) {
      try {
        await this.getClient().query(
          `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${colName} ${colType}`
        );
      } catch {
      }
    }
    for (const col of columns) {
      if (col.columnType !== "boolean") {
        try {
          await this.getClient().query(
            `CREATE INDEX ASYNC IF NOT EXISTS idx_${table}_${col.name} ON ${table}(${col.name})`
          );
        } catch {
        }
      }
    }
    const existing = this.metadataRegistry.get(targetType) ?? [];
    if (!existing.some((e) => e.generatorId === generatorId)) {
      existing.push({ generatorId, columns });
      this.metadataRegistry.set(targetType, existing);
    }
  }
  async putMetadata(targetType, entry) {
    const table = metadataTableName(targetType);
    const prefix = generatorIdToPrefix(entry.generatorId);
    const registered = this.metadataRegistry.get(targetType);
    const generatorEntry = registered?.find((e) => e.generatorId === entry.generatorId);
    if (!generatorEntry) {
      throw new StorageError(
        `Metadata table for type "${targetType}" / generator "${entry.generatorId}" not registered. Call ensureMetadataTable first.`
      );
    }
    const columnNames = ["target_id"];
    const values = [entry.targetId];
    let idx = 2;
    for (const col of generatorEntry.columns) {
      columnNames.push(col.name);
      const camelKey = snakeToCamel(col.name);
      values.push(entry.value[camelKey] ?? null);
      idx++;
    }
    columnNames.push(`${prefix}_input_hash`, `${prefix}_generator_version`);
    values.push(entry.inputHash, entry.generatorVersion);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
    const updateCols = columnNames.filter((c) => c !== "target_id");
    const updates = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(", ");
    const text = `INSERT INTO ${table} (${columnNames.join(", ")}) VALUES (${placeholders}) ON CONFLICT(target_id) DO UPDATE SET ${updates}`;
    await this.getClient().query(text, values);
  }
  async queryMetadata(targetType, query) {
    const registered = this.metadataRegistry.get(targetType) ?? [];
    const { text, values } = buildPostgresMetadataQuery(targetType, query);
    const result = await this.getClient().query(text, values);
    const rows = result.rows;
    const entries = [];
    for (const row of rows) {
      const targetId = createStarkeepId(row["target_id"]);
      const generatorsToReturn = query.generatorId ? registered.filter((g) => g.generatorId === query.generatorId) : registered;
      for (const gen of generatorsToReturn) {
        const prefix = generatorIdToPrefix(gen.generatorId);
        const inputHash = row[`${prefix}_input_hash`];
        const generatorVersion = row[`${prefix}_generator_version`];
        if (generatorVersion === null) continue;
        const value = {};
        for (const col of gen.columns) {
          const camelKey = snakeToCamel(col.name);
          value[camelKey] = row[col.name] ?? null;
        }
        entries.push({
          targetId,
          generatorId: gen.generatorId,
          generatorVersion,
          inputHash: inputHash ?? "",
          value
        });
      }
    }
    return { entries };
  }
  async upsertSyncableMetadata(record2) {
    await this.getClient().query(
      `INSERT INTO metadata_sync
         (target_id, target_type, generator_id, generator_version, input_hash, updated_at, value,
          object_storage_key, content_hash, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (target_id, generator_id) DO UPDATE SET
         target_type        = EXCLUDED.target_type,
         generator_version  = EXCLUDED.generator_version,
         input_hash         = EXCLUDED.input_hash,
         updated_at         = EXCLUDED.updated_at,
         value              = EXCLUDED.value,
         object_storage_key = EXCLUDED.object_storage_key,
         content_hash       = EXCLUDED.content_hash,
         mime_type          = EXCLUDED.mime_type,
         size_bytes         = EXCLUDED.size_bytes`,
      [
        record2.targetId,
        record2.targetType,
        record2.generatorId,
        record2.generatorVersion,
        record2.inputHash ?? null,
        serializeHLC(record2.updatedAt),
        JSON.stringify(record2.value),
        record2.objectStorageKey ?? null,
        record2.contentHash ?? null,
        record2.mimeType ?? null,
        record2.sizeBytes ?? null
      ]
    );
    const registered = this.metadataRegistry.get(record2.targetType);
    const generatorEntry = registered?.find((e) => e.generatorId === record2.generatorId);
    if (generatorEntry) {
      await this.putMetadata(record2.targetType, {
        targetId: record2.targetId,
        generatorId: record2.generatorId,
        generatorVersion: record2.generatorVersion,
        inputHash: record2.inputHash ?? "",
        value: record2.value
      });
    }
  }
  async getMetadataForRecord(targetId) {
    const result = await this.getClient().query(
      "SELECT generator_id, generator_version, value, updated_at, object_storage_key, mime_type FROM metadata_sync WHERE target_id = $1 ORDER BY updated_at DESC",
      [targetId]
    );
    return result.rows.map((row) => ({
      generatorId: row.generator_id,
      generatorVersion: row.generator_version,
      value: JSON.parse(row.value),
      updatedAt: row.updated_at,
      objectStorageKey: row.object_storage_key ?? null,
      mimeType: row.mime_type ?? null
    }));
  }
  async getSyncableMetadataChangesSince(since) {
    const sinceStr = serializeHLC(since);
    const result = await this.getClient().query(
      "SELECT * FROM metadata_sync WHERE updated_at > $1 ORDER BY updated_at ASC",
      [sinceStr]
    );
    return result.rows.map((row) => ({
      targetId: createStarkeepId(row.target_id),
      targetType: row.target_type,
      generatorId: row.generator_id,
      generatorVersion: row.generator_version,
      inputHash: row.input_hash,
      updatedAt: deserializeHLC(row.updated_at),
      value: JSON.parse(row.value),
      objectStorageKey: row.object_storage_key ?? null,
      contentHash: row.content_hash ?? null,
      mimeType: row.mime_type ?? null,
      sizeBytes: row.size_bytes ?? null
    }));
  }
};

// ../../data-protocol/packages/storage-s3/dist/index.js
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  HeadObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
var MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;
var S3ObjectStorageAdapter = class {
  static {
    __name(this, "S3ObjectStorageAdapter");
  }
  options;
  client = null;
  constructor(options) {
    this.options = options;
  }
  getClient() {
    if (!this.client) {
      this.client = new S3Client({
        region: this.options.region,
        // When credentialProvider is set, pass it directly to the AWS SDK.
        // The SDK calls it before each signed request, so STS credentials
        // (e.g. from a Cognito Identity Pool) are always fresh.
        credentials: this.options.credentialProvider ? this.options.credentialProvider : this.options.credentials
      });
    }
    return this.client;
  }
  resolveKey(key) {
    return `${this.options.keyPrefix ?? ""}${key}`;
  }
  async init() {
  }
  async close() {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }
  async healthCheck() {
    try {
      await this.getClient().send(
        new HeadBucketCommand({ Bucket: this.options.bucketName })
      );
      return true;
    } catch {
      return false;
    }
  }
  async put(key, data, options) {
    const resolvedKey = this.resolveKey(key);
    const contentType = options?.contentType;
    if (data.byteLength > MULTIPART_THRESHOLD_BYTES) {
      const upload = new Upload({
        client: this.getClient(),
        params: {
          Bucket: this.options.bucketName,
          Key: resolvedKey,
          Body: data,
          ...contentType ? { ContentType: contentType } : {}
        }
      });
      await upload.done();
    } else {
      await this.getClient().send(
        new PutObjectCommand({
          Bucket: this.options.bucketName,
          Key: resolvedKey,
          Body: data,
          ...contentType ? { ContentType: contentType } : {}
        })
      );
    }
  }
  async get(key) {
    try {
      const response = await this.getClient().send(
        new GetObjectCommand({
          Bucket: this.options.bucketName,
          Key: this.resolveKey(key)
        })
      );
      if (!response.Body) {
        return null;
      }
      const byteArray = await response.Body.transformToByteArray();
      const buffer = Buffer.from(byteArray);
      return {
        data: buffer,
        contentType: response.ContentType,
        size: buffer.length
      };
    } catch (error) {
      if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound")) {
        return null;
      }
      throw error;
    }
  }
  async has(key) {
    try {
      await this.getClient().send(
        new HeadObjectCommand({
          Bucket: this.options.bucketName,
          Key: this.resolveKey(key)
        })
      );
      return true;
    } catch (error) {
      if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound")) {
        return false;
      }
      throw error;
    }
  }
  async delete(key) {
    await this.getClient().send(
      new DeleteObjectCommand({
        Bucket: this.options.bucketName,
        Key: this.resolveKey(key)
      })
    );
  }
  async list(prefix, options) {
    const resolvedPrefix = this.resolveKey(prefix);
    const prefixOffset = (this.options.keyPrefix ?? "").length;
    const response = await this.getClient().send(
      new ListObjectsV2Command({
        Bucket: this.options.bucketName,
        Prefix: resolvedPrefix,
        MaxKeys: options?.limit,
        ContinuationToken: options?.cursor ?? void 0
      })
    );
    const keys = (response.Contents ?? []).map(
      (object2) => (object2.Key ?? "").slice(prefixOffset)
    );
    return {
      keys,
      nextCursor: response.NextContinuationToken ?? null,
      hasMore: response.IsTruncated ?? false
    };
  }
  async getSignedUrl(key, options) {
    const expiresInSeconds = options?.expiresIn ?? 3600;
    const command = new GetObjectCommand({
      Bucket: this.options.bucketName,
      Key: this.resolveKey(key)
    });
    return awsGetSignedUrl(this.getClient(), command, {
      expiresIn: expiresInSeconds
    });
  }
  async getSignedPutUrl(key, options) {
    const expiresInSeconds = options?.expiresIn ?? 3600;
    const command = new PutObjectCommand({
      Bucket: this.options.bucketName,
      Key: this.resolveKey(key),
      ...options?.contentType ? { ContentType: options.contentType } : {}
    });
    return awsGetSignedUrl(this.getClient(), command, {
      expiresIn: expiresInSeconds
    });
  }
};

// src/handler-utils.ts
function ok(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}
__name(ok, "ok");
function clientErr(message, status) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message })
  };
}
__name(clientErr, "clientErr");

// src/photos-handler.ts
var LambdaDsqlClientFactory = class {
  static {
    __name(this, "LambdaDsqlClientFactory");
  }
  async createClient(options) {
    const { hostname, region } = options;
    const createPgClient = /* @__PURE__ */ __name(async () => {
      const signer = new DsqlSigner({ hostname, region });
      const token = await signer.getDbConnectAdminAuthToken();
      const client = new pg.Client({
        host: hostname,
        port: 5432,
        database: options.database ?? "postgres",
        user: "admin",
        password: token,
        ssl: { rejectUnauthorized: true }
      });
      await client.connect();
      return client;
    }, "createPgClient");
    let inner = await createPgClient();
    return {
      async query(text, values) {
        try {
          const result = await inner.query(text, values);
          return { rows: result.rows };
        } catch (err) {
          const code = err?.code;
          if (code === "28000" || code === "28P01") {
            await inner.end().catch(() => {
            });
            inner = await createPgClient();
            const result = await inner.query(text, values);
            return { rows: result.rows };
          }
          throw err;
        }
      },
      async end() {
        await inner.end();
      }
    };
  }
};
var adapters = null;
async function getAdapters() {
  if (adapters) return adapters;
  const region = process.env.AWS_REGION ?? "us-east-1";
  const auroraEndpoint = process.env.AURORA_ENDPOINT;
  const s3Bucket = process.env.S3_BUCKET;
  if (!auroraEndpoint) throw new Error("AURORA_ENDPOINT env var is required");
  if (!s3Bucket) throw new Error("S3_BUCKET env var is required");
  const db = new AuroraDsqlDatabaseAdapter(
    { hostname: auroraEndpoint, region },
    new LambdaDsqlClientFactory()
  );
  await db.init();
  const storage = new S3ObjectStorageAdapter({ bucketName: s3Bucket, region });
  const clock = createHLCClock({ nodeId: "cloud-photos-api", wallClockFunction: Date.now });
  adapters = { db, storage, clock };
  return adapters;
}
__name(getAdapters, "getAdapters");
async function handler(event) {
  try {
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.rawPath;
    if (method === "OPTIONS") {
      return { statusCode: 200, body: "" };
    }
    if (method === "POST" && path === "/data/generate") {
      const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : event.body ?? "{}";
      const body = JSON.parse(rawBody);
      if (!body.targetId || !body.generatorId) {
        return clientErr("targetId and generatorId are required", 400);
      }
      const { db, storage, clock } = await getAdapters();
      const record2 = await db.get(body.targetId);
      if (!record2) return clientErr("Record not found", 404);
      if (!record2.objectStorageKey) return clientErr("Record has no attached file", 422);
      const downsizeMatch = body.generatorId.match(/^@starkeep\/image:downsize-(\d+)$/);
      if (!downsizeMatch) return clientErr(`Unsupported generatorId: ${body.generatorId}`, 400);
      const maxDimension = parseInt(downsizeMatch[1], 10);
      const sourceResult = await storage.get(record2.objectStorageKey);
      if (!sourceResult) return clientErr("Source image not found in storage", 404);
      const { default: sharp } = await import("sharp");
      const inputBuffer = Buffer.from(
        sourceResult.data instanceof Uint8Array ? sourceResult.data : new Uint8Array(sourceResult.data)
      );
      const meta = await sharp(inputBuffer).metadata();
      const hasAlpha = meta.hasAlpha ?? false;
      const resized = await sharp(inputBuffer).resize(maxDimension, maxDimension, { fit: "inside", kernel: "cubic", withoutEnlargement: true })[hasAlpha ? "webp" : "jpeg"](hasAlpha ? { quality: 76 } : { quality: 85 }).toBuffer();
      const outputMeta = await sharp(resized).metadata();
      const format = hasAlpha ? "webp" : "jpeg";
      const mimeType = hasAlpha ? "image/webp" : "image/jpeg";
      const hash = createHash("sha256").update(new Uint8Array(resized)).digest("hex");
      const thumbnailKey = `metadata/${hash}`;
      await storage.put(thumbnailKey, resized, { contentType: mimeType });
      const now = clock.now();
      const metadataRecord = {
        targetId: body.targetId,
        targetType: record2.type,
        generatorId: body.generatorId,
        generatorVersion: 1,
        inputHash: null,
        updatedAt: now,
        value: {
          downsizeWidth: outputMeta.width ?? 0,
          downsizeHeight: outputMeta.height ?? 0,
          downsizeFormat: format
        },
        objectStorageKey: thumbnailKey,
        contentHash: hash,
        mimeType,
        sizeBytes: resized.length
      };
      await db.upsertSyncableMetadata(metadataRecord);
      return ok({ ok: true, metadata: metadataRecord });
    }
    return clientErr("Not found", 404);
  } catch (e) {
    console.error("Photos handler error:", e);
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Internal server error" }) };
  }
}
__name(handler, "handler");
export {
  handler
};
//# sourceMappingURL=bundle.mjs.map
