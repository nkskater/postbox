/** Only the closed generator surface used by postman-collection's dynamic variable catalog. */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- The SDK synchronously requires a CommonJS locale object.
const { faker: f } = require("@postbox/faker-modern/locale/en");
const take = (source, names) =>
  Object.fromEntries(
    names.split(" ").map((name) => {
      if (typeof source[name] !== "function") throw new Error(`Missing patched Faker generator: ${name}`);
      return [name, (...args) => source[name](...args)];
    }),
  );
const digits = (length) => f.string.numeric({ length, allowLeadingZeros: true });
const image =
  (category = "") =>
  (width = 640, height = 480) =>
    `http://lorempixel.com/${width}/${height}${category ? `/${category}` : ""}?${f.number.int({ min: 0, max: 1000000 })}`;
const legacy = {
  address: {
    ...take(f.location, "city country countryCode latitude longitude streetAddress"),
    streetName: () => f.location.street(),
  },
  commerce: {
    ...take(f.commerce, "department product productAdjective productMaterial productName"),
    color: () => f.color.human(),
  },
  company: {
    ...take(f.company, "catchPhrase catchPhraseAdjective catchPhraseDescriptor catchPhraseNoun"),
    companyName: () => f.company.name(),
    companySuffix: () => f.helpers.arrayElement(["Inc", "LLC", "Group"]),
    bs: () => f.company.buzzPhrase(),
    bsAdjective: () => f.company.buzzAdjective(),
    bsBuzz: () => f.company.buzzVerb(),
    bsNoun: () => f.company.buzzNoun(),
  },
  database: take(f.database, "collation column engine type"),
  datatype: {
    boolean: () => f.datatype.boolean(),
    number: (options) => f.number.int(options),
    uuid: () => f.string.uuid(),
  },
  date: {
    ...take(f.date, "month weekday"),
    past: (years = 1, refDate) => f.date.past({ years, refDate }),
    future: (years = 1, refDate) => f.date.future({ years, refDate }),
    recent: (days = 1, refDate) => f.date.recent({ days, refDate }),
  },
  finance: {
    ...take(
      f.finance,
      "accountName amount bic bitcoinAddress currencyCode currencyName currencySymbol iban transactionType",
    ),
    account: (length = 8) => f.finance.accountNumber({ length }),
    mask: (length = 4) => digits(length),
  },
  hacker: take(f.hacker, "abbreviation adjective ingverb noun phrase verb"),
  image: {
    ...Object.fromEntries(
      [
        "abstract",
        "animals",
        "business",
        "cats",
        "city",
        "fashion",
        "food",
        "nature",
        "nightlife",
        "people",
        "sports",
        "transport",
      ].map((name) => [name, image(name)]),
    ),
    imageUrl: image(),
    dataUri: () => f.image.dataUri(),
  },
  internet: {
    ...take(f.internet, "domainName domainSuffix domainWord email exampleEmail mac protocol url userAgent"),
    ip: () => f.internet.ipv4(),
    ipv6: () => f.internet.ipv6(),
    userName: () => f.internet.username(),
    color: () => f.color.rgb({ format: "hex", casing: "lower" }),
    password: () => f.string.alphanumeric(15),
  },
  lorem: take(f.lorem, "lines paragraph paragraphs sentence sentences slug text word words"),
  name: {
    ...take(f.person, "firstName jobArea jobDescriptor jobTitle jobType lastName prefix suffix"),
    findName: () => f.person.fullName(),
  },
  phone: {
    phoneNumber: () => `${digits(3)}-${digits(3)}-${digits(4)}`,
    phoneNumberFormat: () => `${digits(3)}-${digits(3)}-${digits(4)}`,
  },
  random: {
    alphaNumeric: () => f.string.alphanumeric(1),
    arrayElement: (values) => f.helpers.arrayElement(values),
    word: () => f.word.sample(),
  },
  system: take(
    f.system,
    "commonFileExt commonFileName commonFileType fileExt fileName fileType mimeType semver",
  ),
};
for (const namespace of Object.values(legacy)) Object.freeze(namespace);
module.exports = Object.freeze(legacy);
