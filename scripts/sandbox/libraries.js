import chai from "chai";
import chaiPostman from "chai-postman";
import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Buffer } from "buffer";
import sdk from "postman-collection";
import lodash from "lodash";

const { Response } = sdk;
chai.use(chaiPostman(sdk, lodash, Ajv));
chai.Assertion.addMethod("jsonSchema", function (schema, options = {}) {
  if (typeof schema !== "boolean" && (!schema || typeof schema !== "object" || Array.isArray(schema)))
    throw new Error("JSON schema must be an object or boolean");
  if (schema.$async || options.loadSchema) throw new Error("Asynchronous JSON schemas are not supported");
  const draft = schema.$schema || "http://json-schema.org/draft-07/schema#";
  const Validator = /2019-09/.test(draft) ? Ajv2019 : /2020-12/.test(draft) ? Ajv2020 : Ajv;
  const validator = new Validator({
    ...options,
    allErrors: true,
    logger: false,
    strictSchema: true,
    strictTypes: false,
    strictTuples: false,
  });
  addFormats(validator);
  const data = Response.isResponse(this._obj) ? this._obj.json() : this._obj;
  const valid = validator.validate(schema, data);
  this.assert(
    valid,
    `expected data to satisfy schema: ${validator.errorsText()}`,
    "expected data not to satisfy schema",
  );
});
globalThis.__sandboxLibraries = { chai, sdk, Buffer };
