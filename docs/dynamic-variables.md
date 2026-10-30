# Dynamic variables

Use `{{$randomFirstName}}` and the other catalog names in request templates.
Scripts use `pm.variables.replaceIn('{{$randomFirstName}}')`. Each occurrence
produces a fresh value, and a user variable with the same name takes precedence.
Unknown or incorrectly capitalized names stay unresolved.

The [versioned support manifest](../src/core/variables/dynamic-catalog.json)
records all 118 identifiers in the
[Postman v12 reference](https://learning.postman.com/latest-v-12/docs/tests-and-scripts/write-scripts/variables-list),
reviewed on October 30, 2026, with their output shapes. `$randomUUID` is an alias
for the UUID v4 generator used by `$guid`; it generates a fresh UUID on every
call. `$randomHexadecimal` (one lowercase hex digit) and `$randomPort` (1024 to
65535 inclusive) remain supported as Postbox extensions.

The editor uses the same catalog for completion, highlighting and hover help.
The generator implementation stays on the execution side. Request interpolation,
CLI execution, collection runs and sandbox replacement all use this registry.

Values are synthetic test data generated with Faker's English locale, not
production credentials. `$randomPassword` is a 15-character alphanumeric fixture.
Faker 10.6 requires Node 20.19+, 22.13+, 23.5+, or 24+; `package.json` declares
those supported version ranges. Containers and the portable package use Node 22.

`$timestamp` is Unix time in seconds and `$isoTimestamp` is UTC ISO 8601.
The three random date variables return JavaScript date strings in the execution
host's timezone. Future and past dates use a one-year window; recent dates use
seven days. Prices have two decimal places and range from 0.00 to 1000.00.
Phone numbers contain ten digits, or twelve digits for the extension variant.
Bank accounts have eight digits, and credit card masks contain four digits.

Image variables generate URL strings without fetching them. Category images
retain the reference's legacy `lorempixel.com/640/480/<category>` path shape;
those external endpoints are not guaranteed to serve an image. The data URI
variable produces an encoded SVG placeholder without external requests.

For deterministic fixtures, `createDynamicVariables({ seed, now })` creates an
independent generator and reference clock. Sequences are reproducible for the
locked Faker version; upgrading Faker can change generated fixture values.
