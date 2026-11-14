import chai from "chai";
import chaiPostman from "chai-postman";
// The plugin enumerates two fixed reason maps at installation time.
const forOwn = (object, iteratee) => Object.keys(object).forEach((key) => iteratee(object[key], key, object));
// Chai installs the response assertions without loading the SDK or validator.
const sdk = new Proxy({}, { get: (_, key) => __loadApproved("postman-collection")[key] });
const lodash = new Proxy(
  {},
  { get: (_, key) => (key === "forOwn" ? forOwn : __loadApproved("lodash")[key]) },
);
const Ajv = function (...args) {
  return new (__loadApproved("ajv"))(...args);
};
chai.use(chaiPostman(sdk, lodash, Ajv));
chai.Assertion.addMethod("jsonSchema", function (schema, options = {}) {
  return __loadApproved("schema").assertSchema.call(this, schema, options);
});
export { chai };
